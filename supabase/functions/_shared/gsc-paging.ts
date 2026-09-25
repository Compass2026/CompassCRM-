// Search Console searchAnalytics pagination for gsc-sync, shared with the
// Authority Engine (which labels a stored window's coverage from these
// constants). Pure: the page fetch is injected.
//
// Until Sept 25 2026 gsc-sync asked for rowLimit 250 with no startRow, so a
// window stored then with exactly 250 rows was cut off. Now it pages with
// startRow until a page comes back short, or until GSC_MAX_ROWS, a
// conservative safety cap. A window that reaches the cap is partial, and the
// sync logs it.

export const GSC_PAGE_SIZE = 1000;          // rows asked for per request (API max 25,000)
export const GSC_MAX_ROWS = 10000;          // safety cap on rows per client per window
export const GSC_LEGACY_ROW_LIMIT = 250;    // the old single-request limit

export type GscApiRow = { keys: [string, string]; clicks: number; impressions: number; ctr: number; position: number };
export type PageResult = { ok: true; rows: GscApiRow[] } | { ok: false; status: number; detail?: string };
export type Paged =
  | { ok: true; rows: GscApiRow[]; pages: number; capped: boolean; duplicates: number }
  | { ok: false; status: number; detail?: string; pages: number };

// Pages until a short page (complete) or the cap (capped). Any failed page
// fails the whole window: nothing partial is returned to be stored, so a
// window is never recorded as complete when it is not.
export async function fetchAllRows(
  fetchPage: (startRow: number, rowLimit: number) => Promise<PageResult>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<Paged> {
  const pageSize = opts.pageSize ?? GSC_PAGE_SIZE;
  const maxRows = opts.maxRows ?? GSC_MAX_ROWS;
  const seen = new Set<string>();
  const rows: GscApiRow[] = [];
  let startRow = 0, pages = 0, duplicates = 0, capped = false;
  for (;;) {
    const limit = Math.min(pageSize, maxRows - startRow);
    if (limit <= 0) { capped = true; break; }
    const page = await fetchPage(startRow, limit);
    pages++;
    if (!page.ok) return { ok: false, status: page.status, detail: page.detail, pages };
    for (const r of page.rows) {
      const k = JSON.stringify([r.keys[0], r.keys[1] ?? ""]);
      if (seen.has(k)) { duplicates++; continue; }   // never two rows for one (query, page)
      seen.add(k);
      rows.push(r);
    }
    startRow += page.rows.length;
    if (page.rows.length < limit) break;             // short page: the window is complete
    if (startRow >= maxRows) { capped = true; break; }
  }
  return { ok: true, rows, pages, capped, duplicates };
}
