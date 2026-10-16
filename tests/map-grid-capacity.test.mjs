// Several clients due at the same weekly slot. Edge kills an invocation at
// 2,000 ms CPU, so `weekly` and `collect` only dispatch: every running run is
// worked in its own invocation, posted promptly, collected fairly, and one
// run's failure (or a killed invocation) never reaches another.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { AsyncLocalStorage } from "node:async_hooks";
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
const READ_LANES = constant("READ_LANES");
const COLLECT_PER_RUN = constant("COLLECT_PER_RUN");
// The five-minute collector tick (pg_cron map-grid-collect).
const TICK = 5 * 60000;
// CPU cost model from production (2026-10-15): a v4 collect pass was killed at
// the 2,000 ms CPU cap after about 370 result parses (5.4 ms each), and posting
// one 765-check run (8 batches) cost up to 500 ms (62.5 ms per batch).
const CPU_LIMIT = 2000;
const READ_CPU = CPU_LIMIT / 370;
const POST_CPU = 500 / 8;
const cpu = (inv) => inv.posts * POST_CPU + inv.gets * READ_CPU;

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
  // Simulated provider latency (ms, including the check-row writes). Each
  // invocation has its own clock offset, as separate Edge isolates do: a POST
  // advances it by its full latency (a run's batches are sequential), a read
  // by its latency divided by the read lanes.
  latency = null,
  // { run, afterPosts }: that run's invocation is killed (CPU) while its next
  // POST is in flight. Its finally never runs, so its lease is not released.
  kill = null,
  // Run ids whose first dispatch request is lost.
  dispatchFail = [],
} = {}) {
  let handler,
    clock = Date.parse("2026-10-15T14:00:00Z");
  const als = new AsyncLocalStorage();
  const invocations = [],
    pending = [],
    posts = new Map(),
    gets = new Map(),
    pendingLeft = new Map(),
    lostDispatch = new Set(dispatchFail);
  const newInvocation = (kind, offset = 0) => {
    const inv = {
      kind,
      runs: new Set(),
      posts: 0,
      gets: 0,
      offset,
      startOffset: offset,
      inflight: { post: 0, get: 0 },
      maxInflight: { post: 0, get: 0 },
      killed: false,
    };
    invocations.push(inv);
    return inv;
  };
  class FakeDate extends Date {
    constructor(...a) {
      super(...(a.length ? a : [FakeDate.now()]));
    }
    static now() {
      return clock + (als.getStore()?.offset ?? 0);
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
      request_key: `weekly:2026-10-15`,
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
              attempted_at: new FakeDate().toISOString(),
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
  const never = new Promise(() => {});
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
    console: { ...console, error: () => {} },
    Deno: {
      env: { get: (k) => (k === "SUPABASE_URL" ? "https://project.test" : "") },
      serve: (fn) => (handler = fn),
    },
    EdgeRuntime: {
      waitUntil: (promise) => {
        const entry = { inv: als.getStore(), done: false };
        entry.promise = promise.finally(() => (entry.done = true));
        pending.push(entry);
      },
    },
    fetch: async (url, init) => {
      const parent = als.getStore();
      if (url.endsWith("/functions/v1/map-grid-sync")) {
        // A self-dispatch is a new Edge invocation with its own CPU budget and clock.
        assert.equal(url, "https://project.test/functions/v1/map-grid-sync");
        assert.equal(init.headers["x-cron-secret"], "secret");
        const body = JSON.parse(init.body);
        assert.equal(body.mode, "start");
        assert.equal(body.wait, undefined, "a dispatch never waits for the run");
        // The run this request works: its own key, or (a weekly key that
        // map_grid_start resolved) the profile's one running run.
        const due =
          tables.map_grid_runs.find(
            (r) =>
              r.profile_id === body.profile_id &&
              r.request_key === body.request_key,
          ) ??
          tables.map_grid_runs.find(
            (r) => r.profile_id === body.profile_id && r.status === "running",
          );
        if (due && lostDispatch.delete(due.id)) throw Error("dispatch lost");
        const child = newInvocation("child", parent.offset);
        child.dispatchedFor = due?.id;
        await new Promise((r) => setImmediate(r));
        return als.run(child, () =>
          handler(new Request(url, { ...init, headers: init.headers })),
        );
      }
      const inv = parent;
      const kind = url.endsWith("/task_post") ? "post" : "get";
      inv.inflight[kind]++;
      inv.maxInflight[kind] = Math.max(inv.maxInflight[kind], inv.inflight[kind]);
      // Yield so concurrent lanes and invocations genuinely overlap.
      await new Promise((r) => setImmediate(r));
      inv.inflight[kind]--;
      if (latency)
        inv.offset += latency[kind] / (kind === "post" ? 1 : READ_LANES);
      if (url.endsWith("/task_post")) {
        inv.offset += postClockStep;
        const payload = JSON.parse(init.body);
        const run = runOf(payload[0].tag);
        assert.ok(
          payload.every((t) => runOf(t.tag) === run),
          "a POST batch never mixes runs",
        );
        assert.ok(payload.length <= 100);
        inv.runs.add(run);
        inv.posts++;
        posts.set(run, (posts.get(run) ?? 0) + 1);
        if (kill && run === kill.run && posts.get(run) === kill.afterPosts + 1) {
          kill = null;
          inv.killed = true;
          // The request may have reached the provider; the isolate is gone.
          return never;
        }
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
      inv.runs.add(run);
      inv.gets++;
      gets.set(run, (gets.get(run) ?? 0) + 1);
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
  // Background work of every live invocation; a killed one never finishes.
  const drain = async () => {
    for (;;) {
      const live = pending.filter((e) => !e.done && !e.inv?.killed);
      if (!live.length) return;
      await Promise.race([
        ...live.map((e) => e.promise),
        new Promise((r) => setTimeout(r, 1)),
      ]);
    }
  };
  return {
    tables,
    run,
    states,
    posts,
    gets,
    invocations,
    advance: (ms) => (clock += ms),
    setClock: (t) => (clock = t),
    now: () => clock,
    invoke: async (mode = "collect") => {
      const inv = newInvocation(mode);
      const first = invocations.length - 1;
      const response = await als.run(inv, () =>
        handler(
          new Request("https://test", {
            method: "POST",
            headers: { "x-cron-secret": "secret" },
            body: JSON.stringify({ mode, wait: true }),
          }),
        ),
      );
      const body = await response.json();
      await drain();
      return {
        status: response.status,
        body,
        inv,
        children: () => invocations.slice(first + 1).filter((i) => i.kind === "child"),
      };
    },
  };
}
const totalPosts = (h) => [...h.posts.values()].reduce((a, b) => a + b, 0);
const batchesPerRun = Math.ceil((POINTS * KEYWORDS) / 100);
const released = (h, id) =>
  assert.ok(
    h.run(id).lease_until <= new Date(h.now()).toISOString(),
    `${id} lease still held until ${h.run(id).lease_until}`,
  );
// Every child invocation worked exactly one run, the one it was dispatched for,
// with bounded provider concurrency and inside the CPU budget.
function onePerInvocation(children) {
  for (const inv of children) {
    assert.ok(inv.runs.size <= 1, `one invocation touched ${[...inv.runs]}`);
    if (inv.runs.size) assert.equal([...inv.runs][0], inv.dispatchedFor);
    assert.ok(inv.maxInflight.post <= 1, "a run's batches are sequential");
    assert.ok(inv.maxInflight.get <= READ_LANES);
    assert.ok(inv.gets <= COLLECT_PER_RUN);
    assert.ok(cpu(inv) <= CPU_LIMIT / 2, `estimated ${cpu(inv)} ms CPU`);
  }
}

test("weekly at the slot dispatches ten 765-check runs one per invocation, each inside the CPU budget, and releases every lease", async () => {
  const h = fleet({ runs: 10 });
  const weekly = await h.invoke("weekly");
  assert.equal(weekly.status, 200);
  // The scheduler invocation itself never posts or parses a provider result.
  assert.equal(weekly.inv.posts + weekly.inv.gets, 0);
  assert.equal(weekly.body.attempts.length, 10);
  assert.deepEqual(
    weekly.body.dispatched.map((d) => d.status),
    Array(10).fill(202),
  );
  const children = weekly.children();
  assert.equal(children.length, 10);
  onePerInvocation(children);
  assert.deepEqual(
    children.map((c) => c.dispatchedFor).sort(),
    Array.from({ length: 10 }, (_, i) => `run${i}`).sort(),
  );
  // Ten runs really were worked side by side, each by its own invocation.
  for (let i = 0; i < 10; i++) {
    assert.equal(h.posts.get(`run${i}`), batchesPerRun);
    assert.equal(h.states(`run${i}`).planned, undefined);
    assert.equal(h.gets.get(`run${i}`), COLLECT_PER_RUN);
    released(h, `run${i}`);
  }
  // The v4 single pass would have parsed 600 results and posted 80 batches in
  // one invocation: about 8,200 ms CPU against the 2,000 ms cap.
  assert.ok(80 * POST_CPU + 600 * READ_CPU > CPU_LIMIT);
  let ticks = 1;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    h.advance(TICK);
    const tick = await h.invoke("collect");
    assert.equal(tick.inv.posts + tick.inv.gets, 0);
    onePerInvocation(tick.children());
    for (let i = 0; i < 10; i++) released(h, `run${i}`);
    assert.ok(++ticks < 100, "collector did not converge");
  }
  for (let i = 0; i < 10; i++) {
    assert.equal(h.run(`run${i}`).status, "complete");
    assert.equal(h.states(`run${i}`).complete, POINTS * KEYWORDS);
  }
  // One POST per 100 checks, one result read per check: no extra paid tasks.
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  assert.equal(
    [...h.gets.values()].reduce((a, b) => a + b, 0),
    10 * POINTS * KEYWORDS,
  );
  // 765 checks at 60 reads per run per tick: 13 ticks, about 1.1 hours.
  assert.ok(ticks * TICK <= 1.25 * 3600000, `${ticks} ticks`);
  // Re-running the collector after completion dispatches nothing and never posts again.
  const after = await h.invoke();
  assert.deepEqual(after.body.dispatched, []);
  assert.equal(totalPosts(h), 10 * batchesPerRun);
});

test("weekly and collect firing together at the slot never work a run twice", async () => {
  const h = fleet({ runs: 10 });
  await Promise.all([h.invoke("weekly"), h.invoke("collect")]);
  const children = h.invocations.filter((i) => i.kind === "child");
  assert.equal(children.length, 20, "both schedulers dispatched every run");
  onePerInvocation(children);
  // The per-run lease lets exactly one of each pair work the run.
  assert.equal(children.filter((c) => c.runs.size).length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(h.posts.get(`run${i}`), batchesPerRun);
    released(h, `run${i}`);
  }
});

test("with realistic provider latency every invocation stays inside the wall clock and all ten runs finish well before expiry", async () => {
  // Pessimistic: 5 s per 100-task POST including its 100 binding writes,
  // 1.5 s per result read, and every result still pending on its first read.
  const h = fleet({ runs: 10, latency: { post: 5000, get: 1500 }, pendingGets: 1 });
  const slot = h.now();
  let ticks = 0;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    h.setClock(slot + ticks * TICK);
    await h.invoke(ticks ? "collect" : "weekly");
    assert.ok(++ticks < 100);
  }
  const longest = Math.max(...h.invocations.map((i) => i.offset - i.startOffset));
  // No new call starts after WORK_MS; the last in-flight one may finish.
  assert.ok(longest <= WORK_MS + 5000, `longest invocation ${longest} ms`);
  assert.ok(longest < 150000, "inside the 150 s Edge wall clock");
  assert.ok(longest < LEASE_MS, "a live invocation never outlasts its lease");
  for (let i = 0; i < 10; i++) assert.equal(h.run(`run${i}`).status, "complete");
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  assert.ok(ticks * TICK <= 2.5 * 3600000, `${ticks} ticks`);
});

test("slow provider queues (three reads per check) still finish all ten runs well inside six hours", async () => {
  const h = fleet({ runs: 10, pendingGets: 2 });
  let ticks = 0;
  while (h.tables.map_grid_runs.some((r) => r.status === "running")) {
    onePerInvocation((await h.invoke()).children());
    h.advance(TICK);
    assert.ok(++ticks < 200);
  }
  for (let i = 0; i < 10; i++) assert.equal(h.run(`run${i}`).status, "complete");
  assert.equal(totalPosts(h), 10 * batchesPerRun);
  // 2,295 reads per run at 60 per tick: 39 ticks, about 3.25 hours.
  assert.ok(ticks * TICK <= 3.5 * 3600000, `${ticks} ticks`);
});

test("more than ten runs each get their own invocation and their full read share", async () => {
  const h = fleet({ runs: 12 });
  const r = await h.invoke();
  assert.equal(r.children().length, 12);
  onePerInvocation(r.children());
  for (let i = 0; i < 12; i++)
    assert.equal(h.gets.get(`run${i}`), COLLECT_PER_RUN);
});

test("an invocation killed mid-post holds its lease for at most LEASE_MS; the next tick resumes the run without reposting", async () => {
  assert.ok(LEASE_MS >= 150000, "longer than the Edge wall clock");
  assert.ok(LEASE_MS < TICK, "lapses before the next collector tick");
  const h = fleet({ runs: 4, kill: { run: "run2", afterPosts: 3 } });
  await h.invoke("weekly");
  const killed = h.invocations.find((i) => i.killed);
  assert.equal(killed.dispatchedFor, "run2");
  // The killed invocation never reached its finally; the others are released.
  assert.ok(h.run("run2").lease_until > new Date(h.now()).toISOString());
  assert.equal(h.states("run2").posting, 100);
  for (const id of ["run0", "run1", "run3"]) {
    released(h, id);
    assert.equal(h.posts.get(id), batchesPerRun);
  }
  // Before the lease lapses the run is not dispatched again.
  h.advance(LEASE_MS - 1000);
  const early = await h.invoke();
  assert.ok(!early.body.dispatched.some((d) => d.run_id === "run2"));
  for (let i = 0; i < 40 && h.tables.map_grid_runs.some((r) => r.status === "running"); i++) {
    h.advance(TICK);
    await h.invoke();
  }
  // The interrupted batch is unknown (it may have been charged) and is never reposted.
  assert.equal(h.states("run2").unknown, 100);
  assert.equal(h.states("run2").complete, POINTS * KEYWORDS - 100);
  assert.equal(h.posts.get("run2"), batchesPerRun);
  assert.equal(h.run("run2").status, "partial");
  released(h, "run2");
  for (const id of ["run0", "run1", "run3"])
    assert.equal(h.run(id).status, "complete");
});

test("a lost dispatch leaves the run running and the next tick dispatches it", async () => {
  const h = fleet({ runs: 3, dispatchFail: ["run1"] });
  const r = await h.invoke("weekly");
  const by = Object.fromEntries(r.body.dispatched.map((d) => [d.run_id, d.status]));
  assert.deepEqual(by, { run0: 202, run1: "error", run2: 202 });
  assert.equal(h.posts.get("run1"), undefined);
  assert.equal(h.run("run1").status, "running");
  h.advance(TICK);
  await h.invoke();
  assert.equal(h.posts.get("run1"), batchesPerRun);
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

test("a run leased by another worker is not dispatched and does not block the rest", async () => {
  const h = fleet({ runs: 3, leasedRun: 0 });
  const r = await h.invoke();
  assert.deepEqual(
    r.body.dispatched.map((d) => d.run_id).sort(),
    ["run1", "run2"],
  );
  assert.equal(h.posts.get("run0"), undefined);
  assert.equal(h.posts.get("run1"), batchesPerRun);
  assert.equal(h.posts.get("run2"), batchesPerRun);
  // Once the other worker's lease lapses, the oldest run is picked up normally.
  h.advance(LEASE_MS + 1);
  await h.invoke();
  assert.equal(h.posts.get("run0"), batchesPerRun);
});

test("posting stops at the invocation deadline: unposted checks stay planned and are posted once later", async () => {
  // Each POST advances its invocation's clock, so the deadline lands mid-posting.
  const h = fleet({ runs: 3, postClockStep: Math.ceil(WORK_MS / 4) });
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

test("weekly start records every outcome per profile and still dispatches the runs that exist", async () => {
  const h = fleet({
    runs: 3,
    startErrors: {
      profile1: "A grid scan is already running",
      profile2: "Grid keyword mismatch",
    },
  });
  // The fixture runs carry a different key, so the weekly key reaches map_grid_start.
  for (const r of h.tables.map_grid_runs) r.request_key = "manual:earlier";
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
  // Every running run is dispatched once, in its own invocation.
  assert.equal(r.body.dispatched.length, 3);
  onePerInvocation(r.children());
  for (let i = 0; i < 3; i++) assert.equal(h.posts.get(`run${i}`), batchesPerRun);
});

test("a repeated weekly call on the same day re-dispatches the existing runs without starting new ones", async () => {
  const h = fleet({ runs: 2 });
  await h.invoke("weekly");
  await h.invoke("weekly");
  assert.equal(h.tables.map_grid_runs.length, 2);
  assert.deepEqual(
    h.tables.map_grid_weekly_attempts.map((a) => [a.outcome, a.run_id]),
    [["started", "run0"], ["started", "run1"], ["started", "run0"], ["started", "run1"]],
  );
  assert.equal(totalPosts(h), 2 * batchesPerRun);
});

test("weekly start errors from invalid geometry are recorded rather than swallowed", async () => {
  const h = fleet({ runs: 1 });
  h.tables.map_grid_runs[0].request_key = "manual:earlier";
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
  released(h, "run0");
});

test("no invocation can parse more than COLLECT_TOTAL results, and that worst case fits the CPU cap", () => {
  assert.ok(COLLECT_PER_RUN <= COLLECT_TOTAL && COLLECT_TOTAL <= 150);
  // A full 765-check post plus the whole read cap in one invocation.
  const worst = batchesPerRun * POST_CPU + COLLECT_TOTAL * READ_CPU;
  assert.ok(worst <= 0.75 * CPU_LIMIT, `worst case ${worst} ms`);
});
