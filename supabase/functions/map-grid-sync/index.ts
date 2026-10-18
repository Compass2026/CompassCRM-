import { createClient } from "npm:@supabase/supabase-js@2.112.4";
import {
  mapTask,
  parseMapsTask,
  validateGrid,
  type GridCheck,
  type GridConfig,
} from "../_shared/map-grid.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
const BASE = "https://api.dataforseo.com/v3/serp/google/maps";
const VERSION = "map-grid-v5";
// Per-invocation bounds (the collector runs every five minutes). Posting is
// deferred safely: a planned check has cost nothing. Collection never creates
// a paid task. The deadline keeps one invocation inside the Edge wall clock.
// Edge kills an invocation at 2,000 ms CPU long before the wall clock, so
// `weekly` and `collect` only dispatch: every running run is worked in its own
// invocation (post at most 765 checks plus 60 reads, about 230–520 ms CPU).
// Sized in docs/map-grid-pilot.md (CPU budget).
const POST_BATCH = 100;
const POST_LANES = 4;
const READ_LANES = 10;
const COLLECT_PER_RUN = 60;
// Defence in depth: no invocation parses more results than this, whatever it is given.
const COLLECT_TOTAL = 150;
const MAX_RUNS = 20;
const DISPATCH_LANES = 5;
// No paid POST is issued after WORK_MS (checked again after every awaited
// claim), and each POST aborts after 20 s.
const WORK_MS = 100000;
// Must outlast any worker that could still post: paid-plan Edge workers may
// live 400 s, so 600 s. A lease left by a killed worker therefore holds its
// run for up to two collector ticks; it is never shortened to recover faster.
const LEASE_MS = 600000;
const EXPIRY_MS = 6 * 3600000;
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
async function secret(name: string) {
  const { data, error } = await db.rpc("get_secret", { secret_name: name });
  if (error) throw Error("Secret lookup failed");
  return data as string | null;
}
function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw Error("Grid database operation failed");
  return r.data;
}
// At most `width` calls in flight; callers catch their own errors.
async function parallel<T>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (index < items.length) await fn(items[index++]);
    }),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST")
    return Response.json({ error: "POST required" }, { status: 405 });
  try {
    const cronSecret = await secret("SYNC_CRON_SECRET");
    const isCron =
      !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      const jwt =
        req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const {
        data: { user },
      } = await db.auth.getUser(jwt);
      if (!user)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      const member = must(
        await db
          .from("team_members")
          .select("id")
          .eq("auth_user_id", user.id)
          .maybeSingle(),
      );
      if (!member)
        return Response.json(
          { error: "Team access required" },
          { status: 403 },
        );
    }
    const body = await req.json();
    if (body.mode === "status")
      return Response.json({
        version: VERSION,
        configured:
          !!(await secret("DATAFORSEO_LOGIN")) &&
          !!(await secret("DATAFORSEO_PASSWORD")),
      });
    const login = await secret("DATAFORSEO_LOGIN"),
      password = await secret("DATAFORSEO_PASSWORD");
    if (!login || !password)
      return Response.json(
        { error: "DataForSEO is not configured" },
        { status: 503 },
      );
    const dfs = async (path: string, payload?: unknown) => {
      const response = await fetch(`${BASE}${path}`, {
        method: payload ? "POST" : "GET",
        headers: {
          Authorization: `Basic ${btoa(`${login}:${password}`)}`,
          "Content-Type": "application/json",
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw Error(`DataForSEO HTTP ${response.status}`);
      const json = await response.json();
      if (json.status_code !== 20000 || !Array.isArray(json.tasks))
        throw Error(`DataForSEO status ${json.status_code ?? "missing"}`);
      return json;
    };
    if (body.mode === "discover") {
      // Read-only identity lookup. Candidate identity must be reviewed before a profile is enabled.
      const client = must(
        await db
          .from("clients")
          .select("id,name,dba,website_url,phone")
          .eq("id", body.client_id)
          .single(),
      );
      if (!client) throw Error("Client not found");
      const loc = must(
        await db
          .from("locations")
          .select("lat,lng,city,state")
          .eq("client_id", client.id)
          .eq("is_physical_location", true)
          .limit(1)
          .single(),
      );
      if (!loc || loc.lat == null || loc.lng == null)
        throw Error("Home coordinates missing");
      const r = await dfs("/live/advanced", [
        {
          keyword: `${client.dba || client.name} ${loc.city} ${loc.state}`,
          location_coordinate: `${loc.lat},${loc.lng},13z`,
          language_code: "en",
          depth: 100,
        },
      ]);
      const task = r.tasks[0];
      if (task?.status_code !== 20000) throw Error("Identity lookup failed");
      return Response.json({
        version: VERSION,
        client,
        cost: r.cost,
        candidates: (task.result?.[0]?.items ?? [])
          .filter((x: Record<string, unknown>) => x.type === "maps_search")
          .slice(0, 10)
          .map((x: Record<string, unknown>) => ({
            place_id: x.place_id,
            title: x.title,
            url: x.url,
            phone: x.phone,
            address: x.address,
          })),
      });
    }
    type Run = {
      id: string;
      config: GridConfig;
      started_at: string;
      expected_checks: number;
    };
    type Outcome = {
      run_id: string;
      busy?: true;
      error?: string;
      expected?: number;
      complete?: number;
    };
    type QueuedCheck = GridCheck & { task_id: string };
    // True while this worker still owns the run's lease. Read before every
    // paid POST, so a worker that stalled past a takeover stops instead.
    const holds = async (run: Run, lease: string) =>
      !!must(
        await db
          .from("map_grid_runs")
          .select("id")
          .eq("id", run.id)
          .eq("status", "running")
          .eq("lease_until", lease)
          .maybeSingle(),
      );
    const postPlanned = async (run: Run, lease: string, deadline: number) => {
      const config = run.config;
      const planned = must(
        await db
          .from("map_grid_checks")
          .select("*")
          .eq("run_id", run.id)
          .eq("state", "planned")
          .order("point_index"),
      ) as GridCheck[];
      for (let offset = 0; offset < planned.length; offset += POST_BATCH) {
        // Planned checks have cost nothing; past the deadline they wait for the next invocation.
        if (Date.now() > deadline) return;
        // Post only the rows this claim actually moved: a row another worker
        // claimed (or swept to unknown) since the read above is not ours.
        const claimed = new Set(
          (
            (must(
              await db
                .from("map_grid_checks")
                .update({ state: "posting" })
                .in(
                  "id",
                  planned.slice(offset, offset + POST_BATCH).map((c) => c.id),
                )
                .eq("state", "planned")
                .select("id"),
            ) ?? []) as { id: string }[]
          ).map((c) => c.id),
        );
        const batch = planned
            .slice(offset, offset + POST_BATCH)
            .filter((c) => claimed.has(c.id)),
          ids = batch.map((c) => c.id);
        if (!ids.length) continue;
        // The claim may have waited on I/O. Past the deadline, or once the
        // lease is gone, nothing has been sent: hand the rows back unspent.
        // A row a newer worker already swept to unknown stays unknown.
        const lost = Date.now() > deadline || !(await holds(run, lease));
        // holds() awaited too: the clock is read once more right before the POST.
        if (lost || Date.now() > deadline) {
          must(
            await db
              .from("map_grid_checks")
              .update({ state: "planned" })
              .in("id", ids)
              .eq("state", "posting"),
          );
          return;
        }
        let posted;
        try {
          posted = await dfs(
            "/task_post",
            batch.map((c) => mapTask(c, config.zoom, config.search_this_area ?? true)),
          );
        } catch {
          must(
            await db
              .from("map_grid_checks")
              .update({
                state: "unknown",
                error:
                  "Submission outcome unknown; no automatic resubmission",
              })
              .in("id", ids)
              .eq("state", "posting"),
          );
          continue;
        }
        // Echoed tags bind replies to checks, even if the provider changes result order.
        for (const check of batch) {
          const t = posted.tasks.find(
            (t: { data?: { tag?: string } }) => t.data?.tag === check.id,
          );
          const accepted =
            t?.status_code === 20100 && typeof t.id === "string";
          must(
            await db
              .from("map_grid_checks")
              .update({
                state: accepted ? "queued" : t ? "failed" : "unknown",
                task_id: accepted ? t.id : null,
                cost: typeof t?.cost === "number" ? t.cost : 0,
                error: accepted
                  ? null
                  : `Submission status ${t?.status_code ?? "missing"}`,
              })
              .eq("id", check.id),
          );
        }
      }
    };
    const collectCheck = async (run: Run, check: QueuedCheck) => {
      try {
        const response = await dfs(
          `/task_get/advanced/${encodeURIComponent(check.task_id)}`,
        );
        const parsed = parseMapsTask(
          response.tasks[0] ?? {},
          run.config.target_place_id,
        );
        if (parsed.pending) {
          must(
            await db
              .from("map_grid_checks")
              .update({ checked_at: new Date().toISOString() })
              .eq("id", check.id),
          );
          return;
        }
        must(
          await db
            .from("map_grid_checks")
            .update({
              state: "complete",
              position: parsed.position,
              results: parsed.results,
              error: null,
              checked_at: new Date().toISOString(),
            })
            .eq("id", check.id),
        );
      } catch {
        // Transient fetch errors remain queued and are retried without a new paid task.
        must(
          await db
            .from("map_grid_checks")
            .update({
              error: "Result collection unavailable; will retry",
              checked_at: new Date().toISOString(),
            })
            .eq("id", check.id),
        );
      }
    };
    const settle = async (run: Run, reason?: string): Promise<Outcome> => {
      const states =
        must(
          await db
            .from("map_grid_checks")
            .select("state")
            .eq("run_id", run.id),
        ) ?? [];
      const remaining = states.some((x) =>
        ["planned", "posting", "queued"].includes(x.state),
      );
      const expired =
        Date.now() - new Date(run.started_at).getTime() > EXPIRY_MS;
      if (!remaining || expired) {
        if (expired)
          must(
            await db
              .from("map_grid_checks")
              .update({
                state: "failed",
                error: "Collection timed out after six hours",
              })
              .eq("run_id", run.id)
              .in("state", ["planned", "posting", "queued"]),
          );
        const completed = states.filter((x) => x.state === "complete").length;
        must(
          await db
            .from("map_grid_runs")
            .update({
              status:
                completed === run.expected_checks
                  ? "complete"
                  : completed
                    ? "partial"
                    : "failed",
              completed_at: new Date().toISOString(),
              error:
                completed === run.expected_checks
                  ? null
                  : (reason ? `${reason}. ` : "") +
                    "Some checks did not complete; missing checks are not ranking losses",
            })
            .eq("id", run.id),
        );
      }
      return {
        run_id: run.id,
        expected: run.expected_checks,
        complete: states.filter((x) => x.state === "complete").length,
      };
    };
    // Works the given running runs: post all planned checks (oldest run first),
    // then share one bounded collection budget fairly. Only ever called with
    // one run now; the multi-run fairness and COLLECT_TOTAL stay as defence.
    // A failure in one run is recorded on that run and never stops the others.
    const processRuns = async (runIds: string[]): Promise<Outcome[]> => {
      const deadline = Date.now() + WORK_MS;
      const outcomes = new Map<string, Outcome>();
      const leased: { run: Run; lease: string }[] = [];
      const fail = async (run: Run, e: unknown) => {
        const error = e instanceof Error ? e.message : "Grid worker failed";
        outcomes.set(run.id, { run_id: run.id, error });
        try {
          must(
            await db.from("map_grid_runs").update({ error }).eq("id", run.id),
          );
        } catch {
          /* The run stays running; the next invocation retries it. */
        }
      };
      try {
        // Each run keeps its own lease, so overlapping collectors split runs instead of sharing one.
        for (const id of runIds) {
          const now = new Date();
          const lease = new Date(now.getTime() + LEASE_MS).toISOString();
          try {
            const run = must(
              await db
                .from("map_grid_runs")
                .update({ lease_until: lease })
                .eq("id", id)
                .eq("status", "running")
                .lt("lease_until", now.toISOString())
                .select("*")
                .maybeSingle(),
            ) as Run | null;
            if (run) leased.push({ run, lease });
            else outcomes.set(id, { run_id: id, busy: true });
          } catch (e) {
            outcomes.set(id, {
              run_id: id,
              error: e instanceof Error ? e.message : "Grid lease failed",
            });
          }
        }
        // One run per lane, so a run's batches stay sequential while runs post side by side.
        await parallel(leased, POST_LANES, async ({ run, lease }) => {
          try {
            validateGrid(run.config);
            // A previous interrupted POST has an unknown outcome. Never blindly charge again.
            must(
              await db
                .from("map_grid_checks")
                .update({
                  state: "unknown",
                  error:
                    "Submission interrupted; review provider task before retrying",
                })
                .eq("run_id", run.id)
                .eq("state", "posting"),
            );
            await postPlanned(run, lease, deadline);
          } catch (e) {
            await fail(run, e);
          }
        });
        const live = leased.map((l) => l.run).filter((r) => !outcomes.has(r.id));
        const queues: QueuedCheck[][] = [];
        for (const run of live) {
          try {
            queues.push(
              (must(
                await db
                  .from("map_grid_checks")
                  .select("*")
                  .eq("run_id", run.id)
                  .eq("state", "queued")
                  .order("checked_at", { ascending: true, nullsFirst: true })
                  .limit(COLLECT_PER_RUN),
              ) ?? []) as QueuedCheck[],
            );
          } catch (e) {
            queues.push([]);
            await fail(run, e);
          }
        }
        // Round-robin across runs, so a large or slow run cannot starve the others.
        const turns: { run: Run; check: QueuedCheck }[] = [];
        for (let i = 0; i < COLLECT_PER_RUN; i++)
          live.forEach((run, r) => {
            if (queues[r][i]) turns.push({ run, check: queues[r][i] });
          });
        await parallel(turns.slice(0, COLLECT_TOTAL), READ_LANES, async ({ run, check }) => {
          if (outcomes.has(run.id) || Date.now() > deadline) return;
          try {
            await collectCheck(run, check);
          } catch (e) {
            if (!outcomes.has(run.id)) await fail(run, e);
          }
        });
        for (const run of live) {
          if (outcomes.has(run.id)) continue;
          try {
            outcomes.set(run.id, await settle(run));
          } catch (e) {
            await fail(run, e);
          }
        }
        // A run that errors on every pass still expires at six hours, so it
        // cannot hold its profile's one running slot (and block weekly starts).
        for (const { run } of leased) {
          const error = outcomes.get(run.id)?.error;
          if (!error || Date.now() - Date.parse(run.started_at) <= EXPIRY_MS)
            continue;
          try {
            await settle(run, error);
          } catch {
            /* Retried on the next invocation. */
          }
        }
      } finally {
        for (const { run, lease } of leased) {
          try {
            must(
              await db
                .from("map_grid_runs")
                .update({ lease_until: new Date().toISOString() })
                .eq("id", run.id)
                .eq("lease_until", lease),
            );
          } catch {
            /* An unreleased lease expires on its own after LEASE_MS. */
          }
        }
      }
      return runIds.map((id) => outcomes.get(id) ?? { run_id: id, busy: true });
    };
    const start = async (profileId: string, key: string) => {
      // A key that already names a run is a re-dispatch (weekly, collect or a
      // repeated click): work that run, exactly as map_grid_start would return
      // it. No new run, no spend, and a later profile edit cannot strand the
      // run; processRuns validates its frozen config before any post.
      const existing = must(
        await db
          .from("map_grid_runs")
          .select("id")
          .eq("profile_id", profileId)
          .eq("request_key", key)
          .maybeSingle(),
      ) as { id: string } | null;
      if (existing) return existing.id;
      const profile = must(
        await db
          .from("map_grid_profiles")
          .select("*")
          .eq("id", profileId)
          .single(),
      );
      validateGrid(profile as GridConfig);
      const { data, error } = await db.rpc("map_grid_start", {
        p_profile_id: profileId,
        p_request_key: key,
      });
      if (error) {
        const outcome = error.message.includes("already running")
          ? "already_running"
          : error.message.includes("one hour")
            ? "cooldown"
            : error.message.includes("disabled")
              ? "disabled"
              : "error";
        throw Object.assign(
          Error(
            outcome === "already_running"
              ? "A grid scan is already running"
              : outcome === "cooldown"
                ? "Wait one hour before another scan"
                : "Unable to start this grid scan",
          ),
          { outcome, detail: error.message },
        );
      }
      return data as string;
    };
    if (body.mode === "start") {
      if (
        typeof body.profile_id !== "string" ||
        typeof body.request_key !== "string" ||
        body.request_key.length > 100
      )
        return Response.json(
          { error: "Profile and request key required" },
          { status: 400 },
        );
      const runId = await start(body.profile_id, body.request_key);
      if (body.wait === true) {
        const [outcome] = await processRuns([runId]);
        if (outcome.error) throw Error(outcome.error);
        return Response.json(outcome);
      }
      EdgeRuntime.waitUntil(processRuns([runId]).catch(() => {}));
      return Response.json(
        { run_id: runId, status: "accepted" },
        { status: 202 },
      );
    }
    if (body.mode === "weekly" && !isCron)
      return Response.json({ error: "Scheduler only" }, { status: 403 });
    if (body.mode === "weekly" || body.mode === "collect") {
      // One run per invocation: re-send `start` with the run's own request key.
      // Each child has its own CPU budget and takes its own per-run lease, so
      // a run another worker holds is simply skipped there.
      type Due = { id: string; profile_id: string; request_key: string };
      const dispatch = async (runs: Due[]) => {
        if (!runs.length) return [];
        const anon = await secret("SUPABASE_ANON_KEY");
        const cron = cronSecret;
        if (!anon || !cron) throw Error("Grid dispatch is not configured");
        const self = `${Deno.env.get("SUPABASE_URL")}/functions/v1/map-grid-sync`;
        const sent: { run_id: string; status: number | "error" }[] = [];
        await parallel(runs, DISPATCH_LANES, async (run) => {
          let status: number | "error";
          try {
            const response = await fetch(self, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${anon}`,
                "x-cron-secret": cron,
              },
              body: JSON.stringify({
                mode: "start",
                profile_id: run.profile_id,
                request_key: run.request_key,
              }),
              signal: AbortSignal.timeout(30000),
            });
            status = response.status;
            await response.body?.cancel();
          } catch {
            status = "error";
          }
          // An undelivered run stays running; the next five-minute tick dispatches it again.
          if (status !== 202)
            console.error("Grid run not dispatched", run.id, status);
          sent.push({ run_id: run.id, status });
        });
        return sent;
      };
      const work = async () => {
        const attempts: Record<string, unknown>[] = [];
        const due = new Map<string, Due>();
        if (body.mode === "weekly") {
          const profiles = must(
            await db
              .from("map_grid_profiles")
              .select("id")
              .eq("enabled", true)
              .eq("weekly_enabled", true),
          );
          const key = `weekly:${new Date().toISOString().slice(0, 10)}`;
          for (const p of profiles ?? []) {
            let attempt: {
              outcome: string;
              run_id: string | null;
              message: string | null;
            };
            try {
              // Database only: freezes the run and plans its checks. Nothing is posted here.
              attempt = {
                outcome: "started",
                run_id: await start(p.id, key),
                message: null,
              };
            } catch (e) {
              const err = e as Error & { outcome?: string; detail?: string };
              attempt = {
                outcome: err.outcome ?? "error",
                run_id: null,
                message: String(
                  err.detail ?? err.message ?? "Unable to start this grid scan",
                ).slice(0, 500),
              };
            }
            // Every weekly outcome is kept, so a skipped week is visible instead of silent.
            const row = { profile_id: p.id, request_key: key, ...attempt };
            const { error } = await db
              .from("map_grid_weekly_attempts")
              .insert(row);
            if (error)
              console.error("Weekly grid attempt not recorded", p.id);
            attempts.push(row);
            if (attempt.run_id)
              due.set(attempt.run_id, {
                id: attempt.run_id,
                profile_id: p.id,
                request_key: key,
              });
          }
        }
        // Every running run whose lease is free, oldest first.
        const free = must(
          await db
            .from("map_grid_runs")
            .select("id,profile_id,request_key")
            .eq("status", "running")
            .lt("lease_until", new Date().toISOString())
            .order("started_at")
            .limit(MAX_RUNS),
        ) as Due[] | null;
        for (const run of free ?? []) if (!due.has(run.id)) due.set(run.id, run);
        return {
          ...(body.mode === "weekly" ? { attempts } : {}),
          dispatched: await dispatch([...due.values()]),
        };
      };
      if (body.wait === true) return Response.json(await work());
      EdgeRuntime.waitUntil(
        work().catch((e) =>
          console.error("Grid dispatch failed", e instanceof Error ? e.message : e),
        ),
      );
      return Response.json({ status: "accepted" }, { status: 202 });
    }
    return Response.json({ error: "Unknown mode" }, { status: 400 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Grid request failed" },
      { status: 503 },
    );
  }
});
