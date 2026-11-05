// Claim evidence against REAL Supabase Storage (20261104200000; ChatGPT's
// second PR2a review, check 1). Not part of `npm test`: it needs a running,
// nonproduction Supabase stack with every migration replayed and the
// claim-evidence function served on the Edge runtime, e.g. a local stack:
//
//   supabase start                                   # a throwaway project dir
//   (replay supabase/migrations/*.sql as postgres, as the sandbox does)
//   supabase functions serve claim-evidence          # the real Deno handler
//   CLAIM_EVIDENCE_STACK_URL=http://127.0.0.1:55421 \
//   CLAIM_EVIDENCE_STACK_ANON_KEY=… CLAIM_EVIDENCE_STACK_SERVICE_KEY=… \
//   CLAIM_EVIDENCE_STACK_DB_URL=postgresql://supabase_admin:…@127.0.0.1:55422/postgres \
//   node tests/claim-evidence-storage-integration.mjs
//
// It refuses to run against the production project. Everything it creates is
// fictional (a client, four sign-ins, three small files) and it removes all of
// it at the end: the client delete cascades through the evidence rows, then
// the now-unregistered files are deleted through the Storage API.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL_ = process.env.CLAIM_EVIDENCE_STACK_URL;
const ANON = process.env.CLAIM_EVIDENCE_STACK_ANON_KEY;
const SERVICE = process.env.CLAIM_EVIDENCE_STACK_SERVICE_KEY;
const DB_URL = process.env.CLAIM_EVIDENCE_STACK_DB_URL;
const FN = process.env.CLAIM_EVIDENCE_STACK_FN_URL ?? `${URL_}/functions/v1/claim-evidence`;
if (!URL_ || !ANON || !SERVICE || !DB_URL) {
  console.log("claim-evidence storage integration: skipped (no CLAIM_EVIDENCE_STACK_* environment)");
  process.exit(0);
}
if (/iokcopiyzajigvhwexhe/.test(URL_ + DB_URL)) throw new Error("Refusing to run against the production project");

const BUCKET = "claim-evidence";
const CLIENT = "0e5a0000-0000-4000-b000-00000000a2a1";
const run = randomBytes(4).toString("hex");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PDF = Buffer.from(`%PDF-1.4\n% fictional signed agreement, clause 7 (${run})\n%%EOF\n`);
const PDF_B = Buffer.from(`%PDF-1.4\n% different fictional bytes (${run})\n%%EOF\n`);
const HTML = Buffer.from(`<html><body>not a pdf (${run})</body></html>`);
const path = (b, ext = "pdf") => `${CLIENT}/${sha(b)}.${ext}`;

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

const results = [];
const ok = (label) => (results.push(label), console.log(`  ✔ ${label}`));

// ── Fixtures: a fictional client, two teammates, a portal contact, a stranger ─
const people = {
  ari: { email: `pr2a-storage-ari-${run}@compassmarketing.ai`, name: "Ari Uploader (fictional)" },
  vera: { email: `pr2a-storage-vera-${run}@compassmarketing.ai`, name: "Vera Teammate (fictional)" },
  pat: { email: `pr2a-storage-pat-${run}@example.test`, name: "Pat Portal (fictional)" },
  sam: { email: `pr2a-storage-sam-${run}@example.test`, name: "Sam Stranger (fictional)" },
};
async function cleanup() {
  // The client delete cascades through uploads and evidence; then the files
  // are no longer registered and the Storage API may delete them.
  await q("delete from clients where id = $1", [CLIENT]);
  const { data: left } = await service.storage.from(BUCKET).list(CLIENT, { limit: 100 });
  if (left?.length) await service.storage.from(BUCKET).remove(left.map((o) => `${CLIENT}/${o.name}`));
  await q("delete from team_members where email = any($1)", [[people.ari.email, people.vera.email]]);
  for (const p of Object.values(people)) if (p.id) await service.auth.admin.deleteUser(p.id);
}

try {
  await q("delete from clients where id = $1", [CLIENT]);
  await q("insert into clients (id, name) values ($1, 'Fictional Storage Roofing Co')", [CLIENT]);
  for (const p of Object.values(people)) {
    p.password = randomBytes(18).toString("base64url");
    const { data, error } = await service.auth.admin.createUser({ email: p.email, password: p.password, email_confirm: true });
    if (error) throw error;
    p.id = data.user.id;
  }
  await q("insert into team_members (name, email, role) values ($1, $2, 'member'), ($3, $4, 'member')",
    [people.ari.name, people.ari.email, people.vera.name, people.vera.email]);
  await q("insert into portal_users (client_id, email, name) values ($1, $2, $3)", [CLIENT, people.pat.email, people.pat.name]);
  const members = await q("select id, email, auth_user_id from team_members where email = any($1)", [[people.ari.email, people.vera.email]]);
  assert.equal(members.length, 2);
  for (const m of members) {
    const p = Object.values(people).find((x) => x.email === m.email);
    p.member = m.id;
    assert.equal(m.auth_user_id, p.id);
  }
  for (const p of Object.values(people)) {
    const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await c.auth.signInWithPassword({ email: p.email, password: p.password });
    if (error) throw error;
    p.jwt = data.session.access_token;
    p.client = createClient(URL_, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${p.jwt}` } },
    });
  }
  const call = async (body, jwt) => {
    const res = await fetch(FN, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ANON, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const object = async (name) => (await q("select id, name, version, metadata from storage.objects where bucket_id = $1 and name = $2", [BUCKET, name]))[0];
  const download = async (client, name) => {
    const { data, error } = await client.storage.from(BUCKET).download(name);
    return error || !data ? null : Buffer.from(await data.arrayBuffer());
  };

  console.log(`claim-evidence against real Storage at ${URL_} (run ${run})`);

  // ── 1. Who may use the function ────────────────────────────────────────────
  const prep = { mode: "prepare", client_id: CLIENT, sha256: sha(PDF), size: PDF.length, mime_type: "application/pdf" };
  assert.equal((await call(prep)).status, 401);
  assert.equal((await call(prep, people.sam.jwt)).status, 403);
  assert.equal((await call(prep, people.pat.jwt)).status, 403);
  ok("the function refuses no sign-in (401), a sign-in on no team row and a portal contact (403)");

  // ── 2. Prepare: the upload request is written from the teammate's own session
  const p1 = await call(prep, people.ari.jwt);
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.status, "upload");
  assert.equal(p1.body.path, path(PDF));
  const [req1] = await q("select requested_by, client_id, sha256, size_bytes, mime_type, expires_at > now() as live from claim_evidence_uploads where id = $1", [p1.body.upload_id]);
  assert.deepEqual(req1, { requested_by: people.ari.member, client_id: CLIENT, sha256: sha(PDF), size_bytes: String(PDF.length), mime_type: "application/pdf", live: true });
  ok("prepare records the upload request with the requester taken from the caller's own JWT, and signs a one-time upload for the content address");

  // ── 3. The request RPC and the register RPC, called directly ───────────────
  const reqArgs = { p_client_id: CLIENT, p_sha256: sha(PDF), p_size: PDF.length, p_mime: "application/pdf" };
  for (const who of ["pat", "sam"]) {
    const { error } = await people[who].client.rpc("claim_evidence_request_upload", reqArgs);
    assert.equal(error?.code, "42501", `${who}: ${JSON.stringify(error)}`);
  }
  assert.ok((await service.rpc("claim_evidence_request_upload", reqArgs)).error, "the service role cannot write an upload request");
  assert.ok((await anon.rpc("claim_evidence_request_upload", reqArgs)).error, "anon cannot write an upload request");
  const regArgs = { p_upload_id: p1.body.upload_id, p_storage_path: path(PDF), p_sha256: sha(PDF), p_size: PDF.length, p_mime: "application/pdf", p_evidence_type: "document", p_label: "x" };
  const direct = await people.ari.client.rpc("claim_evidence_register", regArgs);
  assert.equal(direct.error?.code, "42501", JSON.stringify(direct.error));
  ok("upload requests come only from a teammate's session (portal contact, stranger, service role and anon refused); a teammate cannot call the register");

  // ── 4. Direct writes to the bucket are refused ─────────────────────────────
  for (const who of ["ari", "pat"]) {
    const { error } = await people[who].client.storage.from(BUCKET).upload(path(PDF), PDF, { contentType: "application/pdf" });
    assert.ok(error, `${who} wrote the bucket directly`);
  }
  assert.equal(await object(path(PDF)), undefined);
  ok("a teammate and a portal contact cannot write the bucket without the function's signed upload");

  // ── 5. The signed upload, as the browser does it ───────────────────────────
  const up = await people.ari.client.storage.from(BUCKET).uploadToSignedUrl(p1.body.path, p1.body.token, PDF, { contentType: "application/pdf" });
  assert.equal(up.error, null, up.error?.message);
  const o1 = await object(path(PDF));
  assert.ok(o1?.version, "Storage records an object version");
  assert.equal(o1.metadata.size, PDF.length);
  assert.equal(o1.metadata.mimetype, "application/pdf");
  assert.ok(o1.metadata.eTag);
  const reuse = await people.ari.client.storage.from(BUCKET).uploadToSignedUrl(p1.body.path, p1.body.token, PDF_B, { contentType: "application/pdf" });
  assert.ok(reuse.error, "the signed upload token wrote a second time");
  assert.equal(sha(await download(service, path(PDF))), sha(PDF));
  ok(`the signed upload stores the bytes; Storage records version ${o1.version.slice(0, 8)}…, size ${o1.metadata.size}, type and eTag; the token cannot overwrite them`);

  // ── 6. Finalize: the function re-hashes the stored bytes and registers them ─
  const finBase = { mode: "finalize", client_id: CLIENT, upload_id: p1.body.upload_id, path: path(PDF), evidence_type: "document", label: "Signed agreement, clause 7 (fictional)", original_name: "agreement.pdf" };
  assert.equal((await call(finBase, people.vera.jwt)).status, 403);
  const f1 = await call(finBase, people.ari.jwt);
  assert.equal(f1.status, 200, JSON.stringify(f1.body));
  const [ev] = await q("select id, sha256, size_bytes, mime_type, object_id, object_version, object_etag, uploaded_by, upload_id from claim_evidence where storage_path = $1", [path(PDF)]);
  assert.equal(ev.sha256, sha(PDF));
  assert.equal(ev.object_id, o1.id);
  assert.equal(ev.object_version, o1.version);
  assert.equal(ev.object_etag, o1.metadata.eTag);
  assert.equal(ev.uploaded_by, people.ari.member);
  assert.equal(ev.upload_id, p1.body.upload_id);
  const chk = await call({ mode: "check", evidence_id: ev.id }, people.vera.jwt);
  assert.deepEqual([chk.body.status, chk.body.actual_sha256], ["intact", sha(PDF)]);
  const [intact] = await q("select claim_evidence_intact(e) as v from claim_evidence e where id = $1", [ev.id]);
  assert.equal(intact.v, true);
  ok("finalize re-hashes the stored bytes and registers them: SHA-256, object id, version and eTag pinned, uploader from the request (another teammate's finalize refused 403); check re-hashes them intact");

  // ── 7. A registered file cannot be overwritten, moved or deleted ───────────
  const before = await object(path(PDF));
  const upsert = await service.storage.from(BUCKET).upload(path(PDF), PDF_B, { contentType: "application/pdf", upsert: true });
  assert.ok(upsert.error, "the service role overwrote a registered file (upsert)");
  const update = await service.storage.from(BUCKET).update(path(PDF), PDF_B, { contentType: "application/pdf" });
  assert.ok(update.error, "the service role overwrote a registered file (update)");
  const move = await service.storage.from(BUCKET).move(path(PDF), `${CLIENT}/moved.pdf`);
  assert.ok(move.error, "the service role moved a registered file");
  const removeTeam = await people.ari.client.storage.from(BUCKET).remove([path(PDF)]);
  const removeService = await service.storage.from(BUCKET).remove([path(PDF)]);
  const after = await object(path(PDF));
  assert.deepEqual(after, before, "the storage row changed");
  assert.equal(sha(await download(service, path(PDF))), sha(PDF), "the stored bytes changed");
  const chk2 = await call({ mode: "check", evidence_id: ev.id }, people.ari.jwt);
  assert.equal(chk2.body.status, "intact");
  ok(`overwrite (upsert: ${upsert.error.message}; update: ${update.error.message}), move (${move.error.message}) and delete (teammate: ${removeTeam.error?.message ?? `${removeTeam.data?.length ?? 0} removed`}; service role: ${removeService.error?.message ?? `${removeService.data?.length ?? 0} removed`}) are all refused; the row, version and bytes are unchanged and still hash intact`);

  // ── 8. Who can read the file ───────────────────────────────────────────────
  assert.equal(sha(await download(people.vera.client, path(PDF))), sha(PDF));
  assert.equal(await download(anon, path(PDF)), null);
  assert.equal(await download(people.sam.client, path(PDF)), null);
  assert.equal(await download(people.pat.client, path(PDF)), null);
  const { data: patList } = await people.pat.client.storage.from(BUCKET).list(CLIENT);
  assert.equal(patList?.length ?? 0, 0);
  const { data: patRows } = await people.pat.client.from("claim_evidence").select("id");
  const { data: patReq } = await people.pat.client.from("claim_evidence_uploads").select("id");
  assert.equal(patRows?.length ?? 0, 0);
  assert.equal(patReq?.length ?? 0, 0);
  const { data: pub } = service.storage.from(BUCKET).getPublicUrl(path(PDF));
  assert.notEqual((await fetch(pub.publicUrl)).status, 200);
  ok("a teammate reads the file; anon, a stranger and a portal contact cannot download, list or see its rows; the bucket has no public URL");

  // ── 9. Bytes that do not match their address are deleted ───────────────────
  const p2 = await call({ ...prep, sha256: sha(PDF_B), size: PDF_B.length }, people.ari.jwt);
  assert.equal(p2.body.status, "upload");
  const wrong = Buffer.from(PDF_B.toString().replace("different", "tampered!"));
  assert.equal(wrong.length, PDF_B.length);
  assert.equal((await people.ari.client.storage.from(BUCKET).uploadToSignedUrl(p2.body.path, p2.body.token, wrong, { contentType: "application/pdf" })).error, null);
  assert.ok(await object(path(PDF_B)));
  const f2 = await call({ ...finBase, upload_id: p2.body.upload_id, path: path(PDF_B) }, people.ari.jwt);
  assert.equal(f2.status, 422);
  assert.match(f2.body.error, /do not match/);
  assert.equal(await object(path(PDF_B)), undefined);
  assert.equal(await download(service, path(PDF_B)), null);
  assert.equal((await q("select count(*)::int n from claim_evidence where sha256 = $1", [sha(PDF_B)]))[0].n, 0);
  ok("bytes uploaded under another file's hash are refused (422) and deleted from Storage; nothing is registered");

  // ── 10. A file that is not the type it claims is deleted ───────────────────
  const p3 = await call({ ...prep, sha256: sha(HTML), size: HTML.length }, people.ari.jwt);
  assert.equal((await people.ari.client.storage.from(BUCKET).uploadToSignedUrl(p3.body.path, p3.body.token, HTML, { contentType: "application/pdf" })).error, null);
  const f3 = await call({ ...finBase, upload_id: p3.body.upload_id, path: path(HTML) }, people.ari.jwt);
  assert.equal(f3.status, 422);
  assert.match(f3.body.error, /not the PDF, PNG, JPEG or WebP/);
  assert.equal(await object(path(HTML)), undefined);
  ok("an HTML file sent as a PDF is refused from its bytes (422) and deleted from Storage");

  // ── 11. The same bytes again: no second file, no second row ────────────────
  const p4 = await call(prep, people.vera.jwt);
  assert.equal(p4.body.status, "exists");
  assert.equal(p4.body.evidence.id, ev.id);
  ok("the same bytes for the same client return the registered row; nothing is uploaded twice");

  // ── 12. Cleanup: the client delete cascades, then Storage deletes the files ─
  await cleanup();
  assert.equal((await q("select count(*)::int n from storage.objects where bucket_id = $1 and name like $2", [BUCKET, `${CLIENT}/%`]))[0].n, 0);
  assert.equal((await q("select count(*)::int n from claim_evidence where client_id = $1", [CLIENT]))[0].n, 0);
  assert.equal((await q("select count(*)::int n from claim_evidence_uploads where client_id = $1", [CLIENT]))[0].n, 0);
  for (const p of Object.values(people)) p.id = null;
  ok("cleanup: deleting the client cascades through its uploads and evidence rows, after which Storage deletes the files; nothing fictional is left");

  console.log(`claim-evidence storage integration passed (${results.length}).`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup().catch((e) => console.error("cleanup:", e.message));
  await db.end();
}
