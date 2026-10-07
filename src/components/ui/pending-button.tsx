"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";

export type PendingButtonProps = ButtonPrimitive.Props & {
  loading?: boolean;
  loadingLabel?: string;
};

// Form status belongs to the nearest form, so unrelated controls stay usable.
// Explicit loading covers actions invoked by onClick/useTransition instead.
export function PendingButton({ loading = false, loadingLabel = "Working…", children, disabled, type, ...props }: PendingButtonProps) {
  const { pending } = useFormStatus();
  const busy = loading || (type === "submit" && pending);

  return (
    <ButtonPrimitive
      {...props}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-loading={busy ? "true" : undefined}
    >
      {busy ? (
        <span className="inline-grid items-center justify-items-center">
          <span className="invisible col-start-1 row-start-1" aria-hidden="true">{children}</span>
          <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5" role="status" aria-live="polite">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span className={loadingLabel ? undefined : "sr-only"}>{loadingLabel || "Working…"}</span>
          </span>
        </span>
      ) : children}
    </ButtonPrimitive>
  );
}
