// Deployed entry point (verify_jwt = false: a website server calls it; the
// source token is the authentication). The logic is handler.ts, tested with a
// fake store (tests/inquiry-intake-handler.test.mjs); the database boundary
// is crm_ingest_inquiry, tested in the sandbox (crm_lite.test.sql).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createInquiryIntake } from "./handler.ts";
import { createStore } from "./store.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const store = createStore(supabase);

// A queued alert is handed to crm-lite at once (it re-checks every gate);
// the pg_cron tick picks up anything this misses.
async function kick(): Promise<void> {
  const [anon, cron] = await Promise.all([store.secret("SUPABASE_ANON_KEY"), store.secret("SYNC_CRON_SECRET")]);
  if (!anon || !cron) return;
  await fetch(`${supabaseUrl}/functions/v1/crm-lite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, "x-cron-secret": cron },
    body: JSON.stringify({ mode: "dispatch" }),
    signal: AbortSignal.timeout(30_000),
  });
}

const fn = createInquiryIntake({
  store,
  kick,
  waitUntil: (p) => { if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p); },
  log: (event, detail) => console.log(JSON.stringify({ fn: "inquiry-intake", event, ...detail })),
});

Deno.serve((req) => fn.handle(req));
