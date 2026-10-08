"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { reviewStyleProfileAction, runStyleAnalysisAction, setHistoryLearningAction, type StyleAnswer } from "@/app/social-style-actions";
import { cn } from "@/lib/utils";

function Note({ answer }: { answer: StyleAnswer | null }) {
  if (!answer) return null;
  return <p className={cn("text-xs", answer.ok ? "text-green-700" : "text-red-700")} role="status" data-answer={answer.ok ? "ok" : "error"}>{answer.text}</p>;
}

// Runs the analyzer over the imported history (records a PROPOSED profile).
export function AnalyzeButton({ clientId, label }: { clientId: string; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [answer, setAnswer] = useState<StyleAnswer | null>(null);
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" disabled={pending} data-analyze onClick={() => {
        if (busy.current) return;
        busy.current = true;
        startTransition(async () => {
          const r = await runStyleAnalysisAction(clientId);
          busy.current = false;
          setAnswer(r);
          router.refresh();
        });
      }}>{pending ? "Analyzing…" : label}</Button>
      <Note answer={answer} />
    </div>
  );
}

// Approve or reject the proposal the teammate is looking at (bound to its hash).
export function ReviewPanel({ clientId, profileId, profileHash }: { clientId: string; profileId: string; profileHash: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState<StyleAnswer | null>(null);
  const submit = (decision: "approve" | "reject") => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      const r = await reviewStyleProfileAction(clientId, profileId, profileHash, decision, note);
      busy.current = false;
      setAnswer(r);
      if (r.ok || r.changed) router.refresh();
    });
  };
  return (
    <div className="space-y-2" data-review-panel={profileId}>
      <label className="block text-xs font-medium" htmlFor={`note-${profileId}`}>Note (required to reject)</label>
      <textarea id={`note-${profileId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
        className="w-full rounded-md border bg-background p-2 text-sm" placeholder="What you checked, or why it does not sound like the client" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => submit("approve")} data-approve>Approve profile</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => submit("reject")} data-reject>Reject</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Approve only if the representative posts sound like the client and the do-not-learn list is complete. Approving makes
        this the client&apos;s style profile; nothing reads it until the AI Drafter is wired to it.
      </p>
      <Note answer={answer} />
    </div>
  );
}

// Include / exclude one imported post from style learning.
export function LearningToggle({ clientId, postId, status, locked }: { clientId: string; postId: string; status: string; locked: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState<StyleAnswer | null>(null);
  const send = (next: "included" | "excluded") => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      const r = await setHistoryLearningAction(clientId, postId, next, note);
      busy.current = false;
      setAnswer(r);
      if (r.ok) { setOpen(false); router.refresh(); }
    });
  };
  if (locked) return <span className="text-xs text-muted-foreground">Never learnable</span>;
  return (
    <div className="space-y-1" data-learning={postId}>
      {status === "excluded" ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => send("included")}>Include in learning</Button>
      ) : open ? (
        <div className="flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why exclude it?"
            className="min-w-48 rounded-md border bg-background px-2 py-1 text-xs" />
          <Button size="sm" variant="outline" disabled={pending} onClick={() => send("excluded")}>Exclude</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Exclude from learning</Button>
      )}
      <Note answer={answer} />
    </div>
  );
}
