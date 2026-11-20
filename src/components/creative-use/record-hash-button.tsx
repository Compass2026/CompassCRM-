"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { recordAssetHashAction, type ReviewAnswer } from "@/app/creative-use-actions";
import { cn } from "@/lib/utils";

// Asks the source-assets function to measure and record a stored file's hash
// (the app never computes it). Shown only for stored, unhashed assets.
export function RecordHashButton({ clientId, assetId }: { clientId: string; assetId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<ReviewAnswer | null>(null);
  const run = () =>
    startTransition(async () => {
      const r = await recordAssetHashAction(clientId, assetId);
      setMessage(r);
      if (r.ok || r.changed) router.refresh();
    });
  return (
    <div className="space-y-1" data-record-hash={assetId}>
      <Button type="button" size="xs" variant="outline" loading={pending} disabled={pending} onClick={run} data-record-hash-button>
        {pending ? "Recording…" : "Record hash"}
      </Button>
      {message && (
        <p role="status" data-record-hash-message={message.ok ? "ok" : "refused"}
          className={cn("text-xs [overflow-wrap:anywhere]", message.ok ? "text-green-800" : "text-amber-900")}>
          {message.text}
        </p>
      )}
    </div>
  );
}
