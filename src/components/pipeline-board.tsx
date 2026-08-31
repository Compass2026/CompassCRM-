"use client";

import { useRef, useState } from "react";
import {
  addDeliverableAction,
  addTaskAction,
  toggleTaskAction,
  updateStageAction,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ownerLabels,
  owners,
  stageStatusLabels,
  stageStatusStyles,
  type StageStatus,
} from "@/lib/labels";
import { cn } from "@/lib/utils";

type Stage = {
  id: string;
  status: StageStatus;
  owner: keyof typeof ownerLabels;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  evidence: string | null;
  next_action: string | null;
  notes: string | null;
  stages: {
    id: string;
    name: string;
    sort_order: number;
    is_optional: boolean;
    description: string | null;
  } | null;
  tasks: {
    id: string;
    title: string;
    owner: keyof typeof ownerLabels;
    status: string;
    due_date: string | null;
    notes: string | null;
  }[];
  deliverables: { id: string; label: string; url: string; type: string }[];
};

type Enrollment = {
  id: string;
  status: string;
  pipelines: {
    id: string;
    key: string;
    name: string;
    sort_order: number;
    is_recurring: boolean;
  } | null;
  client_stages: Stage[];
};

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs w-full";

export function PipelineBoard({
  clientId,
  enrollments,
}: {
  clientId: string;
  enrollments: Enrollment[];
}) {
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const launch = enrollments.filter((e) => !e.pipelines?.is_recurring);
  const recurring = enrollments.filter((e) => e.pipelines?.is_recurring);
  const completedCount = launch.filter((e) => e.status === "complete").length;

  let selected: { enrollment: Enrollment; stage: Stage } | null = null;
  for (const e of enrollments) {
    const s = e.client_stages.find((cs) => cs.id === selectedStageId);
    if (s) {
      selected = { enrollment: e, stage: s };
      break;
    }
  }

  if (enrollments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No pipelines enrolled — enroll from the Plan tab.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {launch.length > 0 && (
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {completedCount} of {launch.length}
          </span>{" "}
          launch pipeline{launch.length === 1 ? "" : "s"} complete → Reporting
          {recurring.length > 0 && (
            <Badge variant="outline" className="ml-2 bg-green-100 text-green-800 border-green-200">
              Reporting active
            </Badge>
          )}
        </div>
      )}

      {enrollments.map((enrollment) => {
        const stages = [...enrollment.client_stages].sort(
          (a, b) => (a.stages?.sort_order ?? 0) - (b.stages?.sort_order ?? 0)
        );
        return (
          <div key={enrollment.id} className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{enrollment.pipelines?.name}</h2>
              {enrollment.status === "complete" && (
                <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200">
                  complete
                </Badge>
              )}
              {enrollment.pipelines?.is_recurring && (
                <Badge variant="secondary">recurring</Badge>
              )}
            </div>
            {stages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {enrollment.pipelines?.is_recurring
                  ? "Monthly cycles appear in the Reports tab."
                  : "No stages."}
              </p>
            ) : (
              <div className="flex items-center gap-1 flex-wrap">
                {stages.map((stage, i) => (
                  <div key={stage.id} className="flex items-center gap-1">
                    {i > 0 && <div className="w-4 h-px bg-border" />}
                    <button
                      onClick={() => setSelectedStageId(stage.id)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition-transform hover:scale-105",
                        stageStatusStyles[stage.status]
                      )}
                      title={stageStatusLabels[stage.status]}
                    >
                      {stage.stages?.name}
                      {stage.stages?.is_optional ? " *" : ""}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">* optional stage</p>

      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelectedStageId(null)}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg w-full">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {selected.enrollment.pipelines?.name} — {selected.stage.stages?.name}
                </SheetTitle>
                {selected.stage.stages?.description && (
                  <SheetDescription>
                    {selected.stage.stages.description}
                  </SheetDescription>
                )}
              </SheetHeader>

              <div className="px-4 pb-6 space-y-6">
                <form
                  ref={formRef}
                  action={updateStageAction.bind(null, clientId)}
                  className="space-y-3"
                >
                  <input
                    type="hidden"
                    name="client_stage_id"
                    value={selected.stage.id}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Status</Label>
                      <select
                        name="status"
                        defaultValue={selected.stage.status}
                        key={`status-${selected.stage.id}-${selected.stage.status}`}
                        className={selectClass}
                      >
                        {(Object.keys(stageStatusLabels) as StageStatus[]).map(
                          (s) => (
                            <option key={s} value={s}>
                              {stageStatusLabels[s]}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label>Owner</Label>
                      <select
                        name="owner"
                        defaultValue={selected.stage.owner}
                        key={`owner-${selected.stage.id}-${selected.stage.owner}`}
                        className={selectClass}
                      >
                        {owners.map((o) => (
                          <option key={o} value={o}>
                            {ownerLabels[o]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label>Due date</Label>
                      <Input
                        type="date"
                        name="due_date"
                        defaultValue={selected.stage.due_date ?? ""}
                        key={`due-${selected.stage.id}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Completion evidence</Label>
                    <Textarea
                      name="evidence"
                      rows={2}
                      defaultValue={selected.stage.evidence ?? ""}
                      key={`ev-${selected.stage.id}`}
                      placeholder="Link or note proving this stage is done"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Next action</Label>
                    <Input
                      name="next_action"
                      defaultValue={selected.stage.next_action ?? ""}
                      key={`na-${selected.stage.id}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Notes</Label>
                    <Textarea
                      name="notes"
                      rows={2}
                      defaultValue={selected.stage.notes ?? ""}
                      key={`no-${selected.stage.id}`}
                    />
                  </div>
                  <Button type="submit">Save stage</Button>
                </form>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Tasks</h3>
                  {selected.stage.tasks.length === 0 && (
                    <p className="text-sm text-muted-foreground">No tasks yet.</p>
                  )}
                  <ul className="space-y-1.5">
                    {selected.stage.tasks.map((task) => (
                      <li key={task.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={task.status === "done"}
                          onChange={(e) =>
                            toggleTaskAction(clientId, task.id, e.target.checked)
                          }
                        />
                        <span
                          className={cn(
                            "flex-1",
                            task.status === "done" &&
                              "line-through text-muted-foreground"
                          )}
                        >
                          {task.title}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {ownerLabels[task.owner]}
                        </Badge>
                        {task.due_date && (
                          <span className="text-xs text-muted-foreground">
                            {task.due_date}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form
                    action={addTaskAction.bind(null, clientId, selected.stage.id)}
                    className="flex gap-2 pt-1"
                  >
                    <Input name="title" placeholder="New task" required className="h-8" />
                    <select name="owner" defaultValue="TOM" className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
                      {owners.map((o) => (
                        <option key={o} value={o}>
                          {ownerLabels[o]}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" size="sm" variant="outline">
                      Add
                    </Button>
                  </form>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Deliverables</h3>
                  <ul className="space-y-1.5">
                    {selected.stage.deliverables.map((d) => (
                      <li key={d.id} className="text-sm">
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline text-primary"
                        >
                          {d.label}
                        </a>{" "}
                        <span className="text-xs text-muted-foreground">
                          ({d.type})
                        </span>
                      </li>
                    ))}
                  </ul>
                  <form
                    action={addDeliverableAction.bind(
                      null,
                      clientId,
                      selected.stage.id
                    )}
                    className="flex gap-2 pt-1"
                  >
                    <Input name="label" placeholder="Label" required className="h-8" />
                    <Input name="url" placeholder="URL" required className="h-8" />
                    <Button type="submit" size="sm" variant="outline">
                      Add
                    </Button>
                  </form>
                </div>

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {selected.stage.started_at && (
                    <p>Started {selected.stage.started_at.slice(0, 10)}</p>
                  )}
                  {selected.stage.completed_at && (
                    <p>Completed {selected.stage.completed_at.slice(0, 10)}</p>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
