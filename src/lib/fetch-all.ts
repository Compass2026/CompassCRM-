// Complete reads through PostgREST, whatever its row cap (db-max-rows).
//
// A single `.limit(n)` silently returns at most the API's cap, so a report
// can look complete while missing rows. fetchAll asks for an exact count,
// advances by the rows actually received (a cap below the page size cannot
// skip anything) and fails when the total is not reached, the count moves
// mid-read, or a page comes back empty early. Callers order by a unique key
// so pages are stable. No Next.js imports, so tests/fetch-all.test.mjs can run it.

export type Page<T> = { data: T[] | null; error: unknown; count: number | null };
export type FetchAll<T> = { rows: T[]; error: string | null };

export const FETCH_PAGE_SIZE = 1000;
// A ceiling on round trips so a misbehaving API cannot loop forever (1,000 pages).
const MAX_PAGES = 1000;

export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<Page<T>>, size = FETCH_PAGE_SIZE): Promise<FetchAll<T>> {
  const rows: T[] = [];
  let total: number | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const { data, error, count } = await page(rows.length, rows.length + size - 1);
    if (error) return { rows: [], error: "The data could not be read completely. Refresh to retry." };
    if (count === null) return { rows: [], error: "The data could not be counted, so it is not shown as complete. Refresh to retry." };
    if (total === null) total = count;
    else if (count !== total) return { rows: [], error: "The data changed while it was being read. Refresh to retry." };
    rows.push(...(data ?? []));
    if (rows.length >= total) break;
    if (!data?.length) return { rows: [], error: `Only ${rows.length} of ${total} rows could be read. Refresh to retry.` };
  }
  if (total === null || rows.length !== total) return { rows: [], error: `Only ${rows.length} of ${total ?? "?"} rows could be read. Refresh to retry.` };
  return { rows, error: null };
}
