// Canva folder ids on the client record (migration 0056 and
// src/lib/canva-folders.ts). Pure: reads files only. The database behaviour
// (constraints, the guard, the read model, no impact elsewhere) is the
// sandbox's client_canva_folders.test.sql; this pins the seed to the
// confirmed reconciliation (tests/fixtures/canva-folder-mapping.json) and
// the TypeScript rule to the SQL one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CANVA_FOLDER_ID_PATTERN, canvaFolderUrl, isCanvaFolderId, toClientCanvaFolders,
} from "../src/lib/canva-folders.ts";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../supabase/migrations/0056_client_canva_folders.sql");
const confirmed = JSON.parse(read("./fixtures/canva-folder-mapping.json"));

// The rows of 0056's seed insert: (client_id, client_name, folder, used).
function seedRows() {
  const start = migration.indexOf("insert into canva_folder_seed");
  assert.ok(start >= 0, "0056 seeds from canva_folder_seed");
  const end = migration.indexOf(";\n", start);
  return [...migration.slice(start, end).matchAll(/\('([0-9a-f-]{36})', '([^']+)',\s*'([^']+)', '([^']+)'\)/g)]
    .map(([, client_id, client_name, canva_folder_id, canva_used_folder_id]) => ({ client_id, client_name, canva_folder_id, canva_used_folder_id }));
}

test("the seed is exactly the confirmed mapping, keyed by client id", () => {
  const want = confirmed.clients.map(({ client_id, client_name, canva_folder_id, canva_used_folder_id }) =>
    ({ client_id, client_name, canva_folder_id, canva_used_folder_id }));
  assert.deepEqual(seedRows(), want);
  assert.equal(seedRows().length, 8);
});

test("the two Show Me clients map to their confirmed folders despite the names", () => {
  const byName = Object.fromEntries(seedRows().map((r) => [r.client_name, r]));
  assert.deepEqual([byName["Show Me Design"].canva_folder_id, byName["Show Me Design"].canva_used_folder_id], ["FAF1yAflBAI", "FAF50vURLLI"]);
  assert.deepEqual([byName["Show Me Electrical"].canva_folder_id, byName["Show Me Electrical"].canva_used_folder_id], ["FAFmufa_fQo", "FAF50si5M04"]);
  // Canva's labels differ from the CRM names; only the ids are recorded.
  const labels = Object.fromEntries(confirmed.clients.map((c) => [c.client_name, c.canva_folder_label]));
  assert.equal(labels["Show Me Design"], "ShowMe Design+Build");
  assert.equal(labels["Show Me Electrical"], "Show Me Electric");
});

test("the activation test client and every Canva-only folder stay unmapped", () => {
  const seeded = new Set(seedRows().flatMap((r) => [r.client_id, r.canva_folder_id, r.canva_used_folder_id]));
  for (const c of confirmed.unmapped_clients) assert.ok(!seeded.has(c.client_id), c.client_name);
  for (const f of confirmed.canva_only_folders) assert.ok(!seeded.has(f.id), f.label);
});

test("every seeded folder id is unique and none is a folder name", () => {
  const ids = seedRows().flatMap((r) => [r.canva_folder_id, r.canva_used_folder_id]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(isCanvaFolderId(id), id);
  const labels = confirmed.clients.flatMap((c) => [c.canva_folder_label, c.canva_used_folder_label]);
  for (const l of labels) assert.ok(!migration.includes(`'${l}'`) || confirmed.clients.some((c) => c.client_name === l),
    `the Canva label "${l}" is not written by the migration`);
});

test("the seed matches on client id, never on a name", () => {
  const block = migration.slice(migration.indexOf("-- ── 4. Backfill"));
  assert.match(block, /where c\.id = s\.client_id/);
  assert.doesNotMatch(block, /c\.name\s*=|name\s*=\s*s\./);
});

test("the TypeScript rule is the SQL constraint's rule", () => {
  const sqlPatterns = [...migration.matchAll(/canva_(?:used_)?folder_id ~ '([^']+)'/g)].map((m) => m[1]);
  assert.equal(sqlPatterns.length, 2);
  for (const p of sqlPatterns) assert.equal(p, CANVA_FOLDER_ID_PATTERN);
});

test("folder id rule: ids yes; names, pseudo-folders and design ids no", () => {
  for (const ok of ["FAHWhFz-WfY", "FAF50sDs_zY", "FAFmufa_fQo"]) assert.ok(isCanvaFolderId(ok), ok);
  for (const bad of ["Lucas Used", "Show Me Used", "uploads", "root", "DAGw7dXmnjI", "BTMabc12345", "FA", "", null, 42])
    assert.ok(!isCanvaFolderId(bad), String(bad));
  assert.equal(canvaFolderUrl("FAHWhKRTBmM"), "https://www.canva.com/folder/FAHWhKRTBmM");
  assert.throws(() => canvaFolderUrl("Lucas Used"));
});

test("the read model's row: enabled only with a primary folder on a live client", () => {
  const row = (over = {}) => ({ client_id: "c", client_name: "Lucas Construction", client_status: "launching",
    canva_folder_id: "FAFgsbtQBMU", canva_used_folder_id: "FAF50gfFIFo", canva_enabled: true, ...over });
  assert.deepEqual(toClientCanvaFolders(row()), { clientId: "c", clientName: "Lucas Construction", clientStatus: "launching",
    folderId: "FAFgsbtQBMU", usedFolderId: "FAF50gfFIFo", enabled: true });
  const none = toClientCanvaFolders(row({ canva_folder_id: null, canva_used_folder_id: null, canva_enabled: false }));
  assert.equal(none.folderId, null);
  assert.equal(none.usedFolderId, null);
  assert.equal(none.enabled, false);
  assert.equal(toClientCanvaFolders(row({ client_status: "offboarded", canva_enabled: false })).enabled, false);
});

test("Client Intelligence and Authority inputs are not extended (no stale Authority runs, same Drafter briefs)", () => {
  const later = fs.readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f >= "0056");
  for (const f of later) {
    const sql = read(`../supabase/migrations/${f}`);
    assert.doesNotMatch(sql, /create (or replace )?function (client_intelligence_input|authority_input|authority_fingerprint)\b/, f);
  }
  assert.doesNotMatch(read("../src/lib/client-intelligence.ts"), /canva/i);
});
