import type { PostgrestError } from "@supabase/supabase-js";

// Postgres raises our sequencing gates and the Foundation protection as
// check_violation. They are expected outcomes of clicking the wrong thing, not
// bugs, so the UI shows them as a banner instead of an error page.
const CHECK_VIOLATION = "23514";

export type BlockedReason = { message: string; hint: string | null };

export function blockedReason(error: PostgrestError): BlockedReason | null {
  if (error.code !== CHECK_VIOLATION) return null;
  return { message: error.message, hint: error.hint ?? null };
}

export function blockedQuery(reason: BlockedReason): string {
  const params = new URLSearchParams({ blocked: reason.message });
  if (reason.hint) params.set("hint", reason.hint);
  return params.toString();
}
