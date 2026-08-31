import { createClient } from "@/lib/supabase/server";
import { PipelineBoard } from "@/components/pipeline-board";

export default async function PipelinesPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const { data: enrollments } = await supabase
    .from("client_pipelines")
    .select(
      `id, status, enrolled_at, completed_at,
       pipelines(id, key, name, sort_order, is_recurring),
       client_stages(
         id, status, owner, due_date, started_at, completed_at, evidence,
         next_action, notes,
         stages(id, name, sort_order, is_optional, description),
         tasks(id, title, owner, status, due_date, notes),
         deliverables(id, label, url, type)
       )`
    )
    .eq("client_id", clientId);

  const sorted = (enrollments ?? []).sort(
    (a, b) => (a.pipelines?.sort_order ?? 0) - (b.pipelines?.sort_order ?? 0)
  );

  return <PipelineBoard clientId={clientId} enrollments={sorted} />;
}
