"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Copies the article as Markdown (the manual delivery path).
export function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button type="button" size="sm" variant="outline" data-copy-markdown
      onClick={async () => {
        try { await navigator.clipboard.writeText(markdown); setState("copied"); } catch { setState("failed"); }
        setTimeout(() => setState("idle"), 2000);
      }}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — use Download" : "Copy Markdown"}
    </Button>
  );
}
