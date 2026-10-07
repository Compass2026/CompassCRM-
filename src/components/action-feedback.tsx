"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Keep redirected action results visible even when the user is far down a page.
// Messages come from the action itself; never invent a successful result.
export function ActionFeedback() {
  const params = useSearchParams();
  const pathname = usePathname();
  const error = params.get("error");
  const message = error || params.get("notice");
  const key = `${pathname}?${params.toString()}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!message || dismissed === key) return null;

  const Icon = error ? CircleAlert : CheckCircle2;
  return (
    <div className={cn(
      "fixed bottom-4 right-4 z-50 flex max-h-[50vh] w-[calc(100%-2rem)] max-w-md items-start gap-3 overflow-auto rounded-xl border p-4 shadow-lg sm:bottom-6 sm:right-6",
      error ? "border-red-200 bg-red-50 text-red-900" : "border-green-200 bg-green-50 text-green-900",
    )} data-action-feedback>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
        <p className="font-semibold">{error ? "Action needs attention" : "Action result"}</p>
        <p className="mt-1 break-words">{message}</p>
      </div>
      <button type="button" aria-label="Dismiss action result" onClick={() => setDismissed(key)} className="shrink-0 rounded-md p-1 hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
