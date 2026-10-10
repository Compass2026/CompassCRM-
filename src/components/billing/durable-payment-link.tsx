"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { durablePaymentLinkAction } from "@/app/billing-actions";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "./copy-link-button";

export function DurablePaymentLink({ clientId, activeExpires, disabled }: { clientId: string; activeExpires: string | null; disabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [expires, setExpires] = useState(activeExpires);
  const [message, setMessage] = useState("");
  async function run(action: "issue" | "revoke") {
    setPending(true); setMessage(action === "issue" ? "Preparing your 30-day link…" : "Revoking the link…");
    try {
      const result = await durablePaymentLinkAction(clientId, action);
      if (result.error) { setMessage(result.detail ?? "Could not update the payment link. Try again."); return; }
      setUrl(result.url ?? null); setExpires(action === "issue" ? result.expires_at ?? null : null);
      setMessage(action === "issue" ? "Your 30-day payment link is ready. Copy it below." : "The 30-day link is revoked.");
      router.refresh();
    } catch { setMessage("Could not update the payment link. Try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-4" data-durable-payment-link>
    <p className="font-medium">Client payment link · 30 days</p>
    <p className="text-xs text-muted-foreground">The client can return to this link while setting up their subscription. Card or ACH payment begins only when they authorize it in Stripe.</p>
    {expires && <p className="text-xs">Valid until {new Date(expires).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} Central.</p>}
    {url && <>
      <p className="break-all rounded border bg-white px-2 py-2 font-mono text-xs" data-durable-link-url>{url}</p>
      <div className="flex gap-2"><CopyLinkButton url={url} label="Copy 30-day Payment Link" />
        <a href={url} target="_blank" rel="noreferrer" className="text-sm underline">Preview client page</a></div>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={disabled || pending} onClick={() => run("issue")}>
        {pending ? "Working…" : expires ? "Replace 30-day link" : "Create 30-day Payment Link"}
      </Button>
      {expires && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run("revoke")}>Revoke 30-day link</Button>}
    </div>
    <p role="status" aria-live="polite" className="text-xs">{message}</p>
    <p className="text-xs text-muted-foreground">Copy the link before leaving this page. Replacing it disables the previous 30-day link. Revoking it stops future payment setup; an already opened Stripe checkout remains valid until expired below.</p>
  </div>;
}
