import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type EngineAnswer = { status: number | null; body: Record<string, unknown> | null };

// A render takes a few seconds (cold starts fetch and check the pinned WASM).
export const ENGINE_TIMEOUT_MS = 60_000;

// Calls the deployed creative-engine function with the signed-in teammate's
// own JWT (the function checks it against team_members, and the database
// stamps the run with that teammate). A plain server module: callers are
// server actions that have already checked the caller is on the team.
export async function callCreativeEngine(supabase: Supabase, body: Record<string, unknown>): Promise<EngineAnswer> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { status: 401, body: null };
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/creative-engine`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      cache: "no-store",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    // Timeout or network error: the render may or may not have finished.
    return { status: null, body: null };
  }
}

// What to tell the teammate. A refusal names its reason (the renderer's own
// message: which governed value, photo or approval is missing).
export function engineMessage(a: EngineAnswer): { ok: boolean; text: string } {
  const b = a.body ?? {};
  const message = typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : null;
  if (a.status === 200) {
    return { ok: true, text: b.reused ? "Already rendered with these inputs; the existing graphic stands." : "Graphic rendered and linked." };
  }
  if (a.status === null) return { ok: false, text: "The Creative Engine did not answer in time. Reload in a minute; the graphic may have finished." };
  if (a.status === 401) return { ok: false, text: "Your session expired. Sign in again and retry." };
  if (a.status === 403) return { ok: false, text: "Only Compass team members can render creative." };
  if (a.status === 404 && !message) return { ok: false, text: "The Creative Engine is not deployed yet." };
  if (a.status === 409 && b.code === "run_in_progress") return { ok: false, text: "This graphic is already rendering. Reload in a moment." };
  if (a.status === 409 || a.status === 404) return { ok: false, text: `Refused${b.code ? ` (${String(b.code).replace(/_/g, " ")})` : ""}: ${message ?? "no reason given"}` };
  return { ok: false, text: `The render failed${message ? `: ${message}` : ""}. Nothing was linked; try again.` };
}
