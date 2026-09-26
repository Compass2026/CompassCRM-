"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAuthorityRunWatcher } from "./authority-run-watcher";

export type RunMessage = { tone: "success" | "warning" | "error" | "info"; text: string };

type Ctx = {
  clientId: string;
  watching: boolean;                                   // a run this page started is being watched
  message: RunMessage | null;
  setMessage: (m: RunMessage | null) => void;
  watch: (runId: string, m: RunMessage) => void;       // follow a run started here (a button or a decision)
};

const RunContext = createContext<Ctx | null>(null);

// One watcher per Authority page, shared by Run Full Analysis / Refresh and
// by the refresh a decision starts after changing client data: the run is
// polled every 3 s while it runs, and the page refreshes once when it ends.
export function AuthorityRunProvider({ clientId, runningId, children }: { clientId: string; runningId: string | null; children: ReactNode }) {
  const [message, setMessage] = useState<RunMessage | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);

  // The run to watch: the one started here, else one the page found running.
  const watchId = startedId ?? runningId;
  useAuthorityRunWatcher(clientId, watchId, (m) => {
    setMessage(m);
    setStartedId(null);
  });

  const watch = useCallback((runId: string, m: RunMessage) => {
    setStartedId(runId);
    setMessage(m);
  }, []);
  const value = useMemo(() => ({ clientId, watching: !!startedId, message, setMessage, watch }), [clientId, startedId, message, watch]);
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

export function useAuthorityRun(): Ctx {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useAuthorityRun needs an AuthorityRunProvider");
  return ctx;
}
