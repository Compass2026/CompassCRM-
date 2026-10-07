"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Copies text to the clipboard (the manual delivery path: approved copy out
// of Compass and into the channel by hand).
export function CopyTextButton({ text, label = "Copy text" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2000);
      }}
      data-copy-text
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text" : label}
    </Button>
  );
}
