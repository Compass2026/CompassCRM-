"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center space-y-4">
      <h1 className="page-title kicker">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        That action didn&apos;t go through. Nothing was saved, so it&apos;s safe
        to try again.
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground font-mono">
          Reference: {error.digest}
        </p>
      )}
      <div className="flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" render={<a href="/clients">Back to clients</a>} />
      </div>
    </div>
  );
}
