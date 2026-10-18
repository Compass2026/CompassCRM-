import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import {
  mapTask,
  parseMapsTask,
  validateGrid,
} from "../supabase/functions/_shared/map-grid.ts";
const source = ts.transpileModule(
  readFileSync("supabase/functions/map-grid-sync/index.ts", "utf8").replace(
    /^import [\s\S]*?;\n/gm,
    "",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;
const uuid = "00000000-0000-4000-a000-000000000001";
function harness({ member = true, user = true, postFailure = false, geometry } = {}) {
  let handler,
    posts = 0,
    gets = 0,
    starts = 0;
  const background = [];
  const config = {
    id: "profile",
    target_place_id: "ChIJfixture",
    zoom: 13,
    search_this_area: false,
    points: [{ lat: 38, lng: -90 }],
    keywords: [{ id: uuid, keyword: "roof" }],
    ...(geometry ? { geometry } : {}),
  };
  const run = {
    id: "run",
    profile_id: "profile",
    request_key: "same",
    config,
    status: "running",
    lease_until: "2000-01-01",
    started_at: new Date().toISOString(),
    expected_checks: 1,
  };
  const check = {
    id: "check",
    run_id: "run",
    keyword_id: uuid,
    keyword: "roof",
    lat: 38,
    lng: -90,
    state: "planned",
    cost: 0,
  };
  const db = {
    auth: {
      getUser: async () => ({ data: { user: user ? { id: "user" } : null } }),
    },
    rpc: async (name) => {
      if (name === "map_grid_start") starts++;
      return { data: name === "get_secret" ? "secret" : "run", error: null };
    },
    from(table) {
      let update,
        filters = [],
        single = false;
      const q = {
        select() {
          return q;
        },
        update(v) {
          update = v;
          return q;
        },
        eq(k, v) {
          filters.push((r) => r[k] === v);
          return q;
        },
        lt(k, v) {
          filters.push((r) => r[k] < v);
          return q;
        },
        in(k, v) {
          filters.push((r) => v.includes(r[k]));
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        single() {
          single = true;
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        then(resolve) {
          let rows =
            table === "team_members"
              ? member
                ? [{ id: "member", auth_user_id: "user" }]
                : []
              : table === "map_grid_profiles"
                ? [config]
                : table === "map_grid_runs"
                  ? [run]
                  : table === "map_grid_checks"
                    ? [check]
                    : [];
          rows = rows.filter((r) => filters.every((f) => f(r)));
          if (update) rows.forEach((r) => Object.assign(r, update));
          return Promise.resolve({
            data: single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })),
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  const context = vm.createContext({
    createClient: () => db,
    mapTask,
    parseMapsTask,
    validateGrid,
    Request,
    Response,
    URL,
    AbortSignal,
    Date,
    Promise,
    Error,
    btoa,
    encodeURIComponent,
    console,
    Deno: { env: { get: () => "" }, serve: (fn) => (handler = fn) },
    EdgeRuntime: { waitUntil: (p) => background.push(p) },
    fetch: async (url, init) => {
      // collect dispatches each run to this same function in start mode.
      if (url.endsWith("/functions/v1/map-grid-sync"))
        return handler(new Request(`https://test${url}`, init));
      if (url.endsWith("/task_post")) {
        posts++;
        if (postFailure) throw Error("network lost");
        const payload = JSON.parse(init.body);
        assert.equal(payload[0].search_this_area, false);
        return Response.json({
          status_code: 20000,
          tasks: payload.map((t) => ({
            id: "task",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: t.tag },
          })),
        });
      }
      gets++;
      return Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: [
              {
                items: [
                  {
                    type: "maps_search",
                    place_id: "ChIJfixture",
                    title: "Exact business",
                    rank_group: 2,
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  });
  vm.runInContext(source, context);
  return {
    run,
    check,
    counts: () => ({ posts, gets, starts }),
    request: async (mode = "start", cron = true, requestKey = "same") => {
      const response = await handler(
        new Request("https://test", {
          method: "POST",
          headers: cron
            ? { "x-cron-secret": "secret" }
            : { Authorization: "Bearer test" },
          body: JSON.stringify({
            mode,
            profile_id: "profile",
            request_key: requestKey,
            wait: true,
          }),
        }),
      );
      while (background.length) await background.shift();
      return response;
    },
  };
}
test("unauthenticated and non-team calls cannot spend or read grid credentials", async () => {
  for (const setup of [{ user: false }, { member: false }]) {
    const h = harness(setup),
      r = await h.request("start", false);
    assert.equal(r.status, setup.user === false ? 401 : 403);
    assert.equal(h.counts().posts, 0);
  }
});
test("successful queued scan stores exact identity, cost, results and completes once", async () => {
  const h = harness();
  assert.equal((await h.request()).status, 200);
  assert.equal(h.check.position, 2);
  assert.equal(h.check.cost, 0.0006);
  assert.equal(h.run.status, "complete");
  await h.request();
  assert.equal(h.counts().posts, 1);
});
test("a request key that already names a run works that run: no new run, no profile revalidation", async () => {
  const h = harness({ geometry: { version: "edited-since" } });
  // The run's frozen config has no geometry; the profile was edited after it started.
  h.run.config = { ...h.run.config, geometry: undefined };
  assert.equal((await h.request()).status, 200);
  assert.equal(h.counts().starts, 0);
  assert.equal(h.counts().posts, 1);
  assert.equal(h.run.status, "complete");
});
test("a new request key goes through map_grid_start after validating the profile", async () => {
  const h = harness();
  h.run.request_key = "earlier";
  assert.equal((await h.request("start", true, "new")).status, 200);
  assert.equal(h.counts().starts, 1);
});
test("team members can run collect, which dispatches with the scheduler secret", async () => {
  const h = harness();
  const r = await h.request("collect", false);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).dispatched, [{ run_id: "run", status: 202 }]);
  assert.equal(h.run.status, "complete");
});
test("weekly stays scheduler only", async () => {
  const h = harness();
  assert.equal((await h.request("weekly", false)).status, 403);
  assert.equal(h.counts().posts, 0);
});
test("ambiguous paid submission is never automatically reposted", async () => {
  const h = harness({ postFailure: true });
  await h.request();
  assert.equal(h.check.state, "unknown");
  assert.equal(h.run.status, "failed");
  await h.request();
  assert.equal(h.counts().posts, 1);
  assert.equal(h.counts().gets, 0);
});
const validGeometry = {
  version: "local-multiscale-v1",
  center: { lat: 38, lng: -90 },
  tiers: [{ max_miles: 5, spacing_miles: 1 }],
  radii_miles: [5],
  default_radius_miles: 5,
  point_count: 1,
};
test("a frozen run with a complete geometry posts normally", async () => {
  const h = harness({ geometry: validGeometry });
  await h.request("collect");
  assert.equal(h.counts().posts, 1);
});
for (const [label, geometry, reason] of [
  ["point count mismatch", { ...validGeometry, point_count: 153 }, /point count/],
  ["missing radii", { ...validGeometry, radii_miles: undefined }, /radii/],
  ["empty tier", { ...validGeometry, tiers: [{}] }, /tiers/],
  ["missing tiers", { ...validGeometry, tiers: undefined }, /tiers/],
  ["default radius outside radii", { ...validGeometry, default_radius_miles: 2 }, /default radius/],
  ["empty object", { geometry: {} }.geometry, /Unknown grid geometry version/],
])
  test(`a frozen run with invalid geometry (${label}) never spends`, async () => {
    const h = harness({ geometry });
    await h.request("collect");
    assert.equal(h.counts().posts, 0);
    assert.equal(h.check.state, "planned");
    assert.match(h.run.error, reason);
  });
