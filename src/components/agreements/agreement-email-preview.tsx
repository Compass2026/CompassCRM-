"use client";

import { useState } from "react";
import type { AgreementEmail } from "@/lib/agreement-email";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function AgreementEmailPreview({ email, recipient }: { email: AgreementEmail; recipient: string }) {
  const [view, setView] = useState<"desktop" | "mobile" | "text">("desktop");
  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        Preview signing email
      </DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Signing email preview</DialogTitle>
          <DialogDescription>Preview only. Links are disabled. No email or verification code is sent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 break-words rounded-lg bg-muted/50 p-3 text-sm">
          <p><strong>To:</strong> {recipient || "Save a recipient in the draft"}</p>
          <p><strong>Subject:</strong> {email.subject}</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Email preview format">
          {(["desktop", "mobile", "text"] as const).map((mode) => (
            <Button key={mode} type="button" variant={view === mode ? "default" : "outline"} aria-pressed={view === mode} onClick={() => setView(mode)}>
              {mode === "text" ? "Plain text" : mode === "mobile" ? "Mobile" : "Desktop"}
            </Button>
          ))}
        </div>
        {view === "text" ? (
          <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border p-4 font-sans text-sm">{email.text}</pre>
        ) : (
          <iframe title="Agreement email content" sandbox="" referrerPolicy="no-referrer" srcDoc={email.html}
            className="mx-auto h-[60dvh] w-full rounded-lg border bg-white" style={{ maxWidth: view === "mobile" ? 375 : "100%" }} />
        )}
      </DialogContent>
    </Dialog>
  );
}
