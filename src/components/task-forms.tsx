"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  addTaskCommentAction,
  assignTaskAction,
  createTaskAction,
  updateTaskAction,
  type TaskFormState,
} from "@/app/task-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { canAssignLane, taskStatuses, TITLE_MAX, type TaskStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";

type Member = { id: string; name: string };
type ClientOption = { id: string; name: string };

const selectClass =
  "field w-full";

function FormMessage({ state }: { state: TaskFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  return null;
}

function AssigneeOptions({ members, meId }: { members: Member[]; meId?: string | null }) {
  return (
    <>
      <option value="">Unassigned</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.id === meId ? " (me)" : ""}
        </option>
      ))}
    </>
  );
}

// Inline picker on task lists: changing it saves at once.
export function AssigneeSelect({
  taskId,
  assigneeId,
  members,
  meId,
  className,
}: {
  taskId: string;
  assigneeId: string | null;
  members: Member[];
  meId?: string | null;
  className?: string;
}) {
  return (
    <form action={assignTaskAction.bind(null, taskId)} className={className}>
      <select
        name="assignee_id"
        defaultValue={assigneeId ?? ""}
        aria-label="Assignee"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className={cn(selectClass, "h-8 text-xs", !assigneeId && "text-muted-foreground")}
      >
        <AssigneeOptions members={members} meId={meId} />
      </select>
    </form>
  );
}

export function NewTaskForm({
  members,
  meId,
  clients,
  clientId,
}: {
  members: Member[];
  meId: string | null;
  // Either a fixed client (the client's Tasks tab) or a list to pick from.
  clients?: ClientOption[];
  clientId?: string;
}) {
  const [state, action, pending] = useActionState(createTaskAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto] items-end">
      <div className="space-y-1 sm:col-span-2 lg:col-span-1">
        <Label htmlFor="new-task-title">Task</Label>
        <Input id="new-task-title" name="title" required maxLength={TITLE_MAX} placeholder="What needs doing?" />
      </div>
      {clientId ? (
        <input type="hidden" name="client_id" value={clientId} />
      ) : (
        <div className="space-y-1">
          <Label htmlFor="new-task-client">Client</Label>
          <select id="new-task-client" name="client_id" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Pick a client
            </option>
            {(clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="new-task-assignee">Assignee</Label>
        <select id="new-task-assignee" name="assignee_id" defaultValue={meId ?? ""} className={selectClass}>
          <AssigneeOptions members={members} meId={meId} />
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="new-task-due">Due</Label>
        <Input id="new-task-due" name="due_date" type="date" />
      </div>
      <Button type="submit" disabled={pending} className="sm:col-span-2 lg:col-span-1">
        {pending ? "Adding…" : "Add task"}
      </Button>
      <div className="sm:col-span-2 lg:col-span-4">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function TaskEditForm({
  task,
  members,
  meId,
}: {
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    due_date: string | null;
    assignee_id: string | null;
    notes: string | null;
    owner: string;
  };
  members: Member[];
  meId: string | null;
}) {
  const [state, action, pending] = useActionState(updateTaskAction.bind(null, task.id), {});
  // A disabled select is not submitted, so the action never sees an assignee
  // for a CLAUDE task from this form.
  const assignable = canAssignLane(task.owner);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="task-title">Title</Label>
        <Input id="task-title" name="title" required maxLength={TITLE_MAX} defaultValue={task.title} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="task-status">Status</Label>
          <select id="task-status" name="status" defaultValue={task.status} className={selectClass}>
            {taskStatuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="task-assignee">Assignee</Label>
          <select
            id="task-assignee"
            name="assignee_id"
            defaultValue={task.assignee_id ?? ""}
            disabled={!assignable}
            aria-describedby={assignable ? undefined : "task-assignee-hint"}
            className={cn(selectClass, !assignable && "opacity-60")}
          >
            <AssigneeOptions members={members} meId={meId} />
          </select>
          {!assignable && (
            <p id="task-assignee-hint" className="text-xs text-muted-foreground">
              The worker runs CLAUDE tasks, so they aren&apos;t assigned to a person.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="task-due">Due</Label>
          <Input id="task-due" name="due_date" type="date" defaultValue={task.due_date ?? ""} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="task-notes">Notes</Label>
        <Textarea id="task-notes" name="notes" rows={4} defaultValue={task.notes ?? ""} />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.ok && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function TaskCommentForm({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState(addTaskCommentAction.bind(null, taskId), {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={action} className="space-y-2">
      <Label htmlFor="task-comment" className="sr-only">
        Comment
      </Label>
      <Textarea id="task-comment" name="body" rows={3} required placeholder="Add a comment for the team" />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Posting…" : "Comment"}
        </Button>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
