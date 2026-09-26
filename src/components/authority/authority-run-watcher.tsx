"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { authorityRunStatusAction } from "@/app/authority-actions";
import { finishMessage, POLL_INTERVAL_MS, WATCH_LIMIT_MS, type FinishMessage } from "@/lib/authority-controls";

// Watches one running run: its status every 3 seconds while it is running,
// never while the tab is hidden (a poll is made as soon as the tab is shown
// again), for at most three minutes of watching. When the run finishes it
// reports the outcome and refreshes the page exactly once.
export function useAuthorityRunWatcher(
  clientId: string,
  runId: string | null,
  report: (m: FinishMessage | { tone: "info"; text: string }) => void,
) {
  const router = useRouter();
  const reportRef = useRef(report);
  useEffect(() => { reportRef.current = report; });

  useEffect(() => {
    if (!runId) return;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    const started = Date.now();

    const stop = () => {
      done = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    const schedule = () => {
      if (done || document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    async function poll() {
      timer = null;
      if (done || inFlight || document.hidden) return;
      if (Date.now() - started >= WATCH_LIMIT_MS) {
        stop();
        reportRef.current({ tone: "info", text: "Still running. Reload the page later for the result." });
        return;
      }
      inFlight = true;
      const answer = await authorityRunStatusAction(clientId, runId!).catch(() => null);
      inFlight = false;
      if (done) return;
      if (answer && "missing" in answer) {
        // Not visible (another client's run, or gone): show the page as it is.
        stop();
        router.refresh();
        return;
      }
      if (answer && "run" in answer) {
        const m = finishMessage(answer.run);
        if (m) {
          stop();
          reportRef.current(m);
          router.refresh();
          return;
        }
      }
      // Still running, or a transient error reading it: try again.
      schedule();
    }
    function onVisible() {
      if (done) return;
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else {
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return stop;
  }, [clientId, runId, router]);
}
