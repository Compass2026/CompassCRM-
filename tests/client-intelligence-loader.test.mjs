// The canonical Client Intelligence loader (migration 0047's
// client_intelligence_input) against the DrafterInput contract. The
// field list in supabase/functions/post-drafter/types.ts is checked against
// the DrafterInput type at compile time; this checks the SQL against the
// list, so the SQL, the list and the type cannot drift apart. Pure: reads
// files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DRAFTER_INPUT_FIELDS } from "../supabase/functions/post-drafter/types.ts";

const migration = fs.readFileSync(new URL("../supabase/migrations/0047_ai_drafter.sql", import.meta.url), "utf8");

function loaderBody() {
  const start = migration.indexOf("create function client_intelligence_input(p_client_id uuid)");
  assert.ok(start >= 0, "0047 defines client_intelligence_input");
  const open = migration.indexOf("$$", start);
  const close = migration.indexOf("$$;", open + 2);
  return migration.slice(open + 2, close);
}

// Top-level sections: the keys of the outer jsonb_build_object, one per line
// at four spaces. Each section's fields: the quoted keys inside it.
function sections(body) {
  const heads = [...body.matchAll(/\n {4}'(\w+)', /g)];
  return Object.fromEntries(heads.map((m, i) => {
    const text = body.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : body.length);
    return [m[1], [...text.matchAll(/'(\w+)', /g)].map((f) => f[1])];
  }));
}

test("the loader returns exactly DrafterInput's sections", () => {
  assert.deepEqual(Object.keys(sections(loaderBody())).sort(), Object.keys(DRAFTER_INPUT_FIELDS).sort());
});

test("each section carries exactly the DrafterInput fields", () => {
  const got = sections(loaderBody());
  for (const [k, fields] of Object.entries(DRAFTER_INPUT_FIELDS)) {
    if (fields === null) {
      assert.deepEqual(got[k], [], `${k} is a scalar`);
      continue;
    }
    assert.deepEqual([...got[k]].sort(), [...fields].sort(), `section ${k}`);
  }
});

test("every list is ordered deterministically (same input, same brief hash)", () => {
  const body = loaderBody();
  for (const k of ["services", "keywords", "claims", "locations", "assets", "offers", "pageGroups"]) {
    const m = body.match(new RegExp(`\\n {4}'${k}', [\\s\\S]*?jsonb_agg\\([\\s\\S]*? order by ([^)]+)\\)`));
    assert.ok(m, `${k} is aggregated with an ORDER BY`);
    assert.match(m[1], /\.id\s*$/, `${k} ends its ordering with the id as the tie-breaker`);
  }
});

test("the loader runs with the caller's rights and is closed to anon", () => {
  assert.match(migration, /client_intelligence_input\(p_client_id uuid\) returns jsonb\s+language sql stable security invoker/);
  assert.match(migration, /revoke all on function client_intelligence_input\(uuid\) from public, anon;/);
});

test("the Intelligence tab reads only through the loader", () => {
  const page = fs.readFileSync(new URL("../src/app/(app)/clients/[clientId]/intelligence/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\.rpc\("client_intelligence_input", \{ p_client_id: clientId \}\)/);
  assert.doesNotMatch(page, /\.from\(/, "no direct table reads left on the tab");
});
