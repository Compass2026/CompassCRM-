// Citations Phase 1 pure helpers (src/lib/citations.ts). Fixtures are
// fictional and generic: they are NOT a BrightLocal (or any provider) export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCsv, guessMapping, isCredentialHeader, prepareImport, listingKey, listingUrl, fulfillmentFromText, parseSourceDate,
  compareListing, evidenceFreshness, csvCell, toCsv, exportRows, publicAddress, needsAction, rowHash, RESULT_METHODS, identityCurrent,
  comparisonSource, EXPORT_HEADERS,
} from "../src/lib/citations.ts";

const LOC_A = "00000000-0000-4000-8000-0000000000a1";
const LOC_B = "00000000-0000-4000-8000-0000000000b1";
const ids = new Set([LOC_A, LOC_B]);
const sample = readFileSync(new URL("./fixtures/citations/sample-generic-citations.csv", import.meta.url), "utf8");

test("CSV parser: BOM, quoted commas, quoted newlines, escaped quotes, CRLF, blank lines", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","line1\nline2","say ""hi"""\r\n\r\n1,,3\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", "line1\nline2", 'say "hi"'], ["1", "", "3"]]);
  assert.throws(() => parseCsv('a\n"unterminated'), /quoted cell/);
});

test("credential-like columns are never mapped", () => {
  for (const h of ["Password", "Login", "API Key", "username", "Account token", "Secret"]) assert.ok(isCredentialHeader(h), h);
  for (const h of ["Listing URL", "Directory", "Phone", "Business name"]) assert.ok(!isCredentialHeader(h), h);
  const rows = parseCsv(sample);
  const m = guessMapping(rows[0]);
  assert.ok(!Object.values(m).includes(rows[0].indexOf("Login password")), "password column not guessed");
  assert.throws(() => prepareImport(rows, { ...m, notes: rows[0].indexOf("Login password") }, { mode: "column", values: {} }, ids), /login column/);
});

test("generic header guess is a starting point only", () => {
  assert.deepEqual(guessMapping(["Location", "Directory", "Listing URL", "Status", "Phone", "Date checked"]),
    { location: 0, directory: 1, listing_url: 2, fulfillment_status: 3, observed_phone: 4, source_observed_on: 5 });
});

test("rows are validated individually: unmapped locations rejected, never guessed; counts reconcile", () => {
  const rows = parseCsv(sample);
  const r = prepareImport(rows, guessMapping(rows[0]), { mode: "column", values: { "Main office (sample)": LOC_A, "North branch (sample)": LOC_B } }, ids, "2026-10-20");
  assert.equal(r.total, rows.length - 1);
  assert.equal(r.accepted.length + r.rejected.length, r.total, "every row is accounted for");
  const reasons = r.rejected.map((x) => x.reason).join("\n");
  assert.match(reasons, /Location "Unknown annex \(sample\)" is not mapped/);
  assert.match(reasons, /Provider status "verified by robot"/);
  assert.match(reasons, /Listing URL must be/);
  assert.match(reasons, /in the future/);
  assert.ok(r.accepted.every((a) => a.location_id === LOC_A || a.location_id === LOC_B));
  assert.ok(r.accepted.every((a) => !JSON.stringify(a).includes("hunter2")), "credential cell never carried");
});

test("single-location mode places every row; a location must be chosen", () => {
  const rows = [["Directory", "Listing URL"], ["Yelp", "https://www.yelp.com/biz/sample"]];
  assert.equal(prepareImport(rows, { directory: 0, listing_url: 1 }, { mode: "single", locationId: LOC_A }, ids).accepted[0].location_id, LOC_A);
  assert.throws(() => prepareImport(rows, { directory: 0 }, { mode: "single", locationId: "00000000-0000-4000-8000-000000000999" }, ids), /Choose a business location/);
  assert.throws(() => prepareImport(rows, {}, { mode: "single", locationId: LOC_A }, ids), /directory column or a listing URL/);
});

test("provider status vocabulary: complete is provider_complete, unknown words are rejected", () => {
  assert.equal(fulfillmentFromText("Complete"), "provider_complete");
  assert.equal(fulfillmentFromText("in-progress"), "pending");
  assert.equal(fulfillmentFromText("verified by robot"), null);
});

test("listing keys: URL normalized, else external id, else the URL-less slot", () => {
  assert.equal(listingKey("https://WWW.Yelp.com/biz/sample/", null), "url:yelp.com/biz/sample");
  assert.equal(listingKey("https://yelp.com/biz/sample", "X1"), listingKey("https://www.yelp.com/biz/sample/", null));
  assert.equal(listingKey(null, " AB-1 "), "ext:ab-1");
  assert.equal(listingKey(null, null), "none");
  assert.throws(() => listingUrl("https://user:pw@yelp.com/x"), /credentials/);
  assert.throws(() => listingUrl("javascript:alert(1)"));
});

test("dates: ISO and US forms, no future dates", () => {
  assert.equal(parseSourceDate("10/05/2026", "2026-10-20"), "2026-10-05");
  assert.equal(parseSourceDate("2026-10-01T12:00:00Z", "2026-10-20"), "2026-10-01");
  assert.equal(parseSourceDate("", "2026-10-20"), null);
  assert.throws(() => parseSourceDate("2026-11-01", "2026-10-20"), /future/);
  assert.throws(() => parseSourceDate("soon"), /not a date/);
});

const exportBase = { client_name: "Sandbox", location_label: "SAB", directory_name: "Yelp", listing_url: "https://yelp.com/biz/x", external_id: null,
  fulfillment_status: "provider_complete", verification_status: "unverified", last_checked_on: null, last_check_result: null, check_identity_version: null, identity_version: 1,
  current_name: "", current_address: "", current_phone: "", current_website: "", source_provider: "sample", source_observed_on: null, last_imported_at: null,
  source_name: "", source_address: "", source_phone: "", source_website: "", open_tasks: 0, suspected_duplicate: false };
const identity = { business_name: "Sample Roofing LLC", address_line1: "100 North Main Street", address_line2: "Suite 5", city: "Springfield",
  region: "MO", postal_code: "65806", country: "US", phone: "(417) 555-0100", website_url: "https://www.sample-roofing.example/", hide_address: false };

test("field comparison normalizes formatting and flags real differences", () => {
  const c = compareListing(identity, { observed_name: "Sample Roofing", observed_address: "100 N Main St Ste 5, Springfield, MO 65806-1234",
    observed_phone: "+1 417-555-0100", observed_website: "sample-roofing.example" });
  assert.deepEqual(c, { name: "match", address: "match", phone: "match", website: "match" });
  const d = compareListing(identity, { observed_name: "Sample Roofing & Siding", observed_address: "", observed_phone: "417-555-0199", observed_website: "" });
  assert.deepEqual(d, { name: "mismatch", address: "not_observed", phone: "mismatch", website: "not_observed" });
});

test("hidden address: any observed address is 'exposed'; public outputs never carry the street", () => {
  const hidden = { ...identity, hide_address: true };
  assert.equal(compareListing(hidden, { observed_name: "", observed_address: "100 N Main St", observed_phone: "", observed_website: "" }).address, "exposed");
  assert.ok(!publicAddress(hidden).includes("Main"));
  const listing = { ...exportBase, identity: hidden, current_address: "100 N Main St", source_address: "100 North Main Street" };
  const client = toCsv(exportRows([listing], "client"));
  assert.ok(!client.includes("Main"), "client-safe export has no street, checked or imported");
  assert.match(client, /should be hidden/);
  assert.match(toCsv(exportRows([listing], "internal")), /HIDDEN — internal only/);
});

test("export cells are spreadsheet-safe", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  for (const v of ["+1", "-2", "@SUM(A1)", "\tcmd", " =1"]) assert.match(csvCell(v), /^"'/, v);
  assert.equal(csvCell("Plain, text"), '"Plain, text"');
  assert.equal(csvCell(null), '""');
});

test("provider complete is never verified; it is action required until someone checks", () => {
  assert.ok(needsAction({ verification_status: "unverified", fulfillment_status: "provider_complete", open_tasks: 0, suspected_duplicate: false }));
  assert.ok(!needsAction({ verification_status: "verified_accurate", fulfillment_status: "provider_complete", open_tasks: 0, suspected_duplicate: false }));
  assert.ok(needsAction({ verification_status: "verified_accurate", fulfillment_status: "none", open_tasks: 1, suspected_duplicate: false }));
});

test("evidence freshness: current, stale after 90 days, superseded by an identity change, none", () => {
  assert.equal(evidenceFreshness("2026-10-01", "2026-10-20"), "current");
  assert.equal(evidenceFreshness("2026-10-19", "2026-10-20", false), "superseded", "a fresh check against an older identity is not current");
  assert.ok(identityCurrent({ check_identity_version: 3, identity_version: 3 }));
  assert.ok(!identityCurrent({ check_identity_version: 2, identity_version: 3 }));
  assert.equal(evidenceFreshness("2026-06-01", "2026-10-20"), "stale");
  assert.equal(evidenceFreshness(null, "2026-10-20"), "none");
});

test("absence needs a publisher or dashboard confirmation; a search is not proof", () => {
  assert.deepEqual(RESULT_METHODS.confirmed_absent, ["owner_dashboard", "publisher_confirmation"]);
  assert.ok(!RESULT_METHODS.confirmed_absent.includes("publisher_search"));
  assert.notEqual(rowHash(["a", "b"]), rowHash(["ab", ""]));
});

test("the module is off unless CITATIONS_ENABLED is exactly \"true\"", async () => {
  const { citationsEnabled } = await import("../src/lib/citations-flag.ts");
  assert.equal(citationsEnabled({}), false);
  for (const v of ["", "1", "TRUE", "yes", "true "]) assert.equal(citationsEnabled({ CITATIONS_ENABLED: v }), false, v);
  assert.equal(citationsEnabled({ CITATIONS_ENABLED: "true" }), true);
});

const col = (rows, name) => rows[0].indexOf(name);
test("export: current values come from the latest check, imported values stay separate with their own dates", () => {
  const l = { ...exportBase, identity, verification_status: "verified_accurate", last_checked_on: "2026-10-20", last_check_result: "accurate", check_identity_version: 2, identity_version: 2,
    current_phone: "(417) 555-0100", source_phone: "417-555-0199", source_observed_on: "2026-10-02", source_provider: "brightlocal" };
  const rows = exportRows([l], "internal", "2026-10-20");
  assert.equal(rows[1][col(rows, "Current phone")], "(417) 555-0100");
  assert.equal(rows[1][col(rows, "Last checked")], "2026-10-20");
  assert.equal(rows[1][col(rows, "Source phone")], "417-555-0199");
  assert.equal(rows[1][col(rows, "Source observed")], "2026-10-02");
  assert.equal(rows[1][col(rows, "Evidence")], "Current evidence");
  assert.equal(rows[0].length, EXPORT_HEADERS.length);
  const stale = exportRows([{ ...l, verification_status: "needs_reverification", identity_version: 3 }], "client", "2026-10-20");
  assert.equal(stale[1][col(stale, "Verification")], "Needs reverification");
  assert.equal(stale[1][col(stale, "Evidence")], "Identity changed since check");
  assert.equal(stale[1][col(stale, "Checked against identity")], 2);
  assert.equal(stale[1][col(stale, "Current identity")], 3);
});

test("needs reverification is action required", () => {
  assert.ok(needsAction({ verification_status: "needs_reverification", fulfillment_status: "none", open_tasks: 0, suspected_duplicate: false }));
});

test("comparison uses the latest content check, else the import (flagged), never the import after a check", () => {
  const base = { ...exportBase, last_check_id: null, source_phone: "417-555-0199" };
  assert.equal(comparisonSource(base).from, "source");
  const checked = { ...base, last_check_id: "c", last_check_result: "accurate", current_phone: "(417) 555-0100" };
  assert.deepEqual([comparisonSource(checked).from, comparisonSource(checked).fields.observed_phone], ["check", "(417) 555-0100"]);
  const inaccessible = { ...base, last_check_id: "c", last_check_result: "inaccessible" };
  assert.deepEqual([comparisonSource(inaccessible).from, comparisonSource(inaccessible).fields.observed_phone], ["none", ""], "an inaccessible check does not fall back to the import");
});
