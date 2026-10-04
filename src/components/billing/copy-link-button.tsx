"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Copy Payment Link: puts the Stripe Checkout URL on the clipboard for a
// teammate to paste into an email. Nothing is sent from Compass.
export function CopyLinkButton({ url, label = "Copy Payment Link" }: { url: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the link" : label}
    </Button>
  );
}
