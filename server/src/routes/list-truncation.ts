import type { Response } from "express";

/**
 * Collection endpoints here return a bare JSON array and cap `limit` server
 * side. Without a signal on the response a caller cannot tell "the corpus is
 * exactly `limit` rows" from "the server stopped at `limit`" — every response
 * is `min(corpus, cap, requested)` — so the usual `rows.length < requested`
 * completeness check passes unconditionally once `requested` exceeds the cap.
 *
 * These headers make truncation observable without changing any response body,
 * so existing parsers are unaffected.
 */
export const LIST_RESULT_COUNT_HEADER = "X-Result-Count";
export const LIST_RESULT_LIMIT_HEADER = "X-Result-Limit";
export const LIST_RESULT_OFFSET_HEADER = "X-Result-Offset";
export const LIST_RESULT_TRUNCATED_HEADER = "X-Result-Truncated";
export const LIST_TOTAL_COUNT_HEADER = "X-Total-Count";

export type ListPagination = {
  /** Rows in the response body. */
  count: number;
  /**
   * The limit the server actually applied, after clamping. A caller that asked
   * for more than the cap sees the cap here, which is how the silent clamp
   * becomes visible. Omitted when the route applied no limit at all; callers
   * read `truncated` for completeness and never infer it from this field's
   * absence.
   */
  limit?: number;
  /** The offset the server actually applied. */
  offset: number;
  /** True when at least one more row exists after this page. */
  truncated: boolean;
  /**
   * Total rows matching the request across all pages, when the route can
   * establish it cheaply. Omitted rather than guessed — an absent header means
   * "not computed", never zero.
   */
  total?: number;
};

/**
 * Reads one row more than the caller asked for so truncation is measured
 * rather than inferred, then trims the page back to the requested size. The
 * returned `rows` are byte-identical to what the same request produced before
 * the probe existed.
 */
export function splitProbePage<T>(
  rows: T[],
  limit: number,
): { rows: T[]; truncated: boolean } {
  if (rows.length > limit) {
    return { rows: rows.slice(0, limit), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * The limit to send to the data layer so {@link splitProbePage} has a row to
 * detect truncation with.
 */
export function probeLimit(limit: number): number {
  return limit + 1;
}

export function setListPaginationHeaders(
  res: Response,
  pagination: ListPagination,
) {
  res.setHeader(LIST_RESULT_COUNT_HEADER, String(pagination.count));
  if (pagination.limit !== undefined) {
    res.setHeader(LIST_RESULT_LIMIT_HEADER, String(pagination.limit));
  }
  res.setHeader(LIST_RESULT_OFFSET_HEADER, String(pagination.offset));
  res.setHeader(
    LIST_RESULT_TRUNCATED_HEADER,
    pagination.truncated ? "true" : "false",
  );
  if (pagination.total !== undefined) {
    res.setHeader(LIST_TOTAL_COUNT_HEADER, String(pagination.total));
  }
}
