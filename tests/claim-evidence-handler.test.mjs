// Request-boundary tests for the claim-evidence Edge Function: the real handler
// (supabase/functions/claim-evidence/handler.ts) over a fake Supabase whose
// storage keeps bytes in memory, whose claim_evidence_request_upload (called
// as the user) stamps the requester from the JWT, and whose
// claim_evidence_register records what it was asked to register. No network.
// Fictional data only.
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
const MEMBER2 = "00000000-0000-4000-c000-000000000002";
const PDF = Buffer.from("%PDF-1.4\n% fictional contract excerpt\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fictional capture")]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

const USERS = { "team-jwt": "u-team", "team2-jwt": "u-team2", "client-jwt": "u-client" };

function setup({ evidence = [], registerError = null, requestError = null } = {}) {
  const db = {
    team_members: [{ id: MEMBER, auth_user_id: "u-team" }, { id: MEMBER2, auth_user_id: "u-team2" }],
    clients: [{ id: CLIENT }, { id: OTHER }],
    claim_evidence: [...evidence],
    claim_evidence_uploads: [],
  };
  const objects = new Map();
  const calls = { signed: [], removed: [], rpc: [], userRpc: [] };
  // What the database does for claim_evidence_request_upload: the requester
  // is whoever the JWT says, never an argument.
  const userClient = (jwt) => ({
    rpc: async (name, args) => {
      calls.userRpc.push({ jwt, name, args });
      if (requestError) return { data: null, error: requestError };
      const member = db.team_members.find((m) => m.auth_user_id === USERS[jwt]);
      const id = `00000000-0000-4000-e000-${String(db.claim_evidence_uploads.length + 1).padStart(12, "0")}`;
      db.claim_evidence_uploads.push({ id, client_id: args.p_client_id, sha256: args.p_sha256, mime_type: args.p_mime, requested_by: member.id });
      return { data: id, error: null };
    },
  });
  const supabase = {
    auth: {
      getUser: async (jwt) => ({ data: { user: USERS[jwt] ? { id: USERS[jwt] } : null } }),
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
      const up = db.claim_evidence_uploads.find((u) => u.id === args.p_upload_id);
      const row = { id: `ev-${db.claim_evidence.length + 1}`, client_id: up.client_id, sha256: args.p_sha256, storage_path: args.p_storage_path,
                    size_bytes: args.p_size, mime_type: args.p_mime, evidence_type: args.p_evidence_type, label: args.p_label,
                    source_url: args.p_source_url, captured_on: args.p_captured_on, uploaded_by: up.requested_by, upload_id: up.id };
      db.claim_evidence.push(row);
      return { data: row, error: null };
    },
  };
  const handler = createClaimEvidenceHandler({ supabase, userClient, now: () => new Date("2026-11-04T18:00:00Z"), maxBytes: 1024 });
  const post = async (body, jwt = "team-jwt") => {
    const res = await handler(new Request("https://fn.local/claim-evidence", {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  // An upload request as prepare records it (the requester from the JWT).
  const request = async (bytes, mime, jwt = "team-jwt") => {
    const r = await post({ mode: "prepare", client_id: CLIENT, sha256: sha(bytes), size: bytes.length, mime_type: mime }, jwt);
    return r.body.upload_id;
  };
  return { db, objects, calls, post, handler, request };
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
  assert.deepEqual(t.calls, { signed: [], removed: [], rpc: [], userRpc: [] });
});

test("prepare: validates, records the upload request from the caller's own session, then signs a one-time upload for exactly <client>/<sha256>.<ext>", async () => {
  const t = setup();
  const base = { mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" };
  assert.equal((await t.post({ ...base, sha256: "abc" })).status, 400);
  assert.match((await t.post({ ...base, mime_type: "text/html" })).body.error, /PDF, PNG, JPEG or WebP/);
  assert.equal((await t.post({ ...base, size: 4096 })).status, 400);
  assert.equal((await t.post({ ...base, client_id: "00000000-0000-4000-b000-0000000000ff" })).status, 404);
  assert.equal((await t.post({ ...base, mode: "upload" })).status, 400);
  const r = await t.post(base);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "upload", path: `${CLIENT}/${sha(PDF)}.pdf`, token: "one-time-token", upload_id: t.db.claim_evidence_uploads[0].id });
  assert.deepEqual(t.calls.signed, [`${CLIENT}/${sha(PDF)}.pdf`]);
  // The request went out with the caller's JWT and names nobody: the database stamps the requester.
  assert.deepEqual(t.calls.userRpc, [{ jwt: "team-jwt", name: "claim_evidence_request_upload",
    args: { p_client_id: CLIENT, p_sha256: sha(PDF), p_size: PDF.length, p_mime: "application/pdf" } }]);
  assert.equal(t.db.claim_evidence_uploads[0].requested_by, MEMBER);
});

test("prepare: the database refusing the upload request (not the caller's own session) → 403, nothing signed", async () => {
  const t = setup({ requestError: { code: "42501", message: "Only a signed-in teammate uploads claim evidence" } });
  const r = await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /signed-in teammate/);
  assert.deepEqual(t.calls.signed, []);
});

test("prepare: the same bytes already registered for this client → exists; stored but unregistered → finalize it", async () => {
  const t = setup({ evidence: [{ id: "ev-0", client_id: CLIENT, sha256: sha(PDF) }] });
  const r = await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" });
  assert.deepEqual(r.body, { status: "exists", evidence: { id: "ev-0", client_id: CLIENT, sha256: sha(PDF) } });
  t.objects.set(`${CLIENT}/${sha(PNG)}.png`, PNG);
  const u = await t.post({ mode: "prepare", client_id: CLIENT, sha256: sha(PNG), size: PNG.length, mime_type: "image/png" });
  assert.deepEqual(u.body, { status: "uploaded", path: `${CLIENT}/${sha(PNG)}.png`, upload_id: t.db.claim_evidence_uploads[0].id });
  assert.deepEqual(t.calls.signed, []);
});

test("finalize: re-hashes the stored bytes and registers them against the caller's upload request (the uploader is the request's)", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  const upload_id = await t.request(PDF, "application/pdf");
  t.objects.set(path, PDF);
  const r = await t.post({ mode: "finalize", client_id: CLIENT, upload_id, path, evidence_type: "document", label: "Signed agreement, clause 7", original_name: "agreement.pdf" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "registered");
  assert.equal(t.calls.rpc.length, 1);
  assert.deepEqual(t.calls.rpc[0], {
    name: "claim_evidence_register",
    args: { p_upload_id: upload_id, p_storage_path: path, p_sha256: sha(PDF), p_size: PDF.length, p_mime: "application/pdf",
            p_evidence_type: "document", p_label: "Signed agreement, clause 7",
            p_original_name: "agreement.pdf", p_source_url: null, p_captured_on: null },
  });
  assert.equal(r.body.evidence.uploaded_by, MEMBER);
  assert.deepEqual(t.calls.removed, []);
});

test("finalize: no upload request, a request for other bytes, or another teammate's request → refused, nothing registered or removed", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  const mine = await t.request(PDF, "application/pdf");
  const forPng = await t.request(PNG, "image/png");
  const theirs = await t.request(PDF, "application/pdf", "team2-jwt");
  t.objects.set(path, PDF);
  const base = { mode: "finalize", client_id: CLIENT, path, evidence_type: "document", label: "x" };
  assert.equal((await t.post(base)).status, 400);
  assert.equal((await t.post({ ...base, upload_id: "00000000-0000-4000-e000-0000000000ff" })).status, 404);
  assert.equal((await t.post({ ...base, upload_id: forPng })).status, 404);
  assert.equal((await t.post({ ...base, client_id: OTHER, path: `${OTHER}/${sha(PDF)}.pdf`, upload_id: mine })).status, 404);
  const other = await t.post({ ...base, upload_id: theirs });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /Another teammate/);
  assert.equal(t.calls.rpc.length, 0);
  assert.deepEqual(t.calls.removed, []);
  assert.equal((await t.post({ ...base, upload_id: theirs }, "team2-jwt")).body.evidence.uploaded_by, MEMBER2);
});

test("finalize: bytes that do not match their address, or are not the type their name says, are deleted and refused", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PDF)}.pdf`;
  const upload_id = await t.request(PDF, "application/pdf");
  t.objects.set(path, Buffer.from("%PDF-1.4 different bytes"));
  const r = await t.post({ mode: "finalize", client_id: CLIENT, upload_id, path, evidence_type: "document", label: "x" });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /do not match the address/);
  const png = `${CLIENT}/${sha(PNG)}.pdf`;
  const pngAsPdf = await t.request(PNG, "application/pdf");
  t.objects.set(png, PNG);
  const p = await t.post({ mode: "finalize", client_id: CLIENT, upload_id: pngAsPdf, path: png, evidence_type: "document", label: "x" });
  assert.equal(p.status, 422);
  assert.match(p.body.error, /not the PDF, PNG, JPEG or WebP its name says/);
  assert.deepEqual(t.calls.removed, [path, png]);
  assert.equal(t.calls.rpc.length, 0);
});

test("finalize: a capture needs its page URL and a capture day that is not in the future; the path must be this client's", async () => {
  const t = setup();
  const path = `${CLIENT}/${sha(PNG)}.png`;
  const upload_id = await t.request(PNG, "image/png");
  t.objects.set(path, PNG);
  const base = { mode: "finalize", client_id: CLIENT, upload_id, path, evidence_type: "capture", label: "Listing capture" };
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
  const upload_id = await t.request(PDF, "application/pdf");
  assert.equal((await t.post({ mode: "finalize", client_id: CLIENT, upload_id, path, evidence_type: "document", label: "x" })).status, 404);
  t.objects.set(path, PDF);
  const r = await t.post({ mode: "finalize", client_id: CLIENT, upload_id, path, evidence_type: "document", label: "x" });
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
