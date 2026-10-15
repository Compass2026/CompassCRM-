// Several clients due at the same weekly slot: every run is posted promptly,
// collected fairly, and one run's failure never reaches another.
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
const constant = (name) =>
  Number(eval(source.match(new RegExp(`const ${name} = ([^;]+);`))[1]));
const COLLECT_TOTAL = constant("COLLECT_TOTAL");
const WORK_MS = constant("WORK_MS");
const EXPIRY_MS = constant("EXPIRY_MS");
const LEASE_MS = constant("LEASE_MS");
const POST_LANES = constant("POST_LANES");
const READ_LANES = constant("READ_LANES");
const COLLECT_PER_RUN = constant("COLLECT_PER_RUN");
// The five-minute collector tick (pg_cron map-grid-collect).
const TICK = 5 * 60000;

// Lucas's dense layout: 153 points x 5 keywords = 765 checks per run.
const POINTS = 153,
  KEYWORDS = 5;
function fleet({
  runs = 10,
  failPostRun = null,
  pendingGets = 0,
  leasedRun = null,
  startErrors = {},
  postClockStep = 0,
  // Simulated provider latency (ms, including the check-row writes). Each call
  // advances the clock by its latency divided by its lane count: the
  // throughput of the bounded concurrency, deterministically.
  latency = null,
} = {}) {
  let handler,
    clock = Date.parse("2026-10-15T14:00:00Z");
  const posts = new Map(),
    gets = new Map(),
    getsPerInvocation = [],
    pendingLeft = new Map(),
    inflight = { post: 0, get: 0 },
    maxInflight = { post: 0, get: 0 };
  class FakeDate extends Date {
    constructor(...a) {
      super(...(a.length ? a : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const tables = {
    team_members: [],
    map_grid_profiles: [],
    map_grid_runs: [],
    map_grid_checks: [],
    map_grid_weekly_attempts: [],
  };
  const keywords = Array.from({ length: KEYWORDS }, (_, k) => ({
    id: `00000000-0000-4000-a000-00000000000${k}`,
    keyword: `kw${k}`,
  }));
  const points = Array.from({ length: POINTS }, (_, i) => ({
    lat: 38 + i / 1000,
    lng: -90,
  }));
  for (let r = 0; r < runs; r++) {
    const config = {
      id: `profile${r}`,
      target_place_id: "ChIJfixture",
      zoom: 13,
      search_this_area: true,
      points,
      keywords,
      enabled: true,
      weekly_enabled: true,
    };
    tables.map_grid_profiles.push(config);
    tables.map_grid_runs.push({
      id: `run${r}`,
      profile_id: config.id,
      config,
      status: "running",
      lease_until:
        r === leasedRun
          ? new Date(clock + LEASE_MS).toISOString()
          : "2000-01-01T00:00:00.000Z",
      started_at: new Date(clock + r).toISOString(),
      expected_checks: POINTS * KEYWORDS,
      error: null,
    });
    for (const kw of keywords)
      points.forEach((p, i) =>
        tables.map_grid_checks.push({
          id: `run${r}:${kw.id}:${i}`,
          run_id: `run${r}`,
          keyword_id: kw.id,
          keyword: kw.keyword,
          point_index: i,
          lat: p.lat,
          lng: p.lng,
          state: "planned",
          task_id: null,
          cost: 0,
          error: null,
          checked_at: null,
        }),
      );
  }
  const runOf = (checkId) => checkId.split(":")[0];
  const db = {
    auth: { getUser: async () => ({ data: { user: null } }) },
    rpc: async (name, args) => {
      if (name === "get_secret") return { data: "secret", error: null };
      const message = startErrors[args.p_profile_id];
      if (message) return { data: null, error: { message } };
      return { data: args.p_profile_id.replace("profile", "run"), error: null };
    },
    from(table) {
      let update,
        insert,
        filters = [],
        single = false,
        sort = null,
        limit = Infinity;
      const q = {
        select: () => q,
        update(v) {
          update = v;
          return q;
        },
        insert(v) {
          insert = v;
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
        order(k, o = {}) {
          sort = { k, nullsFirst: o.nullsFirst };
          return q;
        },
        limit(n) {
          limit = n;
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
          if (insert) {
            tables[table].push({
              ...insert,
              attempted_at: new Date(clock).toISOString(),
            });
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          let rows = tables[table].filter((r) => filters.every((f) => f(r)));
          if (sort)
            rows = [...rows].sort((a, b) => {
              const x = a[sort.k],
                y = b[sort.k];
              if (x === y) return 0;
              if (x == null) return sort.nullsFirst ? -1 : 1;
              if (y == null) return sort.nullsFirst ? 1 : -1;
              return x < y ? -1 : 1;
            });
          rows = rows.slice(0, limit);
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
    Date: FakeDate,
    Promise,
    Error,
    String,
    btoa,
    encodeURIComponent,
    console,
    Deno: { env: { get: () => "" }, serve: (fn) => (handler = fn) },
    EdgeRuntime: { waitUntil: () => {} },
    fetch: async (url, init) => {
      const kind = url.endsWith("/task_post") ? "post" : "get";
      inflight[kind]++;
      maxInflight[kind] = Math.max(maxInflight[kind], inflight[kind]);
      // Yield so concurrent lanes genuinely overlap.
      await new Promise((r) => setImmediate(r));
      inflight[kind]--;
      if (latency)
        clock += latency[kind] / (kind === "post" ? POST_LANES : READ_LANES);
      if (url.endsWith("/task_post")) {
        clock += postClockStep;
        const payload = JSON.parse(init.body);
        const run = runOf(payload[0].tag);
        assert.ok(
          payload.every((t) => runOf(t.tag) === run),
          "a POST batch never mixes runs",
        );
        assert.ok(payload.length <= 100);
        posts.set(run, (posts.get(run) ?? 0) + 1);
        if (run === failPostRun && posts.get(run) === 1)
          throw Error("network lost");
        return Response.json({
          status_code: 20000,
          tasks: payload.map((t) => ({
            id: `task-${t.tag}`,
            status_code: 20100,
            cost: 0.0006,
            data: { tag: t.tag },
          })),
        });
      }
      const tag = decodeURIComponent(url.split("/").pop()).replace(/^task-/, "");
      const run = runOf(tag);
      gets.set(run, (gets.get(run) ?? 0) + 1);
      getsPerInvocation[getsPerInvocation.length - 1].push(run);
      const left = pendingLeft.get(tag) ?? pendingGets;
      if (left > 0) {
        pendingLeft.set(tag, left - 1);
        return Response.json({
          status_code: 20000,
          tasks: [{ status_code: 40602, result: null }],
        });
      }
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
                    rank_group: 3,
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
  const run = (id) => tables.map_grid_runs.find((r) => r.id === id);
  const states = (id) =>
    tables.map_grid_checks
      .filter((c) => c.run_id === id)
      .reduce((m, c) => ({ ...m, [c.state]: (m[c.state] ?? 0) + 1 }), {});
  return {
    tables,
    run,
    states,
    posts,
    gets,
    getsPerInvocation,
    maxInflight,
    advance: (ms) => (clock += ms),
    setClock: (t) => (clock = t),
    now: () => clock,
    invoke: async (mode = "collect") => {
      getsPerInvocation.push([]);
      const response = await handler(
        new Request("https://test", {
          method: "POST",
          headers: { "x-cron-secret": "secret" },
          body: JSON.stringify({ mode, wait: true }),
        }),
      );
      return { status: response.status, body: await response.json() };
    },
  };
}
const totalPosts = (h) => [...h.posts.values()].reduce((a, b) => a + b, 0);
const batchesPerRun = Math.ceil((POINTS * KEYWORDS) / 100);

test("ten 765-check runs due together all post in the first invocation, share reads evenly and complete well before expiry", async () => {
  const h = fleet({ runs: 10 });
  let invocations = 0;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    const r = await h.invoke();
    assert.equal(r.status, 200);
    invocations++;
    if (invocations === 1) {
      // Every run is fully submitted at once; nothing waits behind the oldest run.
      for (let i = 0; i < 10; i++) {
        assert.equal(h.posts.get(`run${i}`), batchesPerRun);
        assert.equal(h.states(`run${i}`).planned, undefined);
        // Fair share: every run gets its full 60-read share in the same pass.
        assert.equal(
          h.getsPerInvocation[0].filter((x) => x === `run${i}`).length,
          COLLECT_PER_RUN,
        );
      }
    }
    h.advance(TICK);
    assert.ok(invocations < 100, "collector did not converge");
  }
  for (let i = 0; i < 10; i++) {
    assert.equal(h.run(`run${i}`).status, "complete");
    assert.equal(h.states(`run${i}`).complete, POINTS * KEYWORDS);
    assert.ok(h.run(`run${i}`).lease_until <= new Date(h.now()).toISOString());
  }
  // One POST per 100 checks, one result read per check: no extra paid tasks.
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  assert.equal(
    [...h.gets.values()].reduce((a, b) => a + b, 0),
    10 * POINTS * KEYWORDS,
  );
  for (const perInvocation of h.getsPerInvocation)
    assert.ok(perInvocation.length <= COLLECT_TOTAL);
  // Provider concurrency is bounded, and posting really runs in parallel lanes.
  assert.ok(h.maxInflight.post <= POST_LANES && h.maxInflight.post > 1, `posts in flight ${h.maxInflight.post}`);
  assert.ok(h.maxInflight.get <= READ_LANES && h.maxInflight.get > 1, `reads in flight ${h.maxInflight.get}`);
  // 7,650 checks at 600 reads per tick: 13 ticks, about 1.1 hours.
  assert.ok(invocations * TICK <= 1.25 * 3600000, `${invocations} invocations`);
  // Re-running the collector after completion never posts again.
  await h.invoke();
  assert.equal(totalPosts(h), 10 * batchesPerRun);
});

test("with realistic provider latency every invocation stays inside the wall clock and all ten runs finish well before expiry", async () => {
  // Pessimistic: 5 s per 100-task POST including its 100 binding writes,
  // 1.5 s per result read, and every result still pending on its first read.
  const h = fleet({ runs: 10, latency: { post: 5000, get: 1500 }, pendingGets: 1 });
  const slot = h.now();
  let ticks = 0,
    longest = 0;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    const start = slot + ticks * TICK;
    h.setClock(start);
    await h.invoke();
    longest = Math.max(longest, h.now() - start);
    assert.ok(++ticks < 100);
  }
  // No new call starts after WORK_MS; the last in-flight one may finish.
  assert.ok(longest <= WORK_MS + 5000, `longest invocation ${longest} ms`);
  assert.ok(longest < 150000, "inside the 150 s Edge wall clock");
  for (let i = 0; i < 10; i++) assert.equal(h.run(`run${i}`).status, "complete");
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  assert.ok(ticks * TICK <= 2.5 * 3600000, `${ticks} ticks`);
});

test("slow provider queues (three reads per check) still finish all ten runs well inside six hours", async () => {
  const h = fleet({ runs: 10, pendingGets: 2 });
  let invocations = 0;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    await h.invoke();
    h.advance(TICK);
    assert.ok(++invocations < 200);
  }
  for (let i = 0; i < 10; i++) assert.equal(h.run(`run${i}`).status, "complete");
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  // 22,950 reads at 600 per tick: 39 ticks, about 3.25 hours.
  assert.ok(invocations * TICK <= 3.5 * 3600000, `${invocations} invocations`);
});

test("more runs than the read budget share it round-robin, never starving any run", async () => {
  const h = fleet({ runs: 12 });
  await h.invoke();
  const share = Array.from({ length: 12 }, (_, i) =>
    h.getsPerInvocation[0].filter((x) => x === `run${i}`).length,
  );
  assert.equal(share.reduce((a, b) => a + b, 0), COLLECT_TOTAL);
  assert.ok(Math.max(...share) - Math.min(...share) <= 1, share.join(","));
});

test("an ambiguous POST in one run leaves the other runs untouched and is never reposted", async () => {
  const h = fleet({ runs: 4, failPostRun: "run1" });
  for (let i = 0; i < 40; i++) {
    await h.invoke();
    h.advance(5 * 60000);
  }
  // Only the first 100-check batch of run1 is ambiguous; its other batches proceed.
  assert.equal(h.states("run1").unknown, 100);
  assert.equal(h.states("run1").complete, POINTS * KEYWORDS - 100);
  assert.equal(h.run("run1").status, "partial");
  assert.match(h.run("run1").error, /not ranking losses/);
  for (const id of ["run0", "run2", "run3"]) {
    assert.equal(h.run(id).status, "complete");
    assert.equal(h.run(id).error, null);
    assert.equal(h.posts.get(id), batchesPerRun);
  }
  // The failed batch counted once; no automatic resubmission on later passes.
  assert.equal(h.posts.get("run1"), batchesPerRun);
  assert.equal(h.gets.get("run1"), POINTS * KEYWORDS - 100);
});

test("a run leased by another collector is skipped without blocking the rest", async () => {
  const h = fleet({ runs: 3, leasedRun: 0 });
  const r = await h.invoke();
  assert.deepEqual(r.body.runs[0], { run_id: "run0", busy: true });
  assert.equal(h.posts.get("run0"), undefined);
  assert.equal(h.posts.get("run1"), batchesPerRun);
  assert.equal(h.posts.get("run2"), batchesPerRun);
  // Once the other worker's lease lapses, the oldest run is picked up normally.
  h.advance(LEASE_MS + 1);
  await h.invoke();
  assert.equal(h.posts.get("run0"), batchesPerRun);
});

test("posting stops at the invocation deadline: unposted checks stay planned and are posted once later", async () => {
  // Each POST advances the clock, so the deadline lands mid-posting.
  const h = fleet({ runs: 3, postClockStep: Math.ceil(WORK_MS / 10) });
  await h.invoke();
  const planned = [0, 1, 2].reduce(
    (n, i) => n + (h.states(`run${i}`).planned ?? 0),
    0,
  );
  assert.ok(planned > 0, "deadline should defer some posting");
  assert.equal(
    [0, 1, 2].reduce((n, i) => n + (h.states(`run${i}`).unknown ?? 0), 0),
    0,
    "a deferred batch is never marked ambiguous",
  );
  for (let i = 0; i < 60 && h.tables.map_grid_runs.some((r) => r.status === "running"); i++) {
    h.advance(5 * 60000);
    await h.invoke();
  }
  for (let i = 0; i < 3; i++) assert.equal(h.run(`run${i}`).status, "complete");
  assert.equal(totalPosts(h), 3 * batchesPerRun);
});

test("weekly start records every outcome per profile and still collects the runs that exist", async () => {
  const h = fleet({
    runs: 3,
    startErrors: {
      profile1: "A grid scan is already running",
      profile2: "Grid keyword mismatch",
    },
  });
  const r = await h.invoke("weekly");
  assert.equal(r.status, 200);
  const attempts = h.tables.map_grid_weekly_attempts;
  assert.equal(attempts.length, 3);
  const by = Object.fromEntries(attempts.map((a) => [a.profile_id, a]));
  assert.equal(by.profile0.outcome, "started");
  assert.equal(by.profile0.run_id, "run0");
  assert.equal(by.profile1.outcome, "already_running");
  assert.equal(by.profile2.outcome, "error");
  assert.equal(by.profile2.message, "Grid keyword mismatch");
  for (const a of attempts) assert.equal(a.request_key, "weekly:2026-10-15");
  // The collector pass after the starts covers every running run.
  for (let i = 0; i < 3; i++) assert.equal(h.posts.get(`run${i}`), batchesPerRun);
});

test("weekly start errors from invalid geometry are recorded rather than swallowed", async () => {
  const h = fleet({ runs: 1 });
  h.tables.map_grid_profiles[0].geometry = { version: "other" };
  await h.invoke("weekly");
  const [a] = h.tables.map_grid_weekly_attempts;
  assert.equal(a.outcome, "error");
  assert.match(a.message, /geometry/i);
});

test("a run that errors on every pass still expires at six hours instead of blocking its profile", async () => {
  const h = fleet({ runs: 2 });
  h.run("run0").config = { ...h.run("run0").config, geometry: { version: "other" } };
  h.run("run0").started_at = new Date(h.now() - EXPIRY_MS - 60000).toISOString();
  await h.invoke();
  assert.equal(h.posts.get("run0"), undefined, "an invalid run never spends");
  assert.equal(h.run("run0").status, "failed");
  assert.match(h.run("run0").error, /geometry/i);
  assert.equal(h.states("run0").failed, POINTS * KEYWORDS);
  assert.equal(h.posts.get("run1"), batchesPerRun, "the other run is unaffected");
});
