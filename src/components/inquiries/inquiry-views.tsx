import Link from "next/link";
import { Mail, Phone, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NoteForm, StatusControls } from "@/components/inquiries/inquiry-forms";
import type { EventRow, InquiryRow, NoteRow } from "@/lib/inquiries-data";
import { formatPhone } from "@/lib/communications";
import {
  INQUIRY_STATUSES,
  INQUIRY_STATUS_LABELS,
  INQUIRY_STATUS_STYLES,
  formatWhen,
  mailtoHref,
  telHref,
  type InquiryStatus,
} from "@/lib/inquiries";
import { cn } from "@/lib/utils";

// CRM Lite's inquiry list and detail, shared by the agency workspace and the
// client portal. Server components; the only interactive parts are the
// status buttons and the note form.

export function StatusBadge({ status }: { status: InquiryStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", INQUIRY_STATUS_STYLES[status])}
      data-inquiry-status={status}>
      {INQUIRY_STATUS_LABELS[status]}
    </span>
  );
}

function phoneText(r: { phone: string | null; phone_e164: string | null }) {
  return r.phone_e164 ? formatPhone(r.phone_e164) : r.phone || null;
}

export function InquiryList({ basePath, rows, counts, q, status }: {
  basePath: string;
  rows: InquiryRow[];
  counts: Record<InquiryStatus | "all", number>;
  q: string;
  status: InquiryStatus | null;
}) {
  const link = (s: InquiryStatus | null) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (s) p.set("status", s);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  return (
    <div className="space-y-4">
      <form method="get" action={basePath} className="flex gap-2" role="search">
        {status && <input type="hidden" name="status" value={status} />}
        <label htmlFor="inquiry-search" className="sr-only">Search by name, email or phone</label>
        <Input id="inquiry-search" name="q" defaultValue={q} placeholder="Search name, email or phone" className="h-10" />
        <Button type="submit" variant="outline" size="lg" aria-label="Search"><Search aria-hidden="true" /></Button>
      </form>
      <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Filter by status">
        {[null, ...INQUIRY_STATUSES].map((s) => {
          const active = s === status;
          return (
            <Link key={s ?? "all"} href={link(s)} aria-current={active ? "page" : undefined}
              className={cn("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm",
                active ? "border-navy-900 bg-navy-900 text-white" : "border-border bg-card hover:bg-muted")}>
              {s ? INQUIRY_STATUS_LABELS[s] : "All"} <span className="opacity-70">{counts[s ?? "all"]}</span>
            </Link>
          );
        })}
      </nav>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {q || status ? "No inquiries match." : "No website inquiries yet. New ones appear here as soon as they're submitted."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card" data-inquiry-list>
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`${basePath}/${r.id}`} className="flex flex-col gap-1 p-4 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate font-medium", r.status === "new" && "font-semibold")}>{r.name}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {[r.service_type, r.location].filter(Boolean).join(" · ") || r.email || phoneText(r)}
                  </p>
                  <p className="line-clamp-1 text-sm text-muted-foreground">{r.message}</p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={r.received_at}>{formatWhen(r.received_at)}</time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EVENT_TEXT: Record<string, (e: EventRow) => string> = {
  received: () => "Inquiry received from the website",
  status_changed: (e) => `Status: ${label(e.from_status)} → ${label(e.to_status)}`,
  note_added: () => "Note added",
};
function label(s: string | null) {
  return s && s in INQUIRY_STATUS_LABELS ? INQUIRY_STATUS_LABELS[s as InquiryStatus] : s ?? "—";
}

export function InquiryDetail({ inquiry, notes, events, basePath, businessName }: {
  inquiry: InquiryRow; notes: NoteRow[]; events: EventRow[]; basePath: string; businessName: string;
}) {
  const path = `${basePath}/${inquiry.id}`;
  const tel = telHref(inquiry.phone_e164, inquiry.phone);
  const mail = mailtoHref(inquiry.email, businessName);
  const fields = [
    ["Service", inquiry.service_type],
    ["Location", inquiry.location],
    ["Budget", inquiry.budget],
    ["Submitted", formatWhen(inquiry.submitted_at)],
  ].filter(([, v]) => v) as [string, string][];
  return (
    <div className="space-y-6" data-inquiry-detail>
      <Link href={basePath} className="inline-flex text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
        &larr; All inquiries
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold text-navy-900">{inquiry.name}</h2>
        <StatusBadge status={inquiry.status} />
      </div>

      <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Contact">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          {inquiry.email && <div><span className="text-muted-foreground">Email</span><div className="break-all">{inquiry.email}</div></div>}
          {phoneText(inquiry) && <div><span className="text-muted-foreground">Phone</span><div>{phoneText(inquiry)}</div></div>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {tel && (
            <a href={tel} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 text-sm font-medium text-white hover:bg-navy-800">
              <Phone className="size-4" aria-hidden="true" /> Call
            </a>
          )}
          {mail && (
            <a href={mail} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium hover:bg-muted">
              <Mail className="size-4" aria-hidden="true" /> Email
            </a>
          )}
        </div>
      </section>

      <section className="space-y-3" aria-label="Status">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Follow-up</h3>
        <StatusControls inquiryId={inquiry.id} status={inquiry.status} path={path} />
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Inquiry">
        {fields.length > 0 && (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {fields.map(([k, v]) => (
              <div key={k}><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        )}
        <div>
          <h3 className="text-sm text-muted-foreground">Message</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed" data-inquiry-message>{inquiry.message}</p>
        </div>
        {inquiry.page_url && <p className="text-xs text-muted-foreground break-all">From {inquiry.page_url}</p>}
      </section>

      <section className="space-y-3" aria-label="Notes">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Notes</h3>
        {notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg border bg-card p-3" data-inquiry-note>
                <p className="whitespace-pre-wrap break-words text-sm">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{n.author_name} · {formatWhen(n.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
        <NoteForm inquiryId={inquiry.id} path={path} />
      </section>

      <section className="space-y-2" aria-label="History">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">History</h3>
        <ol className="space-y-1 border-l pl-4 text-sm" data-inquiry-history>
          {events.map((e) => (
            <li key={e.id}>
              <span>{(EVENT_TEXT[e.kind] ?? (() => e.kind))(e)}</span>
              <span className="text-muted-foreground"> — {e.actor_name ?? (e.actor_kind === "website" ? "Website" : "Compass")}, {formatWhen(e.created_at)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
