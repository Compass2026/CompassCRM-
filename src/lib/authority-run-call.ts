import type { createClient } from "@/lib/supabase/server";
import { START_TIMEOUT_MS, startOutcome, type Mode, type StartOutcome } from "@/lib/authority-controls";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// Asks the deployed authority-run function to start a run, with the signed-in
// teammate's own JWT (the function checks it against team_members). A plain
// server module, not an action: callers are server actions that have already
// checked the caller is on the team.
export async function callAuthorityRun(supabase: Supabase, clientId: string, mode: Mode): Promise<StartOutcome> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return startOutcome(mode, 401, null);
  let status: number | null = null;
  let body: unknown = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/authority-run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode, client_id: clientId }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      cache: "no-store",
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    // Timeout or network error: the run may or may not have begun.
    status = null;
  }
  return startOutcome(mode, status, body);
}
