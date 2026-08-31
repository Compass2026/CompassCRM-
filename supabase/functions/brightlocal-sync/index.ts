// BrightLocal sync — ingests Local Rank Tracker + Local Search Grid results
// into rank_snapshots / grid_snapshots and recomputes location_index.
//
// The BrightLocal reports already exist and run on BrightLocal's weekly
// scheduler; this function only READS results (no billable report runs).
// Triggered monthly by pg_cron (1st, 07:00 UTC) and on demand from the app's
// "Sync BrightLocal" button. Optional body: { client_id } to sync one client.
//
// Responds 202 immediately and finishes in the background (EdgeRuntime
// waitUntil) — progress lands in rank_runs.

import { createClient } from "npm:@supabase/supabase-js@2";

const BL_BASE = "https://api.brightlocal.com/manage/v1";

type LrtEntry = { rank: number; type: string; date: string };

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Authorize: a signed-in team member (JWT in Authorization) or the cron job
  // (x-cron-secret matching the vault secret).
  const { data: cronSecret } = await supabase.rpc("get_secret", {
    secret_name: "SYNC_CRON_SECRET",
  });
  const isCron =
    req.headers.get("x-cron-secret") &&
    req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const { data: apiKey } = await supabase.rpc("get_secret", {
    secret_name: "BRIGHTLOCAL_API_KEY",
  });
  if (!apiKey) {
    return Response.json(
      { error: "BRIGHTLOCAL_API_KEY not configured" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const onlyClientId: string | null = body.client_id ?? null;
  const triggeredBy = body.triggered_by === "cron" ? "cron" : "manual";

  async function bl(path: string) {
    const res = await fetch(`${BL_BASE}${path}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`BrightLocal ${path} -> ${res.status}`);
    return res.json();
  }

  let locQuery = supabase
    .from("locations")
    .select(
      "id, client_id, name, brightlocal_location_id, brightlocal_lrt_report_id"
    )
    .eq("is_active", true)
    .not("brightlocal_lrt_report_id", "is", null);
  if (onlyClientId) locQuery = locQuery.eq("client_id", onlyClientId);
  const { data: locations, error: locError } = await locQuery;
  if (locError) {
    return Response.json({ error: locError.message }, { status: 500 });
  }

  const clientIds = [...new Set((locations ?? []).map((l) => l.client_id))];
  const runIds = new Map<string, string>();
  for (const cid of clientIds) {
    const { data: run } = await supabase
      .from("rank_runs")
      .insert({ client_id: cid, triggered_by: triggeredBy, status: "running" })
      .select("id")
      .single();
    if (run) runIds.set(cid, run.id);
  }

  const job = (async () => {
    const stats = {
      lrt_snapshots: 0,
      grid_snapshots: 0,
      keywords_created: 0,
      errors: [] as string[],
    };

    for (const loc of locations ?? []) {
      const runId = runIds.get(loc.client_id) ?? null;
      try {
        const { data: existingKws } = await supabase
          .from("keywords")
          .select("id, keyword")
          .eq("client_id", loc.client_id);
        const kwByText = new Map(
          (existingKws ?? []).map((k) => [k.keyword.toLowerCase(), k.id])
        );

        async function keywordId(text: string): Promise<string | null> {
          const lower = text.toLowerCase();
          const existing = kwByText.get(lower);
          if (existing) return existing;
          const { data: created } = await supabase
            .from("keywords")
            .insert({ client_id: loc.client_id, keyword: lower, department: "seo" })
            .select("id")
            .single();
          if (!created) return null;
          kwByText.set(lower, created.id);
          stats.keywords_created++;
          return created.id;
        }

        // ── Mode A: Local Rank Tracker ─────────────────────────────────
        const result = await bl(
          `/lrt/reports/${loc.brightlocal_lrt_report_id}/result`
        );
        const byKeyword: {
          keyword: string;
          results: Record<string, LrtEntry[]>;
        }[] = result?.rankings?.by_keyword ?? [];

        const rankRows: Record<string, unknown>[] = [];
        for (const row of byKeyword) {
          const kwId = await keywordId(row.keyword);
          if (!kwId) continue;

          const google = row.results?.google ?? [];
          const places = row.results?.["google-places"] ?? [];
          const organic = google.filter((e) => e.type === "Organic");
          const local = google.filter((e) => e.type === "Local");

          const bestOrganic = organic.length
            ? Math.min(...organic.map((e) => e.rank))
            : null;
          const bestMap = local.length
            ? Math.min(...local.map((e) => e.rank))
            : places.length
              ? Math.min(...places.map((e) => e.rank))
              : null;
          const date = (google[0] ?? places[0])?.date;
          const recordedAt = date
            ? new Date(date.replace(" ", "T") + "Z").toISOString()
            : new Date().toISOString();

          for (const [resultType, position] of [
            ["organic", bestOrganic],
            ["map_pack", bestMap],
          ] as const) {
            rankRows.push({
              keyword_id: kwId,
              location_id: loc.id,
              result_type: resultType,
              position,
              recorded_at: recordedAt,
              source: "brightlocal_report",
              run_id: runId,
            });
          }
        }
        if (rankRows.length > 0) {
          // Unique index (keyword, location, type, recorded_at, source)
          // makes re-ingesting the same weekly result a no-op.
          const { data: inserted, error } = await supabase
            .from("rank_snapshots")
            .upsert(rankRows, {
              onConflict: "keyword_id,location_id,result_type,recorded_at,source",
              ignoreDuplicates: true,
            })
            .select("id");
          if (error) stats.errors.push(`${loc.name} snapshots: ${error.message}`);
          else stats.lrt_snapshots += (inserted ?? []).length;
        }

        // ── Mode B: Local Search Grid ──────────────────────────────────
        const { data: gridConfig } = await supabase
          .from("grid_configs")
          .select("id, brightlocal_lsg_report_id")
          .eq("location_id", loc.id)
          .maybeSingle();
        if (gridConfig?.brightlocal_lsg_report_id) {
          const lsgList = await bl(
            `/lsg/reports?location_id=${loc.brightlocal_location_id}&num_per_page=10`
          );
          const lsgReport = (lsgList?.items ?? []).find(
            (r: { report_id: number }) =>
              String(r.report_id) === gridConfig.brightlocal_lsg_report_id
          );
          const keywords: { id: number; keyword: string }[] =
            lsgReport?.keywords ?? [];

          const runsPerKw = await Promise.all(
            keywords.map(async (kw) => ({
              kw,
              runs: await bl(
                `/lsg/reports/${gridConfig.brightlocal_lsg_report_id}/keywords/${kw.id}/runs?num_per_page=10`
              ).catch(() => null),
            }))
          );

          const gridRows: Record<string, unknown>[] = [];
          for (const { kw, runs } of runsPerKw) {
            const latest = (runs?.items ?? []).find(
              (r: { status: string }) => r.status === "finished"
            );
            if (!latest) continue;
            const kwId = await keywordId(kw.keyword);
            if (!kwId) continue;
            const recordedAt = new Date(
              latest.end_date.replace(" ", "T") + "Z"
            ).toISOString();
            gridRows.push({
              grid_config_id: gridConfig.id,
              keyword_id: kwId,
              recorded_at: recordedAt,
              avg_map_rank: latest.summary?.avg_rank ?? null,
              points: (latest.grid_points ?? []).map(
                (p: { latitude: number; longitude: number; rank: number }) => ({
                  lat: p.latitude,
                  lng: p.longitude,
                  position: p.rank,
                })
              ),
              report_url: latest.grid_url ?? null,
              run_id: runId,
            });
          }
          if (gridRows.length > 0) {
            const { data: inserted, error } = await supabase
              .from("grid_snapshots")
              .upsert(gridRows, {
                onConflict: "grid_config_id,keyword_id,recorded_at",
                ignoreDuplicates: true,
              })
              .select("id");
            if (error) stats.errors.push(`${loc.name} grid: ${error.message}`);
            else stats.grid_snapshots += (inserted ?? []).length;
          }
        }
      } catch (e) {
        stats.errors.push(
          `${loc.name}: ${e instanceof Error ? e.message : e}`
        );
      }
    }

    // ── City Index rollup for the current month ──────────────────────────
    const period = new Date().toISOString().slice(0, 7) + "-01";
    for (const loc of locations ?? []) {
      const { data: kws } = await supabase
        .from("keywords")
        .select("id, priority")
        .eq("client_id", loc.client_id)
        .eq("is_active", true);
      const p1 = (kws ?? []).filter((k) => k.priority === "p1");
      const scope = p1.length > 0 ? p1 : kws ?? []; // all until P1s are set
      const kwIds = scope.map((k) => k.id);
      if (kwIds.length === 0) continue;

      const { data: snaps } = await supabase
        .from("rank_snapshots")
        .select("keyword_id, result_type, position, recorded_at")
        .eq("location_id", loc.id)
        .in("keyword_id", kwIds)
        .gte("recorded_at", period)
        .order("recorded_at", { ascending: false });

      const best = new Map<string, number>();
      for (const s of snaps ?? []) {
        if (s.position == null) continue;
        const key = `${s.keyword_id}:${s.result_type}`;
        if (!best.has(key)) best.set(key, s.position);
      }
      const avg = (type: string) => {
        const vals = kwIds
          .map((id) => best.get(`${id}:${type}`))
          .filter((v): v is number => typeof v === "number");
        return vals.length
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) /
              100
          : null;
      };
      await supabase.from("location_index").upsert(
        {
          location_id: loc.id,
          period,
          organic_index: avg("organic"),
          map_index: avg("map_pack"),
          keywords_counted: kwIds.length,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "location_id,period" }
      );
    }

    // Close out run rows and attach a summary to open monthly cycles
    for (const cid of clientIds) {
      const runId = runIds.get(cid);
      if (runId) {
        await supabase
          .from("rank_runs")
          .update({
            status: stats.errors.length ? "failed" : "complete",
            completed_at: new Date().toISOString(),
            checks_count: stats.lrt_snapshots + stats.grid_snapshots,
            error: stats.errors.length ? stats.errors.join("; ") : null,
          })
          .eq("id", runId);
      }
      await supabase
        .from("monthly_cycles")
        .update({
          rank_summary: {
            synced_at: new Date().toISOString(),
            lrt_snapshots: stats.lrt_snapshots,
            grid_snapshots: stats.grid_snapshots,
          },
        })
        .eq("client_id", cid)
        .eq("period", period)
        .eq("status", "open");
    }
  })();

  EdgeRuntime.waitUntil(job);

  return Response.json(
    { ok: true, started: true, locations: (locations ?? []).length },
    { status: 202 }
  );
});
