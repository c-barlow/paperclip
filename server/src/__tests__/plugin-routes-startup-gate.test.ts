/**
 * Regression tests for the plugin-route startup gate.
 *
 * The shared lifecycle manager is constructed without a runtime loader and has
 * it backfilled (`setLoader`) only after the startup bundled-plugin pass. The
 * HTTP listener is bound before that pass settles — deliberately, so a runner
 * that survived a controller crash can re-authenticate — which leaves a window
 * where a lifecycle mutation can reach a manager that cannot activate workers.
 * In that window `activateReadyPlugin` no-ops: the plugin persists as `ready`
 * and the dispatcher advertises its tools, but nothing is running behind them.
 *
 * The mutating routes therefore await `pluginsReady` before driving the
 * manager. These tests pin that ordering.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginId = "11111111-1111-4111-8111-111111111111";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection here would fail the run before the route observes it.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function createApp(pluginsReady?: () => Promise<unknown> | undefined) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    } as unknown as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    { toolGateway: {} as never, pluginsReady },
  ));
  app.use(errorHandler);
  return app;
}

describe("plugin lifecycle routes gate on the startup pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const plugin = { id: pluginId, pluginKey: "example.plugin", version: "1.0.0", status: "ready" };
    mockRegistry.getById.mockResolvedValue(plugin);
    mockLifecycle.enable.mockResolvedValue(plugin);
    mockLifecycle.disable.mockResolvedValue(plugin);
    mockLifecycle.unload.mockResolvedValue(plugin);
    mockLifecycle.upgrade.mockResolvedValue(plugin);
  });

  it("does not drive the lifecycle manager until the startup pass settles", async () => {
    const startup = deferred();
    const app = await createApp(() => startup.promise);

    // `.then()` is what makes supertest actually dispatch — a bare
    // `request(...)` is lazy and would make the assertion below vacuous.
    const inFlight = request(app).post(`/api/plugins/${pluginId}/enable`).send({}).then((r) => r);

    // Give the handler room to run up to the gate. If the gate were missing,
    // enable() would already have been invoked against a loader-less manager.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockLifecycle.enable).not.toHaveBeenCalled();

    startup.resolve();
    const res = await inFlight;

    expect(res.status).toBe(200);
    expect(mockLifecycle.enable).toHaveBeenCalledWith(pluginId);
  });

  it.each([
    ["disable", (app: express.Express) => request(app).post(`/api/plugins/${pluginId}/disable`).send({}).then((r) => r), () => mockLifecycle.disable],
    ["upgrade", (app: express.Express) => request(app).post(`/api/plugins/${pluginId}/upgrade`).send({}).then((r) => r), () => mockLifecycle.upgrade],
    ["uninstall", (app: express.Express) => request(app).delete(`/api/plugins/${pluginId}`).then((r) => r), () => mockLifecycle.unload],
  ])("gates %s on the startup pass too", async (_name, send, getSpy) => {
    const startup = deferred();
    const app = await createApp(() => startup.promise);

    const inFlight = send(app);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getSpy()).not.toHaveBeenCalled();

    startup.resolve();
    expect((await inFlight).status).toBe(200);
    expect(getSpy()).toHaveBeenCalled();
  });

  it("proceeds once the startup pass settles, even if it failed", async () => {
    // A failed bundled-plugin pass is already logged by the composition root.
    // What matters to the route is that the loader backfill (which runs in a
    // `.finally`) has happened — so a rejection must not wedge the endpoint.
    const startup = deferred();
    const app = await createApp(() => startup.promise);

    const inFlight = request(app).post(`/api/plugins/${pluginId}/enable`).send({}).then((r) => r);
    startup.reject(new Error("bundled plugin install failed"));

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(mockLifecycle.enable).toHaveBeenCalledWith(pluginId);
  });

  it("stays usable for callers that wire no startup promise", async () => {
    const app = await createApp(undefined);

    const res = await request(app).post(`/api/plugins/${pluginId}/enable`).send({});

    expect(res.status).toBe(200);
    expect(mockLifecycle.enable).toHaveBeenCalledWith(pluginId);
  });
});
