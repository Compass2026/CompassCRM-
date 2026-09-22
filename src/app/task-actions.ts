"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireTeamMember } from "@/lib/team";
import {
  isUuid,
  parseComment,
  parseTaskFields,
  statusPatch,
  type TaskStatus,
} from "@/lib/tasks";

// Team work management (0043). Every action checks the caller is on
// team_members before touching anything; RLS (is_team()) and the 0043
// triggers enforce the same rules again in the database, including who is
// recorded as the actor and that a task, its stage / cycle and its comments
// belong to one client.

export type TaskFormState = { ok?: boolean; error?: string };

function revalidateTask(taskId: string, clientId: string) {
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath(`/clients/${clientId}/tasks`);
  revalidatePath(`/clients/${clientId}/pipelines`);
  revalidatePath(`/clients/${clientId}/reports`);
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function assigneeIsTeam(supabase: Supabase, assigneeId: string | null | undefined) {
  if (!assigneeId) return true;
  const { data } = await supabase.from("team_members").select("id").eq("id", assigneeId).maybeSingle();
  return !!data;
}

export async function createTaskAction(_prev: TaskFormState, form: FormData): Promise<TaskFormState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);

  const clientId = form.get("client_id");
  if (!isUuid(clientId)) return { error: "Pick a client." };
  const parsed = parseTaskFields((k) => form.get(k), { requireTitle: true });
  if (!parsed.ok) return { error: parsed.error };
  const { title, due_date, assignee_id, notes } = parsed.value;

  const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return { error: "That client does not exist." };
  if (!(await assigneeIsTeam(supabase, assignee_id))) return { error: "The assignee is not on the team." };

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      client_id: clientId,
      title: title!,
      due_date: due_date ?? null,
      assignee_id: assignee_id ?? null,
      notes: notes ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not create the task." };

  revalidateTask(data.id, clientId);
  return { ok: true };
}

export async function updateTaskAction(
  taskId: string,
  _prev: TaskFormState,
  form: FormData
): Promise<TaskFormState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  if (!isUuid(taskId)) return { error: "Unknown task." };

  const parsed = parseTaskFields((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };

  const { data: task } = await supabase
    .from("tasks")
    .select("id, client_id, status")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { error: "That task no longer exists." };
  if (!(await assigneeIsTeam(supabase, parsed.value.assignee_id))) {
    return { error: "The assignee is not on the team." };
  }

  const { status, ...rest } = parsed.value;
  const patch = {
    ...rest,
    ...(status ? statusPatch(status, task.status as TaskStatus) : {}),
  };
  if (Object.keys(patch).length === 0) return { ok: true };

  const { data: updated, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", taskId)
    .eq("client_id", task.client_id)
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length) return { error: "Nothing was updated — the task may have been removed." };

  revalidateTask(taskId, task.client_id);
  return { ok: true };
}

// The inline assignee picker on task lists: one field, same checks.
export async function assignTaskAction(taskId: string, form: FormData): Promise<void> {
  const res = await updateTaskAction(taskId, {}, form);
  if (res.error) throw new Error(res.error);
}

export async function addTaskCommentAction(
  taskId: string,
  _prev: TaskFormState,
  form: FormData
): Promise<TaskFormState> {
  const supabase = await createClient();
  await requireTeamMember(supabase);
  if (!isUuid(taskId)) return { error: "Unknown task." };

  const parsed = parseComment((k) => form.get(k));
  if (!parsed.ok) return { error: parsed.error };

  const { data: task } = await supabase.from("tasks").select("id, client_id").eq("id", taskId).maybeSingle();
  if (!task) return { error: "That task no longer exists." };

  // author_id is set by the database from the signed-in user; client_id must
  // match the task's or the insert is refused.
  const { error } = await supabase
    .from("task_comments")
    .insert({ task_id: task.id, client_id: task.client_id, body: parsed.value });
  if (error) return { error: error.message };

  revalidatePath(`/tasks/${taskId}`);
  return { ok: true };
}
