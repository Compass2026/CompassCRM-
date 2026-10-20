// fetchAll (src/lib/fetch-all.ts): complete reads under any API row cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAll } from "../src/lib/fetch-all.ts";

// A PostgREST stand-in: `cap` rows at most per response, an exact count.
function api(total, cap, { countDrift = false } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  let calls = 0;
  return {
    page: async (from, to) => {
      calls++;
      return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: countDrift && calls > 1 ? total + 1 : total };
    },
    calls: () => calls,
  };
}

test("1,200 rows through a 1,000-row cap arrive complete and in order", async () => {
  const a = api(1200, 1000);
  const { rows, error } = await fetchAll(a.page);
  assert.equal(error, null);
  assert.equal(rows.length, 1200);
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 1200 }, (_, i) => i));
});

test("a cap below the page size never skips rows (advances by rows received)", async () => {
  const a = api(1200, 300);
  const { rows, error } = await fetchAll(a.page, 1000);
  assert.equal(error, null);
  assert.equal(new Set(rows.map((r) => r.id)).size, 1200);
  assert.equal(a.calls(), 4);
});

test("partial, uncountable or moving data is an error, never a complete-looking list", async () => {
  const short = { page: async (from) => ({ data: from === 0 ? [{ id: 0 }] : [], error: null, count: 5 }) };
  assert.match((await fetchAll(short.page)).error, /Only 1 of 5/);
  assert.equal((await fetchAll(short.page)).rows.length, 0);
  assert.match((await fetchAll(async () => ({ data: [], error: null, count: null }))).error, /counted/);
  assert.match((await fetchAll(api(1200, 1000, { countDrift: true }).page)).error, /changed/);
  assert.match((await fetchAll(async () => ({ data: null, error: { message: "boom" }, count: null }))).error, /could not be read/);
  assert.deepEqual(await fetchAll(api(0, 1000).page), { rows: [], error: null });
});
