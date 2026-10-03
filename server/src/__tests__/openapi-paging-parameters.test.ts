import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..");

const spec = buildOpenApiSpec();

function queryParameters(specPath: string): Record<string, any> {
  const operation = spec.paths?.[specPath]?.get;
  if (!operation) throw new Error(`No GET operation documented for ${specPath}`);
  const entries = (operation.parameters ?? []).filter(
    (parameter: any) => parameter.in === "query",
  );
  return Object.fromEntries(entries.map((p: any) => [p.name, p]));
}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), "utf8");
}

/**
 * The route surface where a collection is paged, and the kind of bound each
 * limit-like parameter really applies.
 *
 * `boundKind` is the load-bearing column:
 *
 *   "clamping"  the handler moves an out-of-range value into range and answers
 *               200. A published `maximum` would advertise a 400 that does not
 *               exist, so the schema must carry the type WITHOUT a maximum and
 *               the operation description must carry the clamp.
 *   "rejecting" the handler answers 400, so the range is a real refusal and
 *               belongs in the schema.
 *
 * `boundSource` pins the expression that makes `boundKind` true. If somebody
 * converts a clamp into a rejection (or the reverse), that pin fails and the
 * published contract has to be revisited in the same change — the spec cannot
 * silently keep describing the old behaviour.
 */
const PAGED_ROUTES: {
  specPath: string;
  pagingKeys: string[];
  allKeys: string[];
  boundKind: "clamping" | "rejecting";
  boundSource: { file: string; expression: string };
}[] = [
  {
    specPath: "/api/companies/{companyId}/issues",
    pagingKeys: ["limit", "offset", "afterId"],
    allKeys: [
      "afterId", "assigneeAgentId", "assigneeUserId", "attention",
      "createdFromIssueId", "descendantOf", "excludeRoutineExecutions",
      "executionWorkspaceId", "hasPlanDocument", "inboxArchivedByUserId",
      "includeBlockedBy", "includeBlockedInboxAttention",
      "includeLiveDescendantSummary", "includePluginOperations",
      "includeRoutineExecutions", "labelId", "limit", "offset", "originId",
      "originKind", "originKindPrefix", "parentId", "parentIssueId",
      "participantAgentId", "projectId", "q", "sortDir", "sortField", "status",
      "touchedByUserId", "unreadForUserId", "updatedSince", "view",
      "workspaceId",
    ],
    boundKind: "clamping",
    boundSource: {
      file: "services/issues.ts",
      expression: "Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)))",
    },
  },
  {
    specPath: "/api/companies/{companyId}/activity",
    pagingKeys: ["limit"],
    allKeys: ["agentId", "entityId", "entityType", "limit"],
    boundKind: "clamping",
    boundSource: {
      file: "services/activity.ts",
      expression: "Math.max(1, Math.min(MAX_ACTIVITY_LIMIT",
    },
  },
  {
    specPath: "/api/companies/{companyId}/heartbeat-runs",
    pagingKeys: ["limit"],
    allKeys: ["agentId", "limit", "summary"],
    boundKind: "clamping",
    boundSource: {
      file: "routes/agents.ts",
      expression: "Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200))",
    },
  },
  {
    specPath: "/api/companies/{companyId}/live-runs",
    pagingKeys: ["limit", "minCount"],
    allKeys: ["distinctTasks", "limit", "minCount"],
    boundKind: "clamping",
    boundSource: {
      file: "routes/agents.ts",
      expression: "return Math.min(max, Math.trunc(parsed));",
    },
  },
  {
    specPath: "/api/heartbeat-runs/{runId}/events",
    pagingKeys: ["limit", "afterSeq"],
    allKeys: ["afterSeq", "limit"],
    boundKind: "clamping",
    boundSource: {
      file: "services/heartbeat.ts",
      expression: ".limit(Math.max(1, Math.min(limit, 1000)))",
    },
  },
  {
    specPath: "/api/heartbeat-runs/{runId}/log",
    pagingKeys: ["limitBytes", "offset"],
    allKeys: ["limitBytes", "offset"],
    boundKind: "clamping",
    boundSource: {
      file: "routes/agents.ts",
      expression: "Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)))",
    },
  },
  {
    specPath: "/api/workspace-operations/{operationId}/log",
    pagingKeys: ["limitBytes", "offset"],
    allKeys: ["limitBytes", "offset"],
    boundKind: "clamping",
    boundSource: {
      file: "routes/agents.ts",
      expression: "Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)))",
    },
  },
  {
    specPath: "/api/plugins/{pluginId}/logs",
    pagingKeys: ["limit"],
    allKeys: ["level", "limit", "since"],
    boundKind: "clamping",
    boundSource: {
      file: "routes/plugins.ts",
      expression: "Math.min(Math.max(parseInt(req.query.limit as string, 10) || 25, 1), 500)",
    },
  },
  {
    specPath: "/api/plugins/{pluginId}/jobs/{jobId}/runs",
    pagingKeys: ["limit"],
    allKeys: ["limit"],
    boundKind: "rejecting",
    boundSource: {
      file: "routes/plugins.ts",
      expression: "limit must be a number between 1 and 500",
    },
  },
  {
    specPath: "/api/routines/{id}/runs",
    pagingKeys: ["limit"],
    allKeys: ["limit"],
    boundKind: "clamping",
    boundSource: {
      file: "services/routines.ts",
      expression: "Math.max(1, Math.min(limit, 200))",
    },
  },
  {
    specPath: "/api/tool-connections/{connectionId}/activity",
    pagingKeys: ["limit"],
    allKeys: ["limit"],
    boundKind: "clamping",
    boundSource: {
      file: "services/tool-access.ts",
      expression: "Math.max(1, Math.min(100, Math.floor(limit)))",
    },
  },
];

describe("paged collections declare their query parameters", () => {
  it.each(PAGED_ROUTES)(
    "$specPath declares every query key its handler reads",
    ({ specPath, allKeys, pagingKeys }) => {
      const published = queryParameters(specPath);
      // An exact set, not a subset: a key the handler stops reading must leave
      // the contract too, and a partial declaration reads as a complete list.
      expect(Object.keys(published).sort()).toEqual([...allKeys].sort());
      for (const key of pagingKeys) {
        expect(published[key], `${specPath} must declare ${key}`).toBeDefined();
      }
    },
  );

  it.each(PAGED_ROUTES)(
    "$specPath publishes a range only where the handler REJECTS",
    ({ specPath, pagingKeys, boundKind }) => {
      const published = queryParameters(specPath);
      for (const key of pagingKeys) {
        const schema = published[key].schema ?? {};
        if (boundKind === "rejecting") continue;
        // A clamped bound must not publish `maximum`: the server answers 200
        // for a larger value, so a client trusting the range would refuse a
        // request that works.
        expect(
          schema.maximum,
          `${specPath} ${key} is clamped, so publishing a maximum would advertise a 400 that does not exist`,
        ).toBeUndefined();
      }
      if (boundKind === "rejecting") {
        const schema = published[pagingKeys[0]!].schema ?? {};
        expect(schema.minimum).toBe(1);
        expect(schema.maximum).toBe(500);
      }
    },
  );

  it.each(PAGED_ROUTES)(
    "$specPath still applies the bound kind its contract claims",
    ({ boundKind, boundSource }) => {
      const text = source(boundSource.file);
      expect(
        text.includes(boundSource.expression),
        `${boundSource.file} no longer contains ${boundSource.expression}; the ` +
        `published contract describes a ${boundKind} bound and must be re-derived`,
      ).toBe(true);
    },
  );

  /**
   * Numbers that an operation description states, where the bound is a NAMED
   * CONSTANT in another module.
   *
   * ⛔ The `boundSource` pin above is not enough for these. It proves the clamp
   * expression still exists, and for a clamp written with a literal — such as
   * `Math.max(1, Math.min(limit, 200))` — the value is inside the pinned text,
   * so drift breaks the pin. But `Math.min(ISSUE_LIST_MAX_LIMIT, ...)` keeps
   * matching after the constant changes from 1000 to anything else, and the
   * published "CLAMPED to 1000" would go stale while the suite stayed green.
   *
   * So these read the constant's value out of its own module and require the
   * same number in the published description. The spec cannot import the
   * constants: importing from `services/issues.js` into `routes/openapi.ts`
   * breaks route suites that mock that module partially.
   */
  const DOCUMENTED_CONSTANTS: {
    specPath: string;
    file: string;
    declaration: RegExp;
  }[] = [
    {
      specPath: "/api/companies/{companyId}/issues",
      file: "services/issues.ts",
      declaration: /export const ISSUE_LIST_MAX_LIMIT = (\d+);/,
    },
    {
      specPath: "/api/companies/{companyId}/issues",
      file: "services/issues.ts",
      declaration: /export const ISSUE_LIST_DEFAULT_LIMIT = (\d+);/,
    },
    {
      specPath: "/api/companies/{companyId}/activity",
      file: "services/activity.ts",
      declaration: /const MAX_ACTIVITY_LIMIT = (\d+);/,
    },
    {
      specPath: "/api/companies/{companyId}/activity",
      file: "services/activity.ts",
      declaration: /const DEFAULT_ACTIVITY_LIMIT = (\d+);/,
    },
    {
      specPath: "/api/heartbeat-runs/{runId}/log",
      file: "routes/agents.ts",
      declaration: /const RUN_LOG_DEFAULT_LIMIT_BYTES = ([\d_]+);/,
    },
    {
      specPath: "/api/workspace-operations/{operationId}/log",
      file: "routes/agents.ts",
      declaration: /const RUN_LOG_DEFAULT_LIMIT_BYTES = ([\d_]+);/,
    },
  ];

  it.each(DOCUMENTED_CONSTANTS)(
    "$specPath states the live value of $declaration",
    ({ specPath, file, declaration }) => {
      const match = declaration.exec(source(file));
      // A pin that cannot find its subject must fail, never pass quietly.
      expect(match, `${declaration} no longer matches ${file}`).not.toBeNull();
      const value = Number(match![1]!.replace(/_/g, ""));
      expect(Number.isFinite(value)).toBe(true);
      const description: string = spec.paths[specPath].get.description ?? "";
      expect(
        description.includes(String(value)),
        `${specPath} description does not state ${value}; the constant in ` +
        `${file} moved and the published clamp is now stale`,
      ).toBe(true);
    },
  );

  it("the byte ceiling stated for the log routes matches its constant", () => {
    // `RUN_LOG_MAX_LIMIT_BYTES` is written as an expression, not a literal, so
    // it is evaluated rather than pattern-matched.
    const match = /const RUN_LOG_MAX_LIMIT_BYTES = (\d+) \* (\d+);/.exec(
      source("routes/agents.ts"),
    );
    expect(match, "RUN_LOG_MAX_LIMIT_BYTES declaration moved").not.toBeNull();
    const ceiling = Number(match![1]) * Number(match![2]);
    expect(ceiling).toBeGreaterThan(0);
    for (const specPath of [
      "/api/heartbeat-runs/{runId}/log",
      "/api/workspace-operations/{operationId}/log",
    ]) {
      expect(
        (spec.paths[specPath].get.description ?? "").includes(String(ceiling)),
        `${specPath} does not state the ${ceiling} byte ceiling`,
      ).toBe(true);
    }
  });

  it("declares no query parameter as required except the count route's attention", () => {
    const required: string[] = [];
    for (const { specPath } of PAGED_ROUTES) {
      for (const [name, parameter] of Object.entries(queryParameters(specPath))) {
        if (parameter.required) required.push(`${specPath} ${name}`);
      }
    }
    // `required` is computed from the schema, so a non-optional entry publishes
    // a mandatory parameter — a worse falsehood than the silence it replaced.
    expect(required).toEqual([]);
  });

  describe("the blocked-issue count route is not a paged collection", () => {
    const specPath = "/api/companies/{companyId}/issues/count";

    it("reads limit and offset only to REFUSE them", () => {
      // The census that found these routes detects `req.query.limit` and cannot
      // tell a key that is honoured from one that is rejected. This route is
      // the second kind, so declaring the keys would publish paging support
      // that does not exist.
      const text = source("routes/issues.ts");
      expect(text).toContain("issues/count does not accept limit or offset");
      const published = queryParameters(specPath);
      expect(published.limit).toBeUndefined();
      expect(published.offset).toBeUndefined();
    });

    it("declares attention as required, because the handler 400s without it", () => {
      expect(source("routes/issues.ts")).toContain(
        "issues/count currently requires attention=blocked",
      );
      const attention = queryParameters(specPath).attention;
      expect(attention.required).toBe(true);
      expect(attention.schema.enum).toEqual(["blocked"]);
    });

    it("declares its filter keys", () => {
      expect(Object.keys(queryParameters(specPath)).sort()).toEqual([
        "assigneeAgentId", "assigneeUserId", "attention", "createdFromIssueId",
        "descendantOf", "excludeRoutineExecutions", "executionWorkspaceId",
        "hasPlanDocument", "includePluginOperations", "includeRoutineExecutions",
        "labelId", "originId", "originKind", "originKindPrefix", "parentId",
        "parentIssueId", "participantAgentId", "projectId", "q", "status",
        "workspaceId",
      ]);
    });
  });

  // ─── Controls ──────────────────────────────────────────────────────────────
  // A green run above is also what a blind test reports, so each instrument
  // used there is forced to fail once here.

  describe("controls", () => {
    it("queryParameters can fail: it throws for an undocumented operation", () => {
      expect(() => queryParameters("/api/not-a-real-route")).toThrow(
        /No GET operation documented/,
      );
    });

    it("queryParameters really reads the document, not an empty object", () => {
      // Without this, every `toBeUndefined` assertion above would pass against
      // a permanently empty parameter map.
      const published = queryParameters("/api/companies/{companyId}/issues");
      expect(Object.keys(published).length).toBeGreaterThan(30);
      expect(published.limit.schema).toMatchObject({
        type: "integer",
        minimum: 1,
      });
    });

    it("the maximum check can fail: a rejecting route does publish one", () => {
      // Proves the `toBeUndefined` assertions discriminate, rather than being
      // true of every route in the document.
      const published = queryParameters(
        "/api/plugins/{pluginId}/jobs/{jobId}/runs",
      );
      expect(published.limit.schema.maximum).toBe(500);
    });

    it("the source pin can fail: an absent expression is not reported as present", () => {
      expect(
        source("services/routines.ts").includes(
          "Math.max(1, Math.min(limit, 20000))",
        ),
      ).toBe(false);
    });

    it("every route in the table resolves to a real operation", () => {
      // A typo in `specPath` would otherwise make `it.each` cases throw rather
      // than assert, and a shrinking table would quietly test less.
      expect(PAGED_ROUTES.length).toBe(11);
      for (const { specPath } of PAGED_ROUTES) {
        expect(spec.paths?.[specPath]?.get, specPath).toBeDefined();
      }
    });
  });
});
