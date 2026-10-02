import { describe, expect, it } from "vitest";
import {
  LIST_RESULT_COUNT_HEADER,
  LIST_RESULT_LIMIT_HEADER,
  LIST_RESULT_OFFSET_HEADER,
  LIST_RESULT_TRUNCATED_HEADER,
  LIST_TOTAL_COUNT_HEADER,
  probeLimit,
  setListPaginationHeaders,
  splitProbePage,
} from "./list-truncation.js";

function fakeResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as any,
  };
}

describe("splitProbePage", () => {
  it("reports truncation when the probe row came back", () => {
    const page = splitProbePage([1, 2, 3, 4], 3);
    expect(page.truncated).toBe(true);
    expect(page.rows).toEqual([1, 2, 3]);
  });

  // The control: without this case a hard-coded `truncated: true` would pass
  // the test above. A corpus that ends exactly at the limit is the case the
  // silent-clamp bug could not distinguish.
  it("reports no truncation when the corpus ends exactly at the limit", () => {
    const page = splitProbePage([1, 2, 3], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([1, 2, 3]);
  });

  it("reports no truncation for a short page", () => {
    const page = splitProbePage([1], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([1]);
  });

  it("reports no truncation for an empty page", () => {
    const page = splitProbePage([], 3);
    expect(page.truncated).toBe(false);
    expect(page.rows).toEqual([]);
  });

  it("asks the data layer for exactly one row past the page", () => {
    expect(probeLimit(1000)).toBe(1001);
    expect(probeLimit(1)).toBe(2);
  });
});

describe("setListPaginationHeaders", () => {
  it("publishes the applied limit, offset, count and truncation flag", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 1000,
      limit: 1000,
      offset: 0,
      truncated: true,
    });
    expect(headers.get(LIST_RESULT_COUNT_HEADER)).toBe("1000");
    expect(headers.get(LIST_RESULT_LIMIT_HEADER)).toBe("1000");
    expect(headers.get(LIST_RESULT_OFFSET_HEADER)).toBe("0");
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("true");
  });

  it("writes truncated=false rather than omitting the header", () => {
    // A completeness proof reads this header directly, so an absent value must
    // never be the way "complete" is expressed.
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 3,
      limit: 500,
      offset: 0,
      truncated: false,
    });
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("false");
  });

  it("omits the total when the route did not compute one", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 3,
      limit: 500,
      offset: 0,
      truncated: false,
    });
    expect(headers.has(LIST_TOTAL_COUNT_HEADER)).toBe(false);
  });

  it("publishes the total when the route computed one", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 1000,
      limit: 1000,
      offset: 0,
      truncated: true,
      total: 26_374,
    });
    expect(headers.get(LIST_TOTAL_COUNT_HEADER)).toBe("26374");
  });

  it("omits the applied-limit header when no limit was applied", () => {
    const { headers, res } = fakeResponse();
    setListPaginationHeaders(res, {
      count: 7,
      offset: 0,
      truncated: false,
      total: 7,
    });
    expect(headers.has(LIST_RESULT_LIMIT_HEADER)).toBe(false);
    expect(headers.get(LIST_RESULT_TRUNCATED_HEADER)).toBe("false");
  });
});
