// Request-boundary tests for the claim-evidence Edge Function: the real handler
// (supabase/functions/claim-evidence/handler.ts) over a fake Supabase whose
// storage keeps bytes in memory and whose claim_evidence_register records
// what it was asked to register. No network. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createClaimEvidenceHandler,
  evidencePath,
  parsePath,
  sha256Hex,
  sniffMime,
} from "../supabase/functions/claim-evidence/handler.ts";

const CLIENT = "00000000-0000-4000-b000-00000000000a";
const OTHER = "00000000-0000-4000-b000-00000000000b";
const MEMBER = "00000000-0000-4000-c000-000000000001";
const PDF = Buffer.from("%PDF-1.4\n% fictional contract excerpt\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fictional capture")]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

function setup({ evidence = [], registerError = null } = {}) {
  const db = {
    team_members: [{ id: MEMBER, auth_user_id: "u-team" }],
    clients: [{ id: CLIENT }, { id: OTHER }],
    claim_evidence: [...evidence],
  };
  const objects = new Map();
  const calls = { signed: [], removed: [], rpc: [] };
  const supabase = {
    auth: {
      getUser: async (jwt) => ({ data: { user: jwt === "team-jwt" ? { id: "u-team" } : jwt === "client-jwt" ? { id: "u-client" } : null } }),
    },
    from(table) {
      const filters = {};
      const q = {
        select: () => q,
        eq: (k, v) => ((filters[k] = v), q),
        maybeSingle: async () => ({ data: db[table].find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null }),
      };
      return q;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path) => {
          if (objects.has(path)) return { data: null, error: { message: "The resource already exists" } };
          calls.signed.push(path);
          return { data: { token: "one-time-token", path }, error: null };
        },
        download: async (path) =>
          objects.has(path) ? { data: new Blob([objects.get(path)]), error: null } : { data: null, error: { message: "Object not found" } },
        remove: async (paths) => {
          for (const p of paths) { objects.delete(p); calls.removed.push(p); }
          return { data: [], error: null };
        },
      }),
    },
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (registerError) return { data: null, error: { message: registerError } };
      const row = { id: `ev-${db.claim_evidence.length + 1}`, client_id: args.p_client_id, sha256: args.p_sha256, storage_path: args.p_storage_path,
                    size_bytes: args.p_size, mime_type: args.p_mime, evidence_type: args.p_evidence_type, label: args.p_label,
                    source_url: args.p_source_url, captured_on: args.p_captured_on, uploaded_by: args.p_uploaded_by };
      db.claim_evidence.push(row);
      return { data: row, error: null };
    },
  };
  const handler = createClaimEvidenceHandler({ supabase, now: () => new Date("2026-11-04T18:00:00Z"), maxBytes: 1024 });
  const post = async (body, jwt = "team-jwt") => {
    const res = await handler(new Request("https://fn.local/claim-evidence", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  return { db, objects, calls, post, handler };
}

test("helpers: SHA-256, file types from bytes, the content address", async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sniffMime(PDF), "application/pdf");
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffMime(Buffer.from("<html>")), null);
  assert.equal(evidencePath(CLIENT, sha(PDF), "application/pdf"), `${CLIENT}/${sha(PDF)}.pdf`);
  assert.deepEqual(parsePath(`${CLIENT}/${sha(PNG)}.png`), { clientId: CLIENT, sha256: sha(PNG), ext: "png" });
  assert.equal(parsePath(`${CLIENT}/../${sha(PNG)}.png`), null);
  assert.equal(parsePath(`${CLIENT}/${sha(PNG)}.exe`), null);
});

test("auth: POST only; no session 401; a sign-in on no team row 403; nothing signed or stored", async () => {
  const t = setup();
  assert.equal((await t.handler(new Request("https://fn.local/claim-evidence"))).status, 405);
  assert.equal((await t.post({ mode: "prepare", client_id: CLIENT }, "nope")).status, 401);
  assert.equal((await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" }, "client-jwt")).status, 403);
  assert.deepEqual(t.calls, { signed: [], removed: [], rpc: [] });
});

test("prepare: validates, then signs a one-time upload for exactly <client>/<sha256>.<ext>", async () => {
  const t = setup();
  const base = { mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" };
  assert.equal((await t.post({ ...base, sha256: "abc" })).status, 400);
  assert.match((await t.post({ ...base, mime_type: "text/html" })).body.error, /PDF, PNG, JPEG or WebP/);
  assert.equal((await t.post({ ...base, size: 4096 })).status, 400);
  assert.equal((await t.post({ ...base, client_id: "00000000-0000-4000-b000-0000000000ff" })).status, 404);
  assert.equal((await t.post({ ...base, mode: "upload" })).status, 400);
  const r = await t.post(base);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "upload", path: `${CLIENT}/${sha(PDF)}.pdf`, token: "one-time-token" });
  assert.deepEqual(t.calls.signed, [`${CLIENT}/${sha(PDF)}.pdf`]);
});

test("prepare: the same bytes already registered for this client → exists; stored but unregistered → finalize it", async () => {
  const t = setup({ evidence: [{ id: "ev-0", client_id: CLIENT, sha256: sha(PDF) }] });
  const r = await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" });
  assert.deepEqual(r.body, { status: "exists", evidence: { id: "ev-0", client_id: CLIENT, sha256: sha(PDF) } });
  t.objects.set(`${CLIENT}/${sha(PNG)}.png`, PNG);
  const u = await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PNG), size: PNG.length, mime_type: "image/png" });
  assert.deepEqual(u.body, { status: "uploaded", path: `${CLIENT}/${sha(PNG)}.png` });
  assert.deepEqual(t.calls.signed, []);
});

test("finalize: re-hashes the stored bytes and registers them with the server's hash, size, type and uploader", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  t.objects.set(path, PDF);
  const r = await t.post({ mode: "finalize", client_id: CLIENT, path, evidence_type: "document", label: "Signed agreement, clause 7", original_name: "agreement.pdf" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "registered");
  assert.equal(t.calls.rpc.length, 1);
  assert.deepEqual(t.calls.rpc[0], {
    name: "claim_evidence_register",
    args: { p_client_id: CLIENT, p_storage_path: path, p_sha256: sha(PDF), p_size: PDF.length, p_mime: "application/pdf",
            p_evidence_type: "document", p_label: "Signed agreement, clause 7", p_uploaded_by: MEMBER,
            p_original_name: "agreement.pdf", p_source_url: null, p_captured_on: null },
  });
  assert.deepEqual(t.calls.removed, []);
});

test("finalize: bytes that do not match their address, or are not the type their name says, are deleted and refused", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  t.objects.set(path, Buffer.from("%PDF-1.4 different bytes"));
  const r = await t.post({ mode: "finalize", client_id: CLIENT, path, evidence_type: "document", label: "x" });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /do not match the address/);
  const png = `${CLIENT}/${sha(PNG)}.pdf`;
  t.objects.set(png, PNG);
  const p = await t.post({ mode: "finalize", client_id: CLIENT, path: png, evidence_type: "document", label: "x" });
  assert.equal(p.status, 422);
  assert.match(p.body.error, /not the PDF, PNG, JPEG or WebP its name says/);
  assert.deepEqual(t.calls.removed, [path, png]);
  assert.equal(t.calls.rpc.length, 0);
});

test("finalize: a capture needs its page URL and a capture day that is not in the future; the path must be this client's", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PNG)}.png`;
  t.objects.set(path, PNG);
  const base = { mode: "finalize", client_id: CLIENT, path, evidence_type: "capture", label: "Listing capture" };
  assert.match((await t.post(base)).body.error, /http\(s\) address/);
  assert.match((await t.post({ ...base, source_url: "https://listing.example.test/p", captured_on: "2026-11-05" })).body.error, /not a future day/);
  assert.equal((await t.post({ ...base, client_id: OTHER, source_url: "https://listing.example.test/p", captured_on: "2026-11-04" })).status, 400);
  assert.equal((await t.post({ ...base, evidence_type: "photo" })).status, 400);
  assert.equal((await t.post({ ...base, label: " " })).status, 400);
  const ok = await t.post({ ...base, source_url: "https://listing.example.test/p", captured_on: "2026-11-04" });
  assert.equal(ok.body.status, "registered");
  assert.equal(t.calls.rpc[0].args.p_source_url, "https://listing.example.test/p");
  assert.equal(t.calls.rpc[0].args.p_captured_on, "2026-11-04");
  assert.equal(t.calls.rpc[0].args.p_mime, "image/png");
});

test("finalize: nothing uploaded → 404; the database refusing the record → 422 and the file removed", async () => {
  const t = setup({ registerError: "The stored file is image/jpeg, not application/pdf" });
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  assert.equal((await t.post({ mode: "finalize", client_id: CLIENT, path, evidence_type: "document", label: "x" })).status, 404);
  t.objects.set(path, PDF);
  const r = await t.post({ mode: "finalize", client_id: CLIENT, path, evidence_type: "document", label: "x" });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /image\/jpeg/);
  assert.deepEqual(t.calls.removed, [path]);
});

test("check: re-hashes a registered file: intact, mismatch, missing", async () => {
  const id = "00000000-0000-4000-d000-000000000001";
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  const t = setup({ evidence: [{ id, client_id: CLIENT, sha256: sha(PDF), storage_path: path }] });
  assert.equal((await t.post({ mode: "check", evidence_id: "x" })).status, 400);
  assert.equal((await t.post({ mode: "check", evidence_id: "00000000-0000-4000-d000-0000000000ff" })).status, 404);
  assert.equal((await t.post({ mode: "check", evidence_id: id })).body.status, "missing");
  t.objects.set(path, PDF);
  const ok = await t.post({ mode: "check", evidence_id: id });
  assert.equal(ok.body.status, "intact");
  assert.equal(ok.body.actual_sha256, sha(PDF));
  assert.equal(ok.body.checked_at, "2026-11-04T18:00:00.000Z");
  t.objects.set(path, Buffer.from("%PDF-1.4 tampered"));
  assert.equal((await t.post({ mode: "check", evidence_id: id })).body.status, "mismatch");
});
