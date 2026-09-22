// Work management for people (0043). `owner` / `autonomy_level` remain the
// worker's lane; `assignee_id` is the team member doing the task. Everything
// here is pure so tests/tasks.test.mjs can exercise it without a database.

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";
export type OwnerLane = "TOM" | "CLAUDE" | "CLAUDE_APPROVAL" | "DELEGATED" | "WAITING";

export const taskStatuses: { value: TaskStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

export const taskStatusLabels: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

// Lanes the worker runs. Their tasks are unassigned by design, so the
// "Unassigned" view leaves them out — it is human work nobody has picked up.
export const workerLanes: OwnerLane[] = ["CLAUDE", "CLAUDE_APPROVAL"];

export type TaskView = "mine" | "unassigned" | "overdue" | "by_client" | "all";

export const taskViews: { value: TaskView; label: string; hint: string }[] = [
  { value: "mine", label: "My work", hint: "Open tasks assigned to you" },
  { value: "unassigned", label: "Unassigned", hint: "Open human work nobody has picked up (worker lanes excluded)" },
  { value: "overdue", label: "Overdue", hint: "Open tasks past their due date" },
  { value: "by_client", label: "By client", hint: "Open tasks grouped by client" },
  { value: "all", label: "All open", hint: "Every open task, pipeline and monthly work included" },
];

// "all" stays the default so /tasks without a view is what it always was.
export function parseTaskView(v: string | undefined): TaskView {
  return taskViews.some((t) => t.value === v) ? (v as TaskView) : "all";
}

// The agency works in Central time; "today" for due dates is Compass's day,
// not the server's (Vercel runs in UTC).
export const AGENCY_TIME_ZONE = "America/Chicago";

export function todayIn(timeZone: string = AGENCY_TIME_ZONE, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isOverdue(
  task: { status: string; due_date: string | null },
  today: string
): boolean {
  return task.status !== "done" && !!task.due_date && task.due_date < today;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const TITLE_MAX = 200;
export const NOTES_MAX = 4000;
export const COMMENT_MAX = 4000;

type Get = (key: string) => FormDataEntryValue | null;

function text(get: Get, key: string): string | null {
  const v = get(key);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export type TaskFields = {
  title?: string;
  status?: TaskStatus;
  due_date?: string | null;
  assignee_id?: string | null;
  notes?: string | null;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// Reads only the fields present in the form, so a quick-assign form (just
// assignee_id) and the full edit form share one validator. An empty
// assignee / due date means "clear it".
export function parseTaskFields(get: Get, opts: { requireTitle?: boolean } = {}): Parsed<TaskFields> {
  const out: TaskFields = {};

  if (get("title") !== null || opts.requireTitle) {
    const title = text(get, "title");
    if (!title) return { ok: false, error: "A task needs a title." };
    if (title.length > TITLE_MAX) return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };
    out.title = title;
  }

  if (get("status") !== null) {
    const status = text(get, "status");
    if (!taskStatuses.some((s) => s.value === status)) return { ok: false, error: "Unknown status." };
    out.status = status as TaskStatus;
  }

  if (get("due_date") !== null) {
    const due = text(get, "due_date");
    if (due && !isIsoDate(due)) return { ok: false, error: "Due date must be a date (YYYY-MM-DD)." };
    out.due_date = due;
  }

  if (get("assignee_id") !== null) {
    const a = text(get, "assignee_id");
    if (a && !isUuid(a)) return { ok: false, error: "Unknown assignee." };
    out.assignee_id = a;
  }

  if (get("notes") !== null) {
    const notes = text(get, "notes");
    if (notes && notes.length > NOTES_MAX) return { ok: false, error: `Keep notes under ${NOTES_MAX} characters.` };
    out.notes = notes;
  }

  return { ok: true, value: out };
}

export function parseComment(get: Get): Parsed<string> {
  const body = text(get, "body");
  if (!body) return { ok: false, error: "Write something first." };
  if (body.length > COMMENT_MAX) return { ok: false, error: `Keep comments under ${COMMENT_MAX} characters.` };
  return { ok: true, value: body };
}

// completed_at follows status, exactly as toggleTaskAction has always done.
export function statusPatch(
  next: TaskStatus,
  previous: TaskStatus,
  now: Date = new Date()
): { status: TaskStatus; completed_at?: string | null } {
  if (next === previous) return { status: next };
  if (next === "done") return { status: next, completed_at: now.toISOString() };
  if (previous === "done") return { status: next, completed_at: null };
  return { status: next };
}

// ── History ────────────────────────────────────────────────────────────────
export type TaskEvent = {
  kind: string;
  from_value: string | null;
  to_value: string | null;
  actor_id: string | null;
};

export const WORKER_ACTOR = "Worker / system";

export function actorName(id: string | null, names: Map<string, string>): string {
  if (!id) return WORKER_ACTOR;
  return names.get(id) ?? "A former teammate";
}

function statusWord(v: string | null): string {
  return v && v in taskStatusLabels ? taskStatusLabels[v as TaskStatus].toLowerCase() : v ?? "—";
}

export function describeEvent(e: TaskEvent, names: Map<string, string>): string {
  const who = actorName(e.actor_id, names);
  const person = (id: string | null) => (id ? names.get(id) ?? "a former teammate" : "nobody");
  switch (e.kind) {
    case "created":
      return `${who} created the task`;
    case "status":
      return `${who} changed status from ${statusWord(e.from_value)} to ${statusWord(e.to_value)}`;
    case "assignee":
      if (e.actor_id && e.to_value === e.actor_id) return `${who} took the task`;
      if (e.actor_id && !e.to_value && e.from_value === e.actor_id) return `${who} dropped the task`;
      if (!e.to_value) return `${who} unassigned ${person(e.from_value)}`;
      if (!e.from_value) return `${who} assigned ${person(e.to_value)}`;
      return `${who} reassigned from ${person(e.from_value)} to ${person(e.to_value)}`;
    case "due_date":
      if (!e.to_value) return `${who} cleared the due date`;
      return `${who} set the due date to ${e.to_value}`;
    case "title":
      return `${who} renamed it to “${e.to_value ?? ""}”`;
    case "owner":
      return `${who} moved the lane from ${e.from_value ?? "—"} to ${e.to_value ?? "—"}`;
    default:
      return `${who} changed ${e.kind}`;
  }
}

// ── Grouping ───────────────────────────────────────────────────────────────
export function groupByClient<T extends { client_id: string; clients: { name: string } | null }>(
  tasks: T[]
): { clientId: string; name: string; tasks: T[] }[] {
  const groups = new Map<string, { clientId: string; name: string; tasks: T[] }>();
  for (const t of tasks) {
    const g = groups.get(t.client_id) ?? { clientId: t.client_id, name: t.clients?.name ?? "Unknown client", tasks: [] };
    g.tasks.push(t);
    groups.set(t.client_id, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Timestamps in the agency's day, not the server's.
export function formatStamp(iso: string, timeZone: string = AGENCY_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
