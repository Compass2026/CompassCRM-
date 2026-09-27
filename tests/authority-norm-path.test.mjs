// The engine's normPath and 0050's authority_norm_path must agree: the SQL
// port decides which pages a reconciliation may touch. The same vectors run
// against the SQL in supabase/tests/sandbox/authority_reconcile.test.sql.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normPath } from "../supabase/functions/authority/urls.ts";

const { site, vectors } = JSON.parse(readFileSync(new URL("./fixtures/authority-norm-path-vectors.json", import.meta.url), "utf8"));

test("normPath: the shared vectors", () => {
  for (const v of vectors) assert.equal(normPath(v.url, site), v.expect, JSON.stringify(v.url));
});
