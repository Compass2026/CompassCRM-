"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const errors: Record<string, string> = {
  wrong_google_account:
    "Choose the business email shown below when connecting Google.",
  missing_email_permissions:
    "Google did not grant both sending and reading permissions. Connect again and review the requested access.",
  permission_not_granted:
    "The connection was cancelled. You can try again when ready.",
  consent_required: "Google needs fresh permission. Connect again to continue.",
  reconnect_required: "The Gmail connection needs to be renewed.",
  forbidden: "Your account is not authorized for this action.",
  workspace_unavailable: "This workspace is currently unavailable.",
  send_uncertain_refresh_first:
    "The last send has an uncertain result. Refresh replies to check Gmail before sending anything else.",
  request_uncertain_refresh:
    "The request timed out. Refresh replies to check its result before trying another send.",
  save_draft_first: "Save your draft before sending.",
  lead_email_required:
    "This inquiry needs a valid email address before you can email it.",
  lead_email_changed_contact_support:
    "This lead’s email changed. Contact Compass before continuing this conversation.",
  mailbox_not_configured: "Email setup is not available yet.",
  connect_mailbox_first: "Connect your business mailbox first.",
  gmail_unavailable:
    "Gmail could not complete that request. Your saved draft is still available.",
};
async function call(
  clientId: string,
  mode: string,
  rest: Record<string, unknown> = {},
) {
  const response = await fetch("/api/client-mailbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, mode, ...rest }),
  });
  const data = await response.json();
  if (!response.ok || data.error)
    throw new Error(
      errors[data.error] ||
        "That request could not be completed. Refresh and try again.",
    );
  return data;
}
type Status = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  can_connect: boolean;
};
export function MailboxConnection({
  clientId,
  onConnected,
}: {
  clientId: string;
  onConnected: (value: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const params = useSearchParams(),
    result = params.get("mailbox");
  useEffect(() => {
    let active = true;
    call(clientId, "status")
      .then((s) => {
        if (active) {
          setStatus(s);
          onConnected(s.connected);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [clientId, onConnected]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await call(clientId, "connect");
      window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection unavailable");
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Email connection"
      className="mb-5 rounded-xl border border-slate-200 bg-white p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Business email</p>
          <p className="mt-1 text-xs text-slate-600">
            {status?.email || "Loading mailbox settings…"}
            {status?.email &&
              (status.connected
                ? " · Connected to Gmail"
                : " · Connection needed")}
          </p>
        </div>
        {status?.can_connect && (
          <button
            type="button"
            disabled={busy}
            onClick={connect}
            className="rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy
              ? "Opening Google…"
              : status.connected
                ? "Reconnect Gmail"
                : "Connect Gmail"}
          </button>
        )}
      </div>
      {status && !status.configured && (
        <p className="mt-2 text-xs">
          Compass needs to configure this mailbox before it can be connected.
        </p>
      )}
      {result === "connected" && status?.connected && (
        <p className="mt-2 text-xs text-green-700">
          Your business mailbox is connected. Open a lead to save a draft or
          send an email.
        </p>
      )}
      {result && result !== "connected" && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {errors[result] ||
            "The mailbox connection did not finish. Please try again."}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Google will request permission to send and read email. This CRM displays
        conversations started from your leads. It does not import your whole
        inbox. Replies update when you select Refresh replies.
      </p>
    </section>
  );
}
type Message = {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  message_at: string;
  error_code: string | null;
};
type Snapshot = {
  draft: { body: string; revision: string } | null;
  messages: Message[];
  subject: string;
  synced_at: string | null;
  send_status?: string;
};
export function MailboxThread({
  clientId,
  inquiryId,
  connected,
  recipient,
}: {
  clientId: string;
  inquiryId: string;
  connected: boolean;
  recipient: string | null;
}) {
  const [data, setData] = useState<Snapshot | null>(null),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    call(clientId, "load", { inquiry_id: inquiryId })
      .then((s) => {
        if (active) {
          setData(s);
          setBody(s.draft?.body || "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [clientId, inquiryId]);
  const dirty = body !== (data?.draft?.body || ""),
    uncertain = data?.messages.some((m) => m.status === "unknown");
  async function act(mode: string) {
    setBusy(mode);
    setError("");
    setNotice("");
    try {
      const snapshot: Snapshot = await call(clientId, mode, {
        inquiry_id: inquiryId,
        ...(mode === "save_draft" ? { body } : {}),
        ...(mode === "send" ? { revision: data?.draft?.revision } : {}),
      });
      setData(snapshot);
      if (mode !== "sync" || !dirty) setBody(snapshot.draft?.body || "");
      setNotice(
        mode === "save_draft"
          ? "Draft saved."
          : mode === "sync"
            ? "Conversation refreshed."
            : snapshot.send_status === "accepted"
              ? "Gmail accepted your email. This does not confirm delivery."
              : snapshot.send_status === "failed"
                ? "Gmail rejected the send. Your draft is saved."
                : "Send result is uncertain. Refresh replies before sending again.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section aria-label="Lead email conversation" className="p-3">
      <div className="mb-3 flex flex-wrap justify-between gap-2 text-xs">
        <span>To: {recipient || "No email address provided"}</span>
        <button
          type="button"
          onClick={() => act("sync")}
          disabled={!connected || !!busy}
          className="font-semibold text-blue-700 disabled:opacity-50"
        >
          {busy === "sync" ? "Refreshing…" : "Refresh replies"}
        </button>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Subject: {data?.subject || "Following up on your inquiry"}
      </p>
      <div
        className="max-h-96 space-y-3 overflow-y-auto"
        aria-label="Email history"
      >
        {data?.messages.map((m) => (
          <article key={m.id} className="rounded-lg bg-slate-50 p-3">
            <div className="flex flex-wrap justify-between gap-2 text-[11px] text-slate-500">
              <span>{m.sender}</span>
              <span>
                {m.status === "accepted"
                  ? "Sent to Gmail"
                  : m.status === "received"
                    ? "Received"
                    : m.status === "unknown"
                      ? "Send uncertain"
                      : "Send failed"}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
              {m.body}
            </p>
            <p className="mt-2 text-[10px] text-slate-500">
              {new Date(m.message_at).toLocaleString()}
            </p>
          </article>
        ))}
        {data && !data.messages.length && (
          <p className="py-2 text-xs text-slate-500">
            No email conversation has been started from this inquiry yet.
          </p>
        )}
      </div>
      {!connected && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Connect the business mailbox above before sending or receiving
          replies.
        </p>
      )}
      {uncertain && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900"
        >
          A previous send has an uncertain result. Refresh replies to reconcile
          it with Gmail. New sends are blocked to prevent duplicates.
        </p>
      )}
      <label
        htmlFor={`email-draft-${inquiryId}`}
        className="mt-3 block text-xs font-medium"
      >
        Email draft
      </label>
      <textarea
        id={`email-draft-${inquiryId}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={!data || !!busy}
        rows={5}
        maxLength={10000}
        className="mt-2 w-full rounded-lg border border-slate-200 p-3 text-sm"
        placeholder="Write your reply…"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[10px] text-slate-500">
          {dirty
            ? "Unsaved changes. Save before leaving this lead."
            : data?.draft
              ? "Draft saved to your account."
              : "Drafts are private to your account."}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!recipient || !data || !!busy || !dirty}
            onClick={() => act("save_draft")}
            className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-40"
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={
              !connected ||
              !data?.draft ||
              dirty ||
              !body.trim() ||
              !!busy ||
              uncertain
            }
            onClick={() => act("send")}
            className="rounded-lg bg-navy-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {busy === "send" ? "Sending…" : "Send email"}
          </button>
        </div>
      </div>
      {notice && (
        <p role="status" className="mt-3 text-xs text-slate-600">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
