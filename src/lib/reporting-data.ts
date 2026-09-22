import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Measurement } from "@/lib/reporting";

export async function loadReportMeasurements(supabase: SupabaseClient<Database>, clientId: string): Promise<{ rows: Measurement[]; error: string | null }> {
  const rows: Measurement[] = [];
  // PostgREST caps a single result set. Never silently lose the original baseline.
  const pageSize = 500;
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const { data, error } = await supabase.from("report_measurements").select("*").eq("client_id", clientId).order("sequence", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) return { rows: [], error: ["42P01", "PGRST205"].includes(error.code) ? "Scorecard setup is awaiting the reviewed database migration. Existing monthly reports remain available below." : "Scorecard data could not be loaded. Retry before reviewing or recording measurements." };
    rows.push(...(data ?? []) as Measurement[]);
    if ((data?.length ?? 0) < pageSize) return { rows, error: null };
  }
  return { rows: [], error: "This client's report history exceeds the current loading limit. Ask the team to enable server-side history paging before reviewing comparisons." };
}
