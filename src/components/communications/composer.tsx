"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendMessageAction } from "@/app/communications-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The message box. One request id per draft, so a double click (or a retry
// after a lost answer) sends once; a new id only after a send went through.
export function Composer({ clientId, conversationId, contactId, blockedReason, openThreadBase }: {
  clientId: string; conversationId?: string | null; contactId?: string | null; blockedReason: string | null;
  // After a first message, open its thread at <base>?c=<id>.
  openThreadBase?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const segments = body.length <= 160 ? 1 : Math.ceil(body.length / 153);

  if (blockedReason) {
    return <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{blockedReason}</p>;
  }
  return (
    <form className="space-y-2" onSubmit={(e) => {
      e.preventDefault();
      if (!body.trim()) return;
      start(async () => {
        const r = await sendMessageAction(clientId, { requestId, body, conversationId, contactId });
        setResult(r);
        // A recorded message (sent, or refused by Twilio) used this id up; a
        // refusal before anything was recorded (no consent…) keeps it.
        if (r.ok || r.conversationId) setRequestId(crypto.randomUUID());
        if (r.ok) {
          setBody("");
          if (openThreadBase && r.conversationId) router.push(`${openThreadBase}?c=${r.conversationId}`);
        }
        router.refresh();
      });
    }}>
      <Textarea aria-label="Message" value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={1600}
        placeholder="Write a reply…" disabled={pending} />
      <div className="flex items-center gap-3">
        <Button loading={pending} type="submit" size="sm" disabled={pending || !body.trim()}>{pending ? "Sending…" : "Send SMS"}</Button>
        <span className="text-xs text-muted-foreground tabular-nums">{body.length}/1600 · {segments} segment{segments === 1 ? "" : "s"}</span>
        {result && <span role="status" className={cn("text-xs", result.ok ? "text-green-800" : "text-red-700")}>{result.message}</span>}
      </div>
    </form>
  );
}
