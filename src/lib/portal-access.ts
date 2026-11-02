import "server-only";
import { redirect } from "next/navigation";
import type { createClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createClient>>;

export async function hasPortalReportingAccess(supabase: Client) {
  const { data, error } = await supabase.rpc("portal_has_reporting_access");
  if (error) throw new Error("Unable to verify portal permissions. Please retry.");
  return data === true;
}

// Guard each page and action, not just the layout or navigation. Database views
// and billing backends independently enforce this scope for direct API requests.
export async function requirePortalReportingAccess(supabase: Client) {
  if (!(await hasPortalReportingAccess(supabase))) redirect("/portal/inquiries");
}
