// Worker Google operations switch (app_settings 'worker_google_ops').
//
// Holding a Google credential is not permission to change a client's Google
// properties. Connect Google only stores the token and reports what it can
// see; whether the unattended worker may WRITE to Google (Business Profile
// edits, GA4 properties, Gmail drafts, Q&A, sitemap submissions, anything
// added later) is this separate switch, OFF unless a person turns it on.
//
// Rules, shared by every Edge Function that can write to Google:
// - Only an explicit { enabled: true } turns it on. A missing row, a string
//   "true", or anything unreadable is OFF.
// - Every op is a write unless it is on READ_ONLY_GOOGLE_OPS: an op added
//   later is refused until someone decides it is read-only.
// - The switch binds automated callers (the x-cron-secret door the worker
//   uses). A signed-in team member acting in person is not the worker.
// - The GBP post-publisher is not governed here; it has its own switch and
//   pilot list (app_settings 'publisher'). The two are never combined.
//
// Pure apart from settingEnabled(), which reads one row.

export const WORKER_GOOGLE_SETTING = "worker_google_ops";

// google-ops ops that only read from Google. gbp_locate lists the accounts
// and locations the token manages; it writes nothing to Google (it records
// the match on the CRM's own clients row).
export const READ_ONLY_GOOGLE_OPS: ReadonlySet<string> = new Set(["gbp_locate"]);

export function isGoogleWrite(op: string): boolean {
  return !READ_ONLY_GOOGLE_OPS.has(op);
}

export type WorkerGoogleSetting = { enabled: boolean; changed_by: string | null; changed_at: string | null };

export function parseWorkerGoogleSetting(value: unknown): WorkerGoogleSetting {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    enabled: v.enabled === true,
    changed_by: typeof v.changed_by === "string" ? v.changed_by : null,
    changed_at: typeof v.changed_at === "string" ? v.changed_at : null,
  };
}

// deno-lint-ignore no-explicit-any
type Supabase = any;

// Reads the switch. Any error reads as OFF.
export async function workerGoogleOpsEnabled(supabase: Supabase): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("app_settings").select("value").eq("key", WORKER_GOOGLE_SETTING).maybeSingle();
    if (error) return false;
    return parseWorkerGoogleSetting(data?.value).enabled;
  } catch {
    return false;
  }
}

// The answer an automated caller gets when the switch is off. status
// "skipped" is what the worker already turns into Tom's task.
export function workerGoogleRefusal(op: string) {
  return {
    op,
    status: "skipped" as const,
    reason: "worker_google_ops_off",
    detail:
      "Worker Google operations are switched off (Settings → Google hands → Worker Google operations). Nothing was sent to Google; a person can do this step, or turn the switch on.",
  };
}
