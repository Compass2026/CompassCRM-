// The CRM Lite text composer's rules, pure so tests/client-phone-composer.test.mjs
// can hold them without a browser. The component (src/components/client-workspace/
// phone.tsx) only wires them to the textarea and the client-phone function.
//
// One press of Send carries one request id. The id is the database's dedupe
// key, so it changes only once the server has said what became of the press:
//   accepted        Twilio took the text: clear the composer (unless the
//                   person kept typing), new id
//   failed          refused or known not sent: keep the text, new id
//   uncertain       Compass can't tell yet: keep the text AND the id, so the
//                   next press asks about this one instead of sending again
//   network         no answer from Compass: same as uncertain (the request may
//                   have arrived)
//   refused         a check failed before anything was reserved (no consent,
//                   opted out, …): keep the text and the id
import { phoneReasons } from "./client-phone-messages.ts";

export type SendOutcome =
  | { kind: "accepted" }
  | { kind: "failed"; code: string }
  | { kind: "uncertain"; code: string }
  | { kind: "network" }
  | { kind: "refused"; code: string };

export type Composer = {
  body: string;
  requestId: string;
  // The text that went with requestId's press, while its result is open.
  sentBody: string | null;
  checking: boolean;
  error: string;
  notice: string;
};

export function newComposer(body: string, requestId: string): Composer {
  return { body, requestId, sentBody: null, checking: false, error: "", notice: "" };
}

// What the client-phone answer means. status null: fetch threw or the reply
// was not JSON.
export function classifySend(status: number | null, data: unknown): SendOutcome {
  if (status == null || !data || typeof data !== "object") return { kind: "network" };
  const d = data as { send?: { state?: string; code?: string }; error?: string };
  if (status === 200 && d.send) {
    if (d.send.state === "accepted") return { kind: "accepted" };
    if (d.send.state === "failed") return { kind: "failed", code: d.send.code || "send_not_ready" };
    return { kind: "uncertain", code: d.send.code || "send_uncertain" };
  }
  if (status >= 500) return { kind: "network" };
  return { kind: "refused", code: typeof d.error === "string" ? d.error : "send_not_ready" };
}

export const reason = (code: string) =>
  phoneReasons[code] || "The text could not be sent. Refresh the lead and try again.";

export function afterSend(c: Composer, outcome: SendOutcome, newId: string): Composer {
  const sent = c.sentBody ?? c.body;
  switch (outcome.kind) {
    case "accepted":
      return { ...newComposer(c.body === sent ? "" : c.body, newId) };
    case "failed":
      return { ...newComposer(c.body, newId), error: reason(outcome.code) };
    case "uncertain":
    case "network":
      return { ...c, sentBody: sent, checking: true, error: "",
        notice: outcome.kind === "network" ? phoneReasons.send_network : phoneReasons.send_uncertain };
    case "refused":
      return { ...c, sentBody: null, checking: false, notice: "", error: reason(outcome.code) };
  }
}

// Enter sends, Shift+Enter is a new line, and nothing is sent while an input
// method is composing (Japanese, Chinese, Korean… Enter confirms the word).
export function sendsOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export function canPress(c: Composer, opts: { canSend: boolean; sending: boolean }): boolean {
  if (opts.sending) return false;
  if (c.checking) return true; // asking about the open press never sends a new text
  return opts.canSend && c.body.trim().length > 0 && c.body.length <= 1600;
}
