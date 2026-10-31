"use client";
import { useEffect, useRef, useState } from "react";
import type { Device, Call } from "@twilio/voice-sdk";
const reasons: Record<string, string> = {
  forbidden: "Your account cannot access this workspace.",
  voice_not_ready: "Calling setup is not complete.",
  verification_required: "Texting is awaiting carrier verification.",
  save_draft_first: "Save this draft before sending.",
  send_uncertain_refresh_first:
    "The send result is uncertain. Refresh before sending again.",
  no_consent: "This lead needs recorded permission for texts.",
  opted_out: "This lead opted out of texts.",
  outbound_disabled: "Text sending has not been enabled.",
  rate_limited: "Please wait a minute and try again.",
};
async function phoneRequest(
  clientId: string,
  mode: string,
  rest: Record<string, unknown> = {},
) {
  const r = await fetch("/api/client-phone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, mode, ...rest }),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error(
      reasons[data.error] ||
        "The request could not be completed. Refresh and try again.",
    );
  return data;
}
type PhoneSnapshot = {
  draft: { body: string; revision: string } | null;
  messages: {
    id: string;
    direction: string;
    body: string;
    provider_status: string;
    created_at: string;
  }[];
  calls: {
    id: string;
    direction: string;
    status: string;
    duration: number | null;
    created_at: string;
  }[];
  number: string | null;
  can_send: boolean;
  reason: string | null;
  voice_ready: boolean;
};
export function LeadText({
  clientId,
  inquiryId,
}: {
  clientId: string;
  inquiryId: string;
}) {
  const [data, setData] = useState<PhoneSnapshot | null>(null),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    phoneRequest(clientId, "load", { inquiry_id: inquiryId })
      .then((d) => {
        if (live) {
          setData(d);
          setBody(d.draft?.body || "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [clientId, inquiryId]);
  const dirty = body !== (data?.draft?.body || "");
  async function act(mode: string) {
    setBusy(mode);
    setError("");
    try {
      const d = await phoneRequest(clientId, mode, {
        inquiry_id: inquiryId,
        body,
        revision: data?.draft?.revision,
      });
      setData(d);
      if (mode !== "load" || !dirty) setBody(d.draft?.body || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="p-3" aria-label="Lead text conversation">
      <div className="mb-3 flex justify-between gap-3 text-xs">
        <span>{data?.number || "Business text messages"}</span>
        <button
          type="button"
          onClick={() => act("load")}
          disabled={!!busy}
          className="font-semibold text-blue-700"
        >
          Refresh
        </button>
      </div>
      {data?.reason && (
        <p className="mb-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          {data.reason}
        </p>
      )}
      <div className="max-h-80 space-y-3 overflow-y-auto">
        {data?.messages.map((m) => (
          <article key={m.id} className="rounded-lg bg-slate-50 p-3">
            <p className="text-[11px] text-slate-500">
              {m.direction === "inbound" ? "Received" : m.provider_status} ·{" "}
              {new Date(m.created_at).toLocaleString()}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">
              {m.body}
            </p>
          </article>
        ))}
      </div>
      <label
        className="mt-3 block text-xs font-medium"
        htmlFor={`sms-${inquiryId}`}
      >
        Text draft
      </label>
      <textarea
        id={`sms-${inquiryId}`}
        rows={4}
        maxLength={1600}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={!data || !!busy}
        className="mt-2 w-full rounded-lg border p-3 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] text-slate-500">
          {dirty
            ? "Unsaved changes"
            : data?.draft
              ? "Draft saved to your account"
              : "Drafts are private to your account"}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => act("save_draft")}
            disabled={!data || !dirty || !!busy}
            className="rounded-lg border px-3 py-2 text-xs disabled:opacity-40"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => act("send")}
            disabled={
              !data?.can_send || !data.draft || dirty || !body.trim() || !!busy
            }
            className="rounded-lg bg-navy-900 px-3 py-2 text-xs text-white disabled:opacity-40"
          >
            {busy === "send" ? "Sending…" : "Send text"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
export function WorkspacePhone({
  clientId,
  inquiryId,
  leadName,
}: {
  clientId: string;
  inquiryId?: string;
  leadName?: string;
}) {
  const device = useRef<Device | null>(null),
    call = useRef<Call | null>(null),
    mounted = useRef(true);
  const [status, setStatus] = useState("Phone disconnected"),
    [busy, setBusy] = useState(false),
    [incoming, setIncoming] = useState(false),
    [connected, setConnected] = useState(false),
    [hasCall, setHasCall] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      call.current?.disconnect();
      device.current?.destroy();
      device.current = null;
    };
  }, [clientId]);
  function bind(c: Call) {
    call.current = c;
    setHasCall(true);
    const done = () => {
      call.current = null;
      if (mounted.current) {
        setIncoming(false);
        setHasCall(false);
        setStatus("Phone ready");
      }
    };
    c.on("disconnect", done);
    c.on("cancel", done);
    c.on("reject", done);
    c.on("error", () => {
      done();
      if (mounted.current) setError("The call ended with a connection error.");
    });
    c.on("accept", () => {
      if (mounted.current) {
        setIncoming(false);
        setStatus("Call in progress");
      }
    });
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const [{ Device }, r] = await Promise.all([
        import("@twilio/voice-sdk"),
        phoneRequest(clientId, "voice_token"),
      ]);
      if (!mounted.current) return;
      const d = new Device(r.token, { logLevel: 0 });
      device.current = d;
      d.on("registered", () => {
        if (mounted.current) {
          setConnected(true);
          setStatus("Phone ready");
        }
      });
      d.on("incoming", (c) => {
        if (call.current) {
          c.reject();
          return;
        }
        bind(c);
        setIncoming(true);
        setStatus("Incoming call");
      });
      d.on("tokenWillExpire", async () => {
        try {
          const fresh = await phoneRequest(clientId, "voice_token");
          d.updateToken(fresh.token);
        } catch {
          d.destroy();
          if (mounted.current) {
            setConnected(false);
            setStatus("Reconnect phone");
          }
        }
      });
      d.on("error", () => {
        if (mounted.current)
          setError(
            "The phone connection failed. Check microphone permission and reconnect.",
          );
      });
      await d.register();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Phone unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function dial() {
    if (!device.current || !inquiryId || call.current) return;
    setBusy(true);
    setError("");
    try {
      const r = await phoneRequest(clientId, "prepare_call", {
        inquiry_id: inquiryId,
      });
      const c = await device.current.connect({ params: { Intent: r.intent } });
      bind(c);
      setStatus("Calling " + (leadName || "lead"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Call failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Business phone"
      className="mb-5 rounded-xl border border-slate-200 bg-white p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Business phone</p>
          <p role="status" className="mt-1 text-xs text-slate-600">
            {status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              Connect phone
            </button>
          ) : (
            <button
              type="button"
              onClick={dial}
              disabled={busy || !inquiryId || hasCall}
              className="rounded-lg bg-navy-900 px-3 py-2 text-xs text-white disabled:opacity-40"
            >
              Call {leadName || "selected lead"}
            </button>
          )}
          {incoming && (
            <button
              type="button"
              onClick={() => call.current?.accept()}
              className="rounded-lg bg-green-700 px-3 py-2 text-xs text-white"
            >
              Answer
            </button>
          )}
          {hasCall && (
            <button
              type="button"
              onClick={() => {
                if (incoming) call.current?.reject();
                else call.current?.disconnect();
              }}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              {incoming ? "Decline" : "End call"}
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Keep this page open to receive calls. Your browser will request
        microphone access when needed.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

export function LeadCalls({
  clientId,
  inquiryId,
}: {
  clientId: string;
  inquiryId: string;
}) {
  const [calls, setCalls] = useState<PhoneSnapshot["calls"]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    phoneRequest(clientId, "load", { inquiry_id: inquiryId })
      .then((d) => {
        if (live) setCalls(d.calls);
      })
      .catch(() => {
        if (live) setError("Call history could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [clientId, inquiryId]);
  async function refresh() {
    try {
      const d = await phoneRequest(clientId, "load", { inquiry_id: inquiryId });
      setCalls(d.calls);
      setError("");
    } catch {
      setError("Call history could not be loaded.");
    }
  }
  return (
    <section
      className="mt-5 rounded-xl border border-slate-200 p-4"
      aria-label="Lead call history"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Calls with this lead</h3>
        <button
          type="button"
          onClick={refresh}
          className="text-xs font-semibold text-blue-700"
        >
          Refresh calls
        </button>
      </div>
      {!calls.length && !error && (
        <p className="mt-2 text-xs text-slate-500">
          No calls recorded through this workspace yet.
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {calls.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap justify-between gap-2 text-xs"
          >
            <span>
              {c.direction === "inbound" ? "Incoming" : "Outgoing"} ·{" "}
              {c.status.replaceAll("-", " ")}
              {c.duration != null ? ` · ${c.duration}s` : ""}
            </span>
            <span className="text-slate-500">
              {new Date(c.created_at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
