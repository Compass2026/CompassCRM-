"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { startAuthorityRunAction } from "@/app/authority-actions";
import type { ControlsState, Mode } from "@/lib/authority-controls";
import { cn } from "@/lib/utils";
import { useAuthorityRunWatcher } from "./authority-run-watcher";

type Message = { tone: "success" | "warning" | "error" | "info"; text: string };

const messageStyles: Record<Message["tone"], string> = {
  success: "border-green-200 bg-green-50 text-green-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  error: "border-red-200 bg-red-50 text-red-900",
  info: "border-royal-100 bg-royal-50 text-navy-900",
};

// Run Full Analysis / Refresh. The page decides what may be pressed
// (authority-controls.ts, from the latest run and its staleness); the
// authority-run function is still the judge and every answer it gives is
// shown. One run per client: the buttons stay disabled from the click until
// the run this page is watching has finished.
export function AuthorityRunControls({ clientId, state }: { clientId: string; state: ControlsState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [starting, setStarting] = useState<Mode | null>(null);
  const clicked = useRef(false);

  // The run to watch: the one this click started, else one the page found running.
  const watchId = startedId ?? state.running?.id ?? null;
  useAuthorityRunWatcher(clientId, watchId, (m) => {
    setMessage(m);
    setStartedId(null);
    setWatching(false);
    clicked.current = false;
  });

  const busy = pending || watching || !!state.running;

  function start(mode: Mode) {
    if (clicked.current || busy) return;
    clicked.current = true;
    setMessage(null);
    setStarting(mode);
    startTransition(async () => {
      const o = await startAuthorityRunAction(clientId, mode);
      setStarting(null);
      if (o.kind === "started" || (o.kind === "running" && o.runId)) {
        setStartedId(o.runId);
        setWatching(true);
        setMessage({ tone: "info", text: o.text });
        router.refresh();
        return;
      }
      clicked.current = false;
      setMessage({ tone: o.kind === "uncertain" ? "warning" : "error", text: o.text });
      // Maybe it started: the page shows (and then watches) a running run if so.
      if (o.kind === "uncertain" || o.kind === "running") router.refresh();
    });
  }

  if (!state.visible) return null;
  const buttons: { mode: Mode; label: string; b: ControlsState["full"] }[] = [
    { mode: "full", label: "Run Full Analysis", b: state.full },
    { mode: "refresh", label: "Refresh", b: state.refresh },
  ];
  const reasons = [...new Set(buttons.map((x) => (busy && !state.running ? null : x.b.reason)).filter(Boolean))] as string[];

  return (
    <div className="space-y-2" data-controls="authority">
      <div className="flex flex-wrap items-center gap-2">
        {buttons.map(({ mode, label, b }) => (
          <Button
            key={mode}
            type="button"
            variant={b.primary ? "default" : "outline"}
            disabled={!b.enabled || busy}
            aria-describedby="authority-controls-help"
            data-run={mode}
            data-primary={b.primary ? "true" : undefined}
            onClick={() => start(mode)}
          >
            {starting === mode ? `${label}…` : label}
          </Button>
        ))}
      </div>
      <p id="authority-controls-help" className="max-w-3xl text-xs text-muted-foreground">{state.helper}</p>
      {reasons.map((r) => (
        <p key={r} className="text-xs text-muted-foreground" data-reason>{r}</p>
      ))}
      <div role="status" aria-live="polite" data-run-message={message?.tone ?? ""}>
        {message && <p className={cn("callout text-sm", messageStyles[message.tone])}>{message.text}</p>}
      </div>
    </div>
  );
}
