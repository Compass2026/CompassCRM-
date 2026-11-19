"use client";
import { useEffect, useRef, useState } from "react";
import type { Device, Call } from "@twilio/voice-sdk";
import { phoneReasons as reasons } from "@/lib/client-phone-messages";
import { afterSend, canPress, classifySend, newComposer, sendsOnKey, type Composer } from "@/lib/client-phone-composer";
import { messageStatusLabel } from "@/lib/communications";
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
    recordings?: {id:string;state:string;duration:number;summary:string|null;transcript:string|null;expires_at:string;error_code:string|null}[];
  }[];
  number: string | null;
  recipient?: string | null;
  can_send: boolean;
  reason: string | null;
  voice_ready: boolean;
};
// The lead's text thread and composer, like any messaging app: type, press
// Send (or Enter; Shift+Enter is a new line). The press saves the text and
// sends it in one request; the composer clears only once Twilio has taken it.
// Unsent text is kept as a private draft in the background. Rules:
// src/lib/client-phone-composer.ts.
export function LeadText({
  clientId,
  inquiryId,
}: {
  clientId: string;
  inquiryId: string;
}) {
  const [data, setData] = useState<PhoneSnapshot | null>(null),
    [composer, setComposer] = useState<Composer>(() => newComposer("", crypto.randomUUID())),
    [sending, setSending] = useState(false),
    [loadError, setLoadError] = useState("");
  const latest = useRef(composer);
  useEffect(() => {
    latest.current = composer;
  }, [composer]);
  const inFlight = useRef(false);
  const saved = useRef("");
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  async function load() {
    try {
      const d = await phoneRequest(clientId, "load", { inquiry_id: inquiryId });
      setData(d);
      setLoadError("");
      return d as PhoneSnapshot;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "The conversation could not be loaded.");
      return null;
    }
  }
  useEffect(() => {
    let live = true;
    phoneRequest(clientId, "load", { inquiry_id: inquiryId })
      .then((d: PhoneSnapshot) => {
        if (!live) return;
        setData(d);
        saved.current = d.draft?.body || "";
        setComposer((c) => (c.body ? c : { ...c, body: saved.current }));
      })
      .catch((e) => {
        if (live) setLoadError(e.message);
      });
    return () => {
      live = false;
      if (autosave.current) clearTimeout(autosave.current);
    };
  }, [clientId, inquiryId]);

  // Background draft: a quiet save a moment after typing stops. Never sends.
  function edit(body: string) {
    latest.current = { ...latest.current, body, error: "" };
    setComposer(latest.current);
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = setTimeout(() => {
      autosave.current = null;
      if (inFlight.current || body === saved.current) return;
      saving.current = saving.current
        .then(() => phoneRequest(clientId, "autosave", { inquiry_id: inquiryId, body }))
        .then(() => { saved.current = body; })
        .catch(() => {});
    }, 1200);
  }

  async function send() {
    const c = latest.current;
    if (inFlight.current || !canPress(c, { canSend: !!data?.can_send, sending })) return;
    inFlight.current = true;
    setSending(true);
    if (autosave.current) { clearTimeout(autosave.current); autosave.current = null; }
    const sentBody = c.sentBody ?? c.body;
    let status: number | null = null, reply: unknown = null;
    try {
      await saving.current; // a background save never lands after the send
      const r = await fetch("/api/client-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, mode: "send", inquiry_id: inquiryId, body: sentBody, request_id: c.requestId }),
      });
      status = r.status;
      reply = await r.json().catch(() => null);
    } catch {
      status = null;
    }
    const outcome = classifySend(status, reply);
    const d = reply as (PhoneSnapshot & { send?: unknown }) | null;
    if (status === 200 && d?.messages) setData(d);
    const next = afterSend({ ...latest.current, sentBody }, outcome, crypto.randomUUID());
    if (outcome.kind === "accepted") saved.current = next.body;
    setComposer(next);
    if (outcome.kind !== "accepted" && status !== 200) void load();
    inFlight.current = false;
    setSending(false);
  }

  const ready = canPress(composer, { canSend: !!data?.can_send, sending });
  return (
    <section className="p-3" aria-label="Lead text conversation">
      <div className="mb-3 flex justify-between gap-3 text-xs">
        <span>
          {data?.number ? `From ${data.number}` : "Business text messages"}
          {data?.recipient ? ` · to ${data.recipient}` : ""}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={sending}
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
      <div className="max-h-80 space-y-3 overflow-y-auto" data-sms-thread>
        {data?.messages.map((m) => (
          <article
            key={m.id}
            data-sms-message={m.direction}
            className={
              m.direction === "inbound"
                ? "mr-8 rounded-lg bg-slate-50 p-3"
                : "ml-8 rounded-lg bg-blue-50 p-3"
            }
          >
            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
            <p className="mt-1 text-[11px] text-slate-500" data-sms-status>
              {messageStatusLabel(m.provider_status, m.direction === "inbound" ? "inbound" : "outbound")} ·{" "}
              {new Date(m.created_at).toLocaleString()}
            </p>
          </article>
        ))}
      </div>
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor={`sms-${inquiryId}`}>
          Text message
        </label>
        <textarea
          id={`sms-${inquiryId}`}
          rows={2}
          maxLength={1600}
          placeholder="Text message"
          value={composer.body}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={!data}
          className="min-h-11 w-full resize-y rounded-lg border p-3 text-sm"
        />
        <button
          type="submit"
          disabled={!ready}
          className="min-h-11 shrink-0 rounded-lg bg-navy-900 px-4 text-sm font-medium text-white disabled:opacity-40"
        >
          {sending ? "Sending…" : composer.checking ? "Check status" : "Send"}
        </button>
      </form>
      <p className="mt-1 text-[10px] text-slate-500">Enter to send · Shift+Enter for a new line</p>
      {composer.notice && (
        <p role="status" className="mt-2 text-xs text-amber-800">
          {composer.notice}
        </p>
      )}
      {(composer.error || loadError) && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {composer.error || loadError}
        </p>
      )}
    </section>
  );
}
export function WorkspacePhone({
  clientId,
  inquiryId,
  leadName,
  leadPhone,
}: {
  clientId: string;
  inquiryId?: string;
  leadName?: string;
  leadPhone?: string | null;
}) {
  const callable = !!leadPhone && /^\+[1-9][0-9]{7,14}$/.test(leadPhone);
  const device = useRef<Device | null>(null),
    call = useRef<Call | null>(null),
    mounted = useRef(true);
  const [status, setStatus] = useState("Phone disconnected"),
    [busy, setBusy] = useState(false),
    [incoming, setIncoming] = useState(false),
    [connected, setConnected] = useState(false),
    [hasCall, setHasCall] = useState(false),
    [error, setError] = useState("");
  const [readiness,setReadiness]=useState<{enabled:boolean;number:string|null;recording_enabled:boolean;summaries_enabled:boolean}|null>(null);
  const [muted,setMuted]=useState(false);
  const [recordingStopped,setRecordingStopped]=useState(false);
  useEffect(()=>{let live=true;phoneRequest(clientId,"voice_status").then(d=>{if(live)setReadiness(d);}).catch(()=>{});return()=>{live=false;};},[clientId]);
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
    setRecordingStopped(false);
    const done = () => {
      call.current = null;
      if (mounted.current) {
        setIncoming(false);
        setHasCall(false);
        setMuted(false);
        setStatus("Phone ready");
        window.dispatchEvent(new Event("compass-call-ended"));
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
      device.current?.destroy();
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
      d.on("unregistered",()=>{if(mounted.current){setConnected(false);setStatus("Reconnect phone");}});
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
      aria-label="Browser calling on the business line"
      className="mb-5 rounded-xl border border-slate-200 bg-white p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Browser calling{readiness?.number ? ` · business line ${readiness.number}`:""}</p>
          <p role="status" className="mt-1 text-xs text-slate-600">
            {status}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <button
              type="button"
              onClick={connect}
              disabled={busy || !readiness?.enabled}
              className="rounded-lg border px-3 py-2 text-xs"
            >
              {readiness && !readiness.enabled ? "Browser calling not set up":"Connect browser phone"}
            </button>
          ) : (
            <button
              type="button"
              onClick={dial}
              disabled={busy || !inquiryId || hasCall || !callable}
              title={inquiryId && !callable ? reasons.no_lead_phone : undefined}
              className="rounded-lg bg-navy-900 px-3 py-2 text-xs text-white disabled:opacity-40"
            >
              Call {leadName || "selected lead"} in browser
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
            <button type="button" onClick={()=>{call.current?.mute(!muted);setMuted(!muted);}} className="rounded-lg border px-3 py-2 text-xs" aria-pressed={muted}>{muted?"Unmute":"Mute"}</button>
          )}
          {hasCall && !incoming && readiness?.recording_enabled && <button type="button" disabled={busy || recordingStopped} onClick={async()=>{
            setBusy(true);try{await phoneRequest(clientId,"stop_recording",{call_sid:call.current?.parameters.CallSid});setRecordingStopped(true);}catch{setError("Recording could not be stopped. End the call if recording must stop.");}finally{setBusy(false);}
          }} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-40">{recordingStopped?"Recording stopped":"Stop recording"}</button>}
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
        Calls ring through this browser on the business line and are logged
        on the lead. Keep this page open to receive calls. Your browser will
        request microphone access when needed.
      </p>
      {connected && inquiryId && !callable && (
        <p className="mt-2 text-xs text-amber-800">{reasons.no_lead_phone}</p>
      )}
      {readiness?.recording_enabled && <p className="mt-2 text-xs text-slate-600">Recording is offered with the caller’s permission.{readiness.summaries_enabled?" A transcript and AI summary will appear in call history when ready.":""}</p>}
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
            className="rounded-lg border border-slate-100 p-3 text-xs"
          >
            <span>
              {c.direction === "inbound" ? "Incoming" : "Outgoing"} ·{" "}
              {c.status.replaceAll("-", " ")}
              {c.duration != null ? ` · ${c.duration}s` : ""}
            </span>
            <span className="text-slate-500">
              {new Date(c.created_at).toLocaleString()}
            </span>
            {c.recordings?.map(r=><CallRecording key={r.id} recording={r} clientId={clientId} inquiryId={inquiryId}/>)}
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

function CallRecording({recording:r,clientId,inquiryId}:{recording:NonNullable<PhoneSnapshot["calls"][number]["recordings"]>[number];clientId:string;inquiryId:string}) {
  const [audio,setAudio]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [transcript,setTranscript]=useState<string|null>(null);
  useEffect(()=>()=>{if(audio)URL.revokeObjectURL(audio);},[audio]);
  async function play(){setBusy(true);setError("");try{
    const res=await fetch("/api/client-phone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"recording",client_id:clientId,inquiry_id:inquiryId,recording_id:r.id})});
    if(!res.ok)throw Error("Recording could not be loaded.");setAudio(URL.createObjectURL(await res.blob()));
  }catch(e){setError(e instanceof Error?e.message:"Recording unavailable.");}finally{setBusy(false);}}
  return <div className="mt-3 space-y-3 border-t pt-3">
    {audio?<audio controls src={audio} className="w-full" aria-label="Call recording"/>:<button type="button" disabled={busy} onClick={play} className="font-semibold text-blue-700">{busy?"Loading recording…":"Listen to recording"}</button>}
    <p className="text-slate-500">Available until {new Date(r.expires_at).toLocaleDateString()}</p>
    {r.summary?<div><p className="font-semibold">AI call summary</p><p className="mt-1 whitespace-pre-wrap">{r.summary}</p><p className="mt-2 text-slate-500">Check against the recording before acting.</p></div>:<p className="text-slate-500">{["failed","uncertain"].includes(r.state)?"Summary needs attention from your Compass team.":["queued","submitted"].includes(r.state)?"Transcript and summary are processing.":"Recording saved."}</p>}
    {r.state==="ready" && <details onToggle={async e=>{if(e.currentTarget.open && !transcript){try{const d=await phoneRequest(clientId,"transcript",{inquiry_id:inquiryId,recording_id:r.id});setTranscript(d.transcript || "Transcript unavailable.");}catch{setError("Transcript could not be loaded.");}}}}><summary className="cursor-pointer font-semibold">View transcript</summary><p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap">{transcript || "Loading transcript…"}</p></details>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </div>;
}
