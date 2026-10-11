// creative-lab (supabase/functions/creative-lab/handler.ts): the Creative
// Lab's read-only door. Fake store; the real handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCreativeLab, renderable, SIGNED_URL_SECONDS, PEOPLE_SUBJECTS } from "../supabase/functions/creative-lab/handler.ts";
import { PEOPLE_SUBJECTS as GOVERNED } from "../supabase/functions/creative-engine/govern.ts";

const CLIENT = "102d3b20-2795-44ae-bd64-d1e43916291c";
const asset = (over) => ({
  id: crypto.randomUUID(), kind: "photo", label: null, creative_use: "approved", depicts_own_work: true,
  subjects: ["roof"], focal_x: 0.5, focal_y: 0.5, width: 1200, height: 1600, content_hash: "h", storage_path: "p", ...over,
});
const ASSETS = [
  asset({ id: "roof", storage_path: "c/roof.jpg" }),
  asset({ id: "team", subjects: ["team member", "branded uniform"] }),
  asset({ id: "unreviewed", creative_use: "unreviewed" }),
  asset({ id: "excluded", creative_use: "excluded" }),
  asset({ id: "unhashed", content_hash: null }),
  asset({ id: "logo", kind: "logo_primary", subjects: ["logo"], storage_path: "c/logo.png" }),
  asset({ id: "icon", kind: "logo_icon" }),
];

function lab({ member = "m1", status = "active" } = {}) {
  const signed = [];
  const store = {
    secret: async () => "cron",
    caller: async (jwt) => (jwt === "team" ? { member } : jwt ? { member: null } : "none"),
    client: async (id) => (id === CLIENT ? { id, status } : null),
    assets: async () => ASSETS,
    sign: async (path, s) => { signed.push([path, s]); return `https://signed/${path}`; },
  };
  return { ...createCreativeLab({ store }), signed };
}
const post = (body, headers = { Authorization: "Bearer team" }) =>
  new Request("https://x/creative-lab", { method: "POST", headers, body: JSON.stringify(body) });

test("the people rule is govern.ts rule", () => {
  assert.equal(PEOPLE_SUBJECTS.source, GOVERNED.source);
  assert.equal(PEOPLE_SUBJECTS.flags, GOVERNED.flags);
});

test("renderable: approved, hashed, stored; no people; only the primary logo", () => {
  assert.deepEqual(ASSETS.filter(renderable).map((a) => a.id), ["roof", "logo"]);
});

test("sources signs only renderable assets, for five minutes, and writes nothing", async () => {
  const l = lab();
  const res = await l.handle(post({ mode: "sources", client_id: CLIENT }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.writes, false);
  assert.deepEqual(body.sources.map((s) => s.id), ["roof", "logo"]);
  assert.deepEqual(l.signed, [["c/roof.jpg", SIGNED_URL_SECONDS], ["c/logo.png", SIGNED_URL_SECONDS]]);
  assert.equal(SIGNED_URL_SECONDS, 300);
  assert.equal(body.sources[0].content_hash, "h");
});

test("only teammates or the operator door; no extra fields; no offboarded client", async () => {
  assert.equal((await lab().handle(post({ mode: "sources", client_id: CLIENT }, {}))).status, 401);
  assert.equal((await lab().handle(post({ mode: "sources", client_id: CLIENT }, { Authorization: "Bearer stranger" }))).status, 403);
  assert.equal((await lab().handle(post({ mode: "sources", client_id: CLIENT }, { "x-cron-secret": "cron" }))).status, 200);
  assert.equal((await lab().handle(post({ mode: "sources", client_id: CLIENT, path: "x" }))).status, 400);
  assert.equal((await lab().handle(post({ mode: "render", client_id: CLIENT }))).status, 400);
  assert.equal((await lab().handle(post({ mode: "sources", client_id: crypto.randomUUID() }))).status, 404);
  assert.equal((await lab({ status: "offboarded" }).handle(post({ mode: "sources", client_id: CLIENT }))).status, 409);
  const v = await (await lab().handle(post({ mode: "version" }))).json();
  assert.equal(v.writes, false);
});
