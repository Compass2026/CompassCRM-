// BrightLocal campaign preparation and content screening (src/lib/citations-brightlocal.ts,
// sensitiveContent in src/lib/citations.ts). SYNTHETIC fixture only: same contract as the
// real export, fictional business, FAKE credentials and token links in Notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv, prepareImport, sensitiveContent, citationText } from "../src/lib/citations.ts";
import { prepareBrightLocalCampaign, brightLocalDate, isBrightLocalCampaign, GENERIC_MAPPING } from "../src/lib/citations-brightlocal.ts";

const LOC = "00000000-0000-4000-8000-0000000000c1";
const table = parseCsv(readFileSync(new URL("./fixtures/citations/synthetic-brightlocal-campaign.csv", import.meta.url), "utf8"));
const SECRETS = ["Fake-Pass-0000", "SyntheticToken", "fake-owner", "FAKE0123456789abcdef", "synthetic.user@example.test"];

test("campaign export: 15 directory rows reconcile, the footer is not a listing", () => {
  const bl = prepareBrightLocalCampaign(table, { locationLabel: "Sample", campaign: "900001" });
  assert.deepEqual(bl.counts.byRawStatus, { Live: 8, Updated: 1, Submitted: 2, Unavailable: 1, "(blank)": 3 });
  assert.equal(bl.counts.directoryRows, 15);
  assert.equal(bl.counts.footerRows, 1);
  assert.deepEqual([bl.counts.providerComplete, bl.counts.submitted, bl.counts.held, bl.counts.active], [9, 2, 4, 11]);
  assert.equal(bl.rows.length - 1 + bl.held.length, bl.counts.directoryRows, "every directory row is either active or held");
  assert.deepEqual(bl.held.map((h) => h.site), ["manta.com", "bing.com", "all.biz", "clutch.co"]);
  assert.deepEqual(bl.held.map((h) => h.row_number), [13, 14, 15, 16], "source spreadsheet rows");
});

test("Live / Updated → provider_complete, Submitted → submitted; Submitted is never an observation date", () => {
  const bl = prepareBrightLocalCampaign(table, { locationLabel: "Sample", campaign: "900001" });
  const status = Object.fromEntries(bl.rows.slice(1).map((r) => [r[1], r[3]]));
  assert.equal(status["us-info.com"], "provider_complete");
  assert.equal(status["maps.apple.com"], "submitted");
  assert.equal(status["yelp.com"], "submitted");
  assert.ok(bl.rows.slice(1).every((r) => /provider submitted 2025-11-11 \(not an observation date\)/.test(r[4])));
  const p = prepareImport(bl.rows, GENERIC_MAPPING, { mode: "single", locationId: LOC }, new Set([LOC]), "2026-10-20", (i) => bl.sourceRows[i]);
  assert.equal(p.accepted.length, 11);
  assert.equal(p.rejected.length, 0);
  assert.ok(p.accepted.every((r) => r.source_observed_on === null && r.observed_name === null && r.observed_phone === null), "no observation date or NAP");
  assert.deepEqual(p.accepted.map((r) => r.row_number), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(new Set(p.accepted.map((r) => `${r.directory}|${r.listing_url}`)).size, 11);
});

test("raw Notes are excluded: no fake credential or token reaches the import, the held reasons or the counts", () => {
  const bl = prepareBrightLocalCampaign(table, { locationLabel: "Sample", campaign: "900001" });
  const out = JSON.stringify(bl);
  for (const s of SECRETS) assert.ok(!out.includes(s), s);
  assert.ok(!out.includes("owner verification required"), "even innocuous raw notes are not carried");
  assert.equal(bl.counts.rawNotesExcluded, 10);
  assert.match(bl.held[0].reason, /^Held for review: BrightLocal campaign 900001 row 12 \(manta\.com\), CSV status Unavailable, provider submitted 2025-11-11\. Not a listing and not proof of absence\.$/);
  assert.match(bl.held[1].reason, /CSV status blank, no provider submitted date/);
});

test("reviewed safe summaries are added, and screened", () => {
  const bl = prepareBrightLocalCampaign(table, { locationLabel: "Sample", safeNotes: { 11: "Yelp needs owner phone verification" } });
  assert.match(bl.rows.find((r) => r[1] === "yelp.com")[4], /Yelp needs owner phone verification$/);
  assert.throws(() => prepareBrightLocalCampaign(table, { locationLabel: "Sample", safeNotes: { 1: "Password: Fake-Pass-0000" } }), (e) => !e.message.includes("Fake-Pass"));
});

test("only the real contract is accepted", () => {
  assert.ok(isBrightLocalCampaign(table[0]));
  assert.throws(() => prepareBrightLocalCampaign([["No", "Citation Site", "Status"], ["1", "yelp.com", "Live"]], { locationLabel: "x" }), /not a BrightLocal Citation Builder campaign export/);
  assert.throws(() => prepareBrightLocalCampaign(table, { locationLabel: "x", campaign: "abc" }), /campaign id/);
  assert.equal(brightLocalDate("11th Nov 2025"), "2025-11-11");
  assert.equal(brightLocalDate("2nd Sept 2025"), "2025-09-02");
  assert.equal(brightLocalDate("soon"), null);
});

test("content screening: recognizable credentials and tokenized links, not ordinary wording", () => {
  for (const t of ["Login: someone@example.test Password: Fake-Pass-0000", "password is Fake-0000", "PIN: 0000", "api key = FAKEKEY", "user name = fake-owner",
    "https://verify.example.test/confirm/AbCdEf0123456789SyntheticToken", "https://login.example.test/reset?token=FAKE0123456789abcdef",
    "https://app.example.test/x?code=FAKECODE12345", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ"])
    assert.ok(sensitiveContent(t), t);
  for (const t of ["owner verification required", "Ready for personal and phone verification", "Verification email not received", "Client login required for edits",
    "Pinned post", "https://www.us-info.com/en/usa/sample_solar_synthetic/sample_city/USKS000000000-5550100000/businessdetails.aspx",
    "https://ezlocal.com/ks/sample-city/solar-energy-contractors/0000000001", "https://www.facebook.com/profile.php?id=100000000000001"])
    assert.equal(sensitiveContent(t), null, t);
});

test("a generic import that maps a secret-bearing Notes column rejects those rows without echoing the value", () => {
  const p = prepareImport(table.slice(0, 16), { directory: 1, listing_url: 7, notes: 8 }, { mode: "single", locationId: LOC }, new Set([LOC]), "2026-10-20");
  const rejectedRows = p.rejected.map((r) => r.row_number);
  assert.deepEqual(rejectedRows, [2, 5, 10, 14]);
  assert.ok(p.rejected.every((r) => /Notes looks like it contains a login or a private account \/ verification link/.test(r.reason)));
  const out = JSON.stringify(p);
  for (const s of SECRETS) assert.ok(!out.includes(s), s);
  assert.ok(p.accepted.some((r) => r.notes === "owner verification required"), "innocuous notes still import");
});

test("manual form text is screened the same way", () => {
  const f = new FormData(); f.set("notes", "SYNTHETIC Password: Fake-Pass-0000"); f.set("evidence", "Owner verification required on the dashboard");
  assert.throws(() => citationText(f, "notes"), (e) => /login or a private account/.test(e.message) && !e.message.includes("Fake-Pass"));
  assert.equal(citationText(f, "evidence"), "Owner verification required on the dashboard");
});

// ── Serialization boundary: nothing recognized as a secret leaves through metadata ─
import { WITHHELD } from "../src/lib/citations-brightlocal.ts";
import { storedLocationMapping, storedFileName } from "../src/lib/citations.ts";
const FAKE = "SYNTHETIC_REVIEW_ONLY";
const row = (o) => { const r = ["", "", "General", "40", "Low", "", "", "", ""]; Object.entries(o).forEach(([i, v]) => { r[i] = v; }); return r; };

test("a held row's Status, Site or No never carries a recognized secret into reasons or counts", () => {
  const t = [table[0],
    row({ 0: "1", 1: "hotfrog.com", 5: "11th Nov 2025", 6: "Live", 7: "https://www.hotfrog.com/sample" }),
    row({ 0: "2", 1: "clutch.co", 6: `Password: ${FAKE}` }),
    row({ 0: "3", 1: `login=${FAKE}`, 6: "" }),
    row({ 0: `token: ${FAKE}`, 1: "manta.com", 6: "Unavailable" }),
    row({ 0: "5", 1: "all.biz", 6: "" }),
    ["Aggregator/Network"]];
  const bl = prepareBrightLocalCampaign(t, { locationLabel: "Sample", campaign: "900001" });
  assert.ok(!JSON.stringify(bl).includes(FAKE), "nothing in rows, held, counts or source rows");
  assert.deepEqual(bl.counts.byRawStatus, { Live: 1, [WITHHELD]: 1, "(blank)": 2, Unavailable: 1 }, "exact counts kept, secret key replaced");
  assert.equal(bl.counts.directoryRows, 5);
  assert.deepEqual(bl.held.map((h) => [h.row_number, h.site, h.raw_status]),
    [[3, "clutch.co", WITHHELD], [4, WITHHELD, "(blank)"], [5, "manta.com", "Unavailable"], [6, "all.biz", "(blank)"]]);
  assert.match(bl.held[2].reason, /row \? \(manta\.com\)/, "a non-numeric row number is never echoed");
  assert.match(bl.held[0].reason, /CSV status \(withheld: looked like a login or private link\)/);
});

test("stored location mapping keeps only screened values that point at a real location", () => {
  const m = storedLocationMapping({ mode: "column", values: { "Main (sample)": LOC, [`Password: ${FAKE}`]: LOC, "Typo": "not-a-location" } }, new Set([LOC]));
  assert.deepEqual(m, { mode: "column", values: { "Main (sample)": LOC }, withheld: 1 });
  assert.ok(!JSON.stringify(m).includes(FAKE));
  assert.deepEqual(storedLocationMapping({ mode: "single", locationId: LOC }, new Set([LOC])), { mode: "single", locationId: LOC });
  assert.equal(storedFileName(`export?token=${FAKE}1234.csv`), "import.csv (name withheld)");
  assert.equal(storedFileName("campaign-908272.csv"), "campaign-908272.csv");
});

test("a mapped header that looks like a secret is refused without echo", () => {
  assert.throws(() => prepareImport([["Directory", `https://x.example.test/a?token=${FAKE}`], ["Yelp", "x"]], { directory: 0, notes: 1 }, { mode: "single", locationId: LOC }, new Set([LOC])),
    (e) => /header looks like it contains a login/.test(e.message) && !e.message.includes(FAKE));
});
