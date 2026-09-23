"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseMeasurement } from "@/lib/reporting";

export type ReportActionState = { error?: string; savedId?: string };

export async function recordMeasurementAction(clientId: string, _previous: ReportActionState, form: FormData): Promise<ReportActionState> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: "Sign in again before saving a measurement." };
  const { data: isTeam, error: teamError } = await supabase.rpc("is_team");
  if (teamError || !isTeam) return { error: "Only Compass team members can record measurements." };
  let input;
  try {
    input = parseMeasurement(clientId, form);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Check the measurement fields." };
  }
  const { data: client, error: clientError } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (clientError || !client) return { error: "This client is unavailable to your account." };

  // Stable ID makes retries safe. INSERT only; never upsert over a baseline.
  const { error } = await supabase.from("report_measurements").insert(input);
  if (error?.code === "23505") {
    const { data: existing } = await supabase.from("report_measurements").select("*").eq("client_id", clientId).eq("id", input.id).maybeSingle();
    if (!existing || Object.entries(input).some(([key, value]) => existing[key as keyof typeof existing] !== value)) {
      return { error: "This submission was already used for different data. Start a new entry." };
    }
  } else if (error) {
    return { error: "The measurement could not be saved. Check that reporting setup is approved and the dates and values are valid. Your entry has been kept for retry." };
  }
  revalidatePath(`/clients/${clientId}/reports`);
  return { savedId: input.id };
}
