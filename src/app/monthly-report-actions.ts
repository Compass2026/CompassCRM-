"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";
import { buildMonthlyReport, reportPeriods, type Editorial } from "@/lib/monthly-report";
import { loadMonthlyReportInput } from "@/lib/monthly-report-data";

// Every write goes through the monthly_report_* functions, which check the
// signed-in teammate, the version and the hash. Nothing here sends anything.
const str = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const listPath = (clientId: string) => `/clients/${clientId}/reports/monthly`;
const reportPath = (clientId: string, id: string) => `${listPath(clientId)}/${id}`;
const back = (path: string, message: string): never => redirect(`${path}?error=${encodeURIComponent(message.slice(0, 300))}`);

export async function generateMonthlyReportAction(clientId: string, form: FormData) {
  const now = new Date().toISOString();
  const period = str(form, "period");
  const requestKey = str(form, "request_key");
  if (!period || !reportPeriods(now, 6).includes(period)) back(listPath(clientId), "Choose one of the listed months.");
  if (!requestKey) back(listPath(clientId), "The form expired; reload and try again.");
  const db = await createClient();
  const loaded = await loadMonthlyReportInput(db, clientId, period!, now);
  if (loaded.error !== null) back(listPath(clientId), loaded.error === "not_found" ? "Client not found." : loaded.error);
  const { defaultEditorial, ...snapshot } = buildMonthlyReport(loaded.data!, period!, now);
  // The first version starts from the generated next actions; later versions
  // keep what the team wrote.
  const { count } = await db.from("monthly_reports").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("period", snapshot.period);
  const { data, error } = await db.rpc("monthly_report_save", {
    p_client_id: clientId, p_brand_workspace_id: null, p_period: snapshot.period, p_cutoff: snapshot.cutoff,
    p_calculation_version: snapshot.calculation_version, p_snapshot: snapshot as unknown as Json,
    p_editorial: count ? null : (defaultEditorial as unknown as Json), p_request_key: requestKey!,
    p_correction_reason: str(form, "correction_reason"),
  });
  if (error) back(listPath(clientId), error.message);
  revalidatePath(listPath(clientId));
  redirect(reportPath(clientId, (data as { report_id: string }).report_id));
}

export async function editMonthlyReportAction(clientId: string, reportId: string, form: FormData) {
  const causes = (str(form, "causes") ?? "").split("\n").map(s => s.trim()).filter(Boolean).slice(0, 5);
  const actions = [0, 1, 2].map(i => ({ action: str(form, `action_${i}`) ?? "", reason: str(form, `reason_${i}`) ?? "", owner: str(form, `owner_${i}`) ?? "" }))
    .filter(a => a.action);
  if (actions.some(a => !a.reason || !a.owner)) back(reportPath(clientId, reportId), "Every next action needs a reason and an owner.");
  const editorial: Editorial = { causes, actions, note: str(form, "note") ?? "" };
  const db = await createClient();
  const { error } = await db.rpc("monthly_report_edit", { p_report_id: reportId, p_edit_version: Number(str(form, "edit_version")), p_editorial: editorial as unknown as Json });
  if (error) back(reportPath(clientId, reportId), error.message);
  revalidatePath(reportPath(clientId, reportId));
  redirect(reportPath(clientId, reportId));
}

export async function submitMonthlyReportAction(clientId: string, reportId: string, form: FormData) {
  const db = await createClient();
  const { error } = await db.rpc("monthly_report_submit", { p_report_id: reportId, p_edit_version: Number(str(form, "edit_version")) });
  if (error) back(reportPath(clientId, reportId), error.message);
  revalidatePath(reportPath(clientId, reportId));
  redirect(reportPath(clientId, reportId));
}

export async function approveMonthlyReportAction(clientId: string, reportId: string, form: FormData) {
  const recipients = (str(form, "recipients") ?? "").split(/[\s,;]+/).filter(Boolean);
  const db = await createClient();
  const { error } = await db.rpc("monthly_report_approve", {
    p_report_id: reportId, p_content_hash: str(form, "content_hash") ?? "", p_destination: str(form, "destination") ?? "",
    p_recipients: recipients, p_accept_incomplete: form.get("accept_incomplete") === "on",
  });
  if (error) back(reportPath(clientId, reportId), error.message);
  revalidatePath(reportPath(clientId, reportId));
  redirect(reportPath(clientId, reportId));
}

// Records what Tom did after sending it himself (or publishing it to the
// portal). It never sends, and "uncertain" is never counted as sent.
export async function recordMonthlyReportDeliveryAction(clientId: string, reportId: string, form: FormData) {
  const db = await createClient();
  const { data: report } = await db.from("monthly_reports").select("approved_destination,approved_recipients").eq("id", reportId).maybeSingle();
  if (!report?.approved_destination) back(reportPath(clientId, reportId), "Only an approved version is delivered.");
  const { error } = await db.rpc("monthly_report_record_delivery", {
    p_report_id: reportId, p_destination: report!.approved_destination!, p_recipients: report!.approved_recipients ?? [],
    p_outcome: str(form, "outcome") ?? "", p_detail: str(form, "detail") ?? "", p_request_key: str(form, "request_key") ?? "",
  });
  if (error) back(reportPath(clientId, reportId), error.message);
  revalidatePath(reportPath(clientId, reportId));
  redirect(reportPath(clientId, reportId));
}
