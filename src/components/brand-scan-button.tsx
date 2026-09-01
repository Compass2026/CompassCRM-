"use client";

import { useActionState } from "react";
import { scanWebsiteAction, type ScanState } from "@/app/brand-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BrandScanButton({
  clientId,
  websiteUrl,
}: {
  clientId: string;
  websiteUrl: string | null;
}) {
  const bound = scanWebsiteAction.bind(null, clientId);
  const [state, action, pending] = useActionState<ScanState, FormData>(bound, null);

  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending || !websiteUrl}>
        {pending ? "Scanning website…" : "Scan website for colors, fonts & logo"}
      </Button>
      {!websiteUrl && (
        <p className="text-xs text-muted-foreground">
          Add a website on the Overview tab to enable scanning.
        </p>
      )}
      {state && (
        <p className={cn("text-xs", state.ok ? "text-muted-foreground" : "text-destructive")}>
          {state.message}
        </p>
      )}
    </form>
  );
}
