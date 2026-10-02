import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type CallResult = { status: number | null; body: Record<string, unknown> | null };

// Asks the deployed communications function to act, with the signed-in
// teammate's own JWT (the function checks it against team_members, and admin
// modes against the admin role). A plain server module: callers are server
// actions that have already checked the caller is on the team. No Twilio
// credential exists on this side.
export async function callCommunications(supabase: Supabase, body: Record<string, unknown>, timeoutMs = 30_000): Promise<CallResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, body: null };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/communications`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: null, body: null };
  }
}
