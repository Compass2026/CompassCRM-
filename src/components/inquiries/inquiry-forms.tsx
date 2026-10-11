"use client";

import { useActionState, useEffect, useRef } from "react";
import { addInquiryNoteAction, setInquiryStatusAction, type InquiryActionState } from "@/app/inquiry-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { statusActions, type InquiryStatus } from "@/lib/inquiries";
import { cn } from "@/lib/utils";

function Result({ state }: { state: InquiryActionState }) {
  if (!state) return null;
  return <p role="status" className={cn("text-sm", state.ok ? "text-green-800" : "text-red-700")}>{state.message}</p>;
}

// One button per allowed move. Each carries the status the page showed, so a
// change made elsewhere in the meantime is refused rather than overwritten.
function StatusButton({ inquiryId, from, to, label, primary, path }: {
  inquiryId: string; from: InquiryStatus; to: InquiryStatus; label: string; primary: boolean; path: string;
}) {
  const [state, action] = useActionState<InquiryActionState, FormData>(setInquiryStatusAction.bind(null, inquiryId, from, to, path), null);
  return (
    <form action={action} className="contents">
      <Button type="submit" size="lg" variant={primary ? "default" : "outline"} loadingLabel="Saving…" className="w-full sm:w-auto"
        data-status-to={to}>
        {label}
      </Button>
      {state && !state.ok && <div className="basis-full"><Result state={state} /></div>}
    </form>
  );
}

export function StatusControls({ inquiryId, status, path }: { inquiryId: string; status: InquiryStatus; path: string }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {statusActions(status).map((a) => (
        <StatusButton key={a.to} inquiryId={inquiryId} from={status} to={a.to} label={a.label} primary={a.primary} path={path} />
      ))}
    </div>
  );
}

export function NoteForm({ inquiryId, path }: { inquiryId: string; path: string }) {
  const [state, action, pending] = useActionState<InquiryActionState, FormData>(addInquiryNoteAction.bind(null, inquiryId, path), null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok) ref.current?.reset(); }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <label htmlFor="note-body" className="block text-sm font-medium">Add a follow-up note</label>
      <Textarea id="note-body" name="body" rows={3} maxLength={5000} required placeholder="e.g. Called, left a voicemail. Trying again Tuesday." />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} loadingLabel="Adding…">Add note</Button>
        <Result state={state} />
      </div>
    </form>
  );
}
