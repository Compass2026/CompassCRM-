// Unit tests for the vercel.json merge and its guards. The request-boundary
// behaviour (what actually reaches GitHub) is in site-push-handler.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVercelConfig,
  guardVercelConfigRequest,
  isVercelConfigPath,
  withVercelConfigFirst,
} from "../supabase/functions/site-push/vercel-config.ts";

const parse = (r) => {
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return JSON.parse(r.content);
};

test("no vercel.json yet: the file is created with the property and nothing else", () => {
  const r = buildVercelConfig(null);
  assert.deepEqual(parse(r), { git: { deploymentEnabled: false } });
  assert.equal(r.changed, true);
  assert.match(r.content, /\n$/, "files end with a newline");
});

test("every existing setting survives the merge", () => {
  const existing = JSON.stringify({
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "nextjs",
    redirects: [{ source: "/old", destination: "/new", permanent: true }],
    headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
    regions: ["iad1"],
    functions: { "api/lead.ts": { memory: 1024 } },
  }, null, 2);
  const out = parse(buildVercelConfig(existing));
  assert.equal(out.framework, "nextjs");
  assert.deepEqual(out.redirects, [{ source: "/old", destination: "/new", permanent: true }]);
  assert.equal(out.headers[0].headers[0].key, "X-Frame-Options");
  assert.deepEqual(out.regions, ["iad1"]);
  assert.deepEqual(out.functions, { "api/lead.ts": { memory: 1024 } });
  assert.equal(out.$schema, "https://openapi.vercel.sh/vercel.json");
  assert.equal(out.git.deploymentEnabled, false);
});

test("sibling keys under git are kept", () => {
  const out = parse(buildVercelConfig(JSON.stringify({ git: { deploymentEnabled: true } })));
  assert.equal(out.git.deploymentEnabled, false, "true is turned off, not preserved");

  const out2 = parse(buildVercelConfig(JSON.stringify({ git: { deploymentEnabled: { dev: false } } })));
  assert.equal(out2.git.deploymentEnabled, false, "a per-branch map is replaced by a blanket false");
});

test("an already-compliant file is reported unchanged", () => {
  const r = buildVercelConfig(JSON.stringify({ framework: "astro", git: { deploymentEnabled: false } }, null, 2));
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(parse(r).framework, "astro");
});

test("unparseable, empty or non-object vercel.json refuses rather than overwriting", () => {
  for (const [bad, why] of [
    ["{ not json", "truncated"],
    ["", "empty"],
    ["   ", "whitespace"],
    ["[]", "array"],
    ['"a string"', "string"],
    ["null", "null"],
  ]) {
    const r = buildVercelConfig(bad);
    assert.equal(r.ok, false, `${why} must refuse`);
    assert.match(r.error, /vercel\.json/);
  }
});

test("a git key that is not an object refuses — merging it would guess", () => {
  for (const bad of ['{"git":"on"}', '{"git":[]}', '{"git":3}']) {
    const r = buildVercelConfig(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /"git" must be an object/);
  }
});

test("a push may not delete vercel.json", () => {
  for (const path of ["vercel.json", "./vercel.json"]) {
    const r = guardVercelConfigRequest([], [path]);
    assert.equal(r.ok, false);
    assert.match(r.error, /may not be deleted/);
  }
});

test("a push may not turn the Git integration back on", () => {
  for (const on of [true, { main: true }, "yes", 1]) {
    const r = guardVercelConfigRequest([{ path: "vercel.json", content: JSON.stringify({ git: { deploymentEnabled: on } }) }], []);
    assert.equal(r.ok, false, `deploymentEnabled ${JSON.stringify(on)} must refuse`);
    assert.match(r.error, /may not set git\.deploymentEnabled/);
  }
});

test("a caller may still send its own vercel.json, and it is merged not rejected", () => {
  const supplied = { path: "vercel.json", content: JSON.stringify({ redirects: [{ source: "/a", destination: "/b" }] }) };
  assert.equal(guardVercelConfigRequest([supplied], []).ok, true);
  const out = parse(buildVercelConfig(supplied.content));
  assert.deepEqual(out.redirects, [{ source: "/a", destination: "/b" }]);
  assert.equal(out.git.deploymentEnabled, false);

  // Explicitly false is fine too.
  assert.equal(guardVercelConfigRequest([{ path: "vercel.json", content: '{"git":{"deploymentEnabled":false}}' }], []).ok, true);
});

test("a supplied vercel.json that is not valid JSON refuses", () => {
  const r = guardVercelConfigRequest([{ path: "vercel.json", content: "{oops" }], []);
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
});

test("a base64 vercel.json is decoded before it is judged", () => {
  const b64 = Buffer.from('{"git":{"deploymentEnabled":true}}').toString("base64");
  const r = guardVercelConfigRequest([{ path: "vercel.json", content: b64, encoding: "base64" }], []);
  assert.equal(r.ok, false, "base64 must not be a way past the guard");
  assert.match(r.error, /may not set git\.deploymentEnabled/);
});

test("the config goes first and replaces any caller copy", () => {
  const files = [{ path: "a.ts", content: "a" }, { path: "vercel.json", content: "{}" }, { path: "b.ts", content: "b" }];
  const out = withVercelConfigFirst(files, '{"git":{"deploymentEnabled":false}}\n');
  assert.deepEqual(out.map((f) => f.path), ["vercel.json", "a.ts", "b.ts"]);
  assert.equal(out.filter((f) => f.path === "vercel.json").length, 1);
  assert.match(out[0].content, /deploymentEnabled/);
});

test("path matching ignores a leading ./", () => {
  assert.equal(isVercelConfigPath("vercel.json"), true);
  assert.equal(isVercelConfigPath("./vercel.json"), true);
  assert.equal(isVercelConfigPath("app/vercel.json"), false);
  assert.equal(isVercelConfigPath("vercel.jsonc"), false);
});
