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
const VERSION = "map-grid-v1";
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
async function parallel<T>(items: T[], fn: (item: T) => Promise<void>) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, items.length) }, async () => {
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
    const processRun = async (runId: string) => {
      const now = new Date();
      const lease = new Date(now.getTime() + 600000).toISOString();
      const run = must(
        await db
          .from("map_grid_runs")
          .update({ lease_until: lease })
          .eq("id", runId)
          .eq("status", "running")
          .lt("lease_until", now.toISOString())
          .select("*")
          .maybeSingle(),
      );
      if (!run) return { run_id: runId, busy: true };
      try {
        const config = run.config as GridConfig;
        validateGrid(config);
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
        const planned = must(
          await db
            .from("map_grid_checks")
            .select("*")
            .eq("run_id", run.id)
            .eq("state", "planned")
            .order("point_index"),
        ) as GridCheck[];
        for (let offset = 0; offset < planned.length; offset += 100) {
          const batch = planned.slice(offset, offset + 100),
            ids = batch.map((c) => c.id);
          must(
            await db
              .from("map_grid_checks")
              .update({ state: "posting" })
              .in("id", ids)
              .eq("state", "planned"),
          );
          let posted;
          try {
            posted = await dfs(
              "/task_post",
              batch.map((c) => mapTask(c, config.zoom)),
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
                .in("id", ids),
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
        const queued = must(
          await db
            .from("map_grid_checks")
            .select("*")
            .eq("run_id", run.id)
            .eq("state", "queued")
            .order("checked_at", { ascending: true, nullsFirst: true })
            .limit(60),
        );
        await parallel(queued ?? [], async (check) => {
          try {
            const response = await dfs(
              `/task_get/advanced/${encodeURIComponent(check.task_id)}`,
            );
            const parsed = parseMapsTask(
              response.tasks[0] ?? {},
              config.target_place_id,
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
        });
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
          Date.now() - new Date(run.started_at).getTime() > 6 * 3600000;
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
                    : "Some checks did not complete; missing checks are not ranking losses",
              })
              .eq("id", run.id),
          );
        }
        return {
          run_id: run.id,
          expected: run.expected_checks,
          complete: states.filter((x) => x.state === "complete").length,
        };
      } catch (e) {
        must(
          await db
            .from("map_grid_runs")
            .update({
              error: e instanceof Error ? e.message : "Grid worker failed",
            })
            .eq("id", run.id),
        );
        throw e;
      } finally {
        must(
          await db
            .from("map_grid_runs")
            .update({ lease_until: new Date().toISOString() })
            .eq("id", run.id)
            .eq("lease_until", lease),
        );
      }
    };
    const start = async (profileId: string, key: string) => {
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
      if (error)
        throw Error(
          error.message.includes("already running")
            ? "A grid scan is already running"
            : error.message.includes("one hour")
              ? "Wait one hour before another scan"
              : "Unable to start this grid scan",
        );
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
      if (body.wait === true) return Response.json(await processRun(runId));
      EdgeRuntime.waitUntil(processRun(runId).catch(() => {}));
      return Response.json(
        { run_id: runId, status: "accepted" },
        { status: 202 },
      );
    }
    if (body.mode === "weekly" && !isCron)
      return Response.json({ error: "Scheduler only" }, { status: 403 });
    if (body.mode === "weekly" || body.mode === "collect") {
      const work = async () => {
        if (body.mode === "weekly") {
          const profiles = must(
            await db
              .from("map_grid_profiles")
              .select("id")
              .eq("enabled", true)
              .eq("weekly_enabled", true),
          );
          for (const p of profiles ?? []) {
            try {
              await start(
                p.id,
                `weekly:${new Date().toISOString().slice(0, 10)}`,
              );
            } catch {
              /* Existing run stays in the collector. */
            }
          }
        }
        const runs = must(
          await db
            .from("map_grid_runs")
            .select("id")
            .eq("status", "running")
            .order("started_at")
            .limit(1),
        );
        return await Promise.all((runs ?? []).map((r) => processRun(r.id)));
      };
      if (body.wait === true) return Response.json({ runs: await work() });
      EdgeRuntime.waitUntil(work().catch(() => {}));
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
