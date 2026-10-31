"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Compass,
  Globe2,
  Inbox,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Phone,
  Search,
  ShieldCheck,
  StickyNote,
  Users,
} from "lucide-react";
import { NoteForm, StatusControls } from "@/components/inquiries/inquiry-forms";
import { StatusBadge } from "@/components/inquiries/inquiry-views";
import {
  filterWorkspace,
  inquiryWebsite,
  workspaceSummary,
} from "@/lib/client-workspace";
import type { EventRow, InquiryRow, NoteRow } from "@/lib/inquiries-data";
import { formatWhen, mailtoHref, telHref } from "@/lib/inquiries";
import { cn } from "@/lib/utils";

type Props = {
  businessName: string;
  rows: InquiryRow[];
  now: number;
  total: number | null;
  selected: InquiryRow | null;
  notes: NoteRow[];
  events: EventRow[];
  basePath: string;
  inquiryBasePath: string;
  error?: string | null;
  preview?: boolean;
};

const panel = "rounded-2xl border border-slate-200 bg-white shadow-sm";
const smallLabel =
  "text-[11px] font-semibold uppercase tracking-[.13em] text-slate-500";

export function ClientWorkspace({
  businessName,
  rows,
  now,
  total,
  selected,
  notes,
  events,
  basePath,
  inquiryBasePath,
  error,
  preview = false,
}: Props) {
  const [view, setView] = useState<"dashboard" | "leads" | "inbox">(
    "dashboard",
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [website, setWebsite] = useState("");
  const [recentOnly, setRecentOnly] = useState(false);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const summary = useMemo(() => workspaceSummary(rows, now), [rows, now]);
  const visible = useMemo(
    () =>
      filterWorkspace(rows, query, status, website).filter(
        (row) =>
          !recentOnly ||
          (Date.parse(row.received_at) >= now - 7 * 86400000 &&
            Date.parse(row.received_at) <= now),
      ),
    [rows, query, status, website, recentOnly, now],
  );
  const limited = total != null && total > rows.length;
  const draftKey = `${selected?.id ?? "none"}:${channel}`;
  const leadLink = (id: string) => `${basePath}?lead=${encodeURIComponent(id)}`;
  const contactPath = selected
    ? `${inquiryBasePath}/${selected.id}`
    : inquiryBasePath;
  const phone = selected && telHref(selected.phone_e164, selected.phone);
  const email = selected && mailtoHref(selected.email, businessName);

  return (
    <div
      className="overflow-hidden rounded-3xl border border-slate-200 bg-[#f5f7fb] text-slate-900 shadow-xl"
      data-client-workspace
    >
      <div className="flex min-h-[820px] flex-col lg:flex-row">
        <aside className="flex shrink-0 flex-col bg-[#101d35] p-5 text-white lg:w-56 lg:p-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-white/15 bg-white/5">
              <Compass className="size-6 text-orange-400" aria-hidden="true" />
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight">Compass</p>
              <p className="text-[10px] tracking-[.18em] text-slate-400 uppercase">
                Client workspace
              </p>
            </div>
          </div>
          <div className="my-6 hidden border-y border-white/10 py-5 lg:block">
            <p className="text-[10px] font-semibold tracking-widest text-slate-400 uppercase">
              Your business
            </p>
            <p className="mt-2 text-sm font-semibold leading-relaxed">
              {businessName}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-300">
              <ShieldCheck
                className="size-3.5 text-emerald-400"
                aria-hidden="true"
              />{" "}
              Private workspace
            </p>
          </div>
          <nav
            aria-label="Workspace"
            className="mt-5 flex gap-2 overflow-x-auto lg:mt-0 lg:flex-col"
          >
            {(
              [
                { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
                { key: "leads", label: "Leads", icon: Users },
                { key: "inbox", label: "Inbox", icon: MessageSquare },
              ] as const
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setView(item.key)}
                aria-pressed={view === item.key}
                className={cn(
                  "flex min-h-11 items-center gap-3 whitespace-nowrap rounded-xl px-3.5 text-left text-sm transition",
                  view === item.key
                    ? "bg-white/10 font-semibold text-white ring-1 ring-white/10"
                    : "text-slate-400 hover:bg-white/5 hover:text-white",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4",
                    view === item.key && "text-orange-400",
                  )}
                  aria-hidden="true"
                />
                {item.label}
                {item.key === "leads" && (
                  <span className="ml-auto rounded-md bg-white/10 px-1.5 text-xs">
                    {total ?? rows.length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="mt-auto hidden pt-12 lg:block">
            <div className="rounded-xl border border-white/10 p-4">
              <p className="text-sm font-medium">
                A clearer path to follow-up.
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                Your inquiries, conversations and next steps, together.
              </p>
            </div>
            <p className="mt-5 text-[10px] text-slate-500">
              POWERED BY COMPASS MARKETING
            </p>
          </div>
        </aside>

        <section
          aria-label="Workspace content"
          className="min-w-0 flex-1 p-4 sm:p-7 xl:p-9"
        >
          <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className={smallLabel}>{businessName}</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                {view === "dashboard"
                  ? "Your next opportunity starts here."
                  : view === "leads"
                    ? "Every lead. One place."
                    : "Keep the conversation going."}
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {view === "dashboard"
                  ? "See what came in, what needs attention, and what happens next."
                  : view === "leads"
                    ? "Find an inquiry, review the details, and keep your follow-up moving."
                    : "A workspace for email, text messages and your team's notes."}
              </p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
              <span className="size-1.5 rounded-full bg-orange-500" />
              {preview ? "Workspace preview" : "Client workspace"}
            </span>
          </header>
          {preview && (
            <p className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
              Review version using this client&apos;s real inquiries. Notes and
              status changes save to the CRM. Email and text sending are not
              connected in this version.
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              Inquiries could not be loaded. Refresh to retry. Counts below may
              be unavailable.
            </p>
          )}
          {limited && (
            <p className="mb-4 text-xs text-slate-600">
              Showing the newest {rows.length} of {total} inquiries. Summary
              cards, search and filters below apply to these loaded records.
            </p>
          )}

          {view === "dashboard" && (
            <>
              <section
                aria-label="Inquiry summary"
                className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4"
              >
                {[
                  {
                    label: "New inquiries",
                    value: summary.statuses.new,
                    description: "Ready for first follow-up",
                    icon: Inbox,
                    status: "new",
                    accent: true,
                  },
                  {
                    label: "Contacted",
                    value: summary.statuses.contacted,
                    description: "Keep the follow-up moving",
                    icon: MessageSquare,
                    status: "contacted",
                  },
                  {
                    label: "Closed",
                    value: summary.statuses.closed,
                    description: "Marked closed in your workspace",
                    icon: CheckCircle2,
                    status: "closed",
                  },
                  {
                    label: "Last 7 days",
                    value: summary.lastSevenDays,
                    description: "Website inquiries received",
                    icon: Globe2,
                    status: "",
                  },
                ].map((card) => (
                  <button
                    type="button"
                    key={card.label}
                    onClick={() => {
                      setStatus(card.status);
                      setRecentOnly(card.label === "Last 7 days");
                      setView("leads");
                    }}
                    className={cn(
                      panel,
                      "relative min-h-36 p-4 text-left transition hover:border-blue-300 sm:p-5",
                      card.accent && "border-orange-200",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-500">
                        {card.label}
                      </span>
                      <card.icon
                        className={cn(
                          "size-4",
                          card.accent ? "text-orange-600" : "text-slate-400",
                        )}
                        aria-hidden="true"
                      />
                    </div>
                    <p className="mt-4 text-3xl font-semibold tracking-tight">
                      {error ? "Unavailable" : card.value}
                    </p>
                    <p className="mt-2 text-[11px] text-slate-500">
                      {card.description}
                    </p>
                  </button>
                ))}
              </section>
              <div className="mb-6 grid gap-5 xl:grid-cols-[1.5fr_1fr]">
                <section className="relative overflow-hidden rounded-2xl bg-[#172b4c] p-6 text-white">
                  <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-orange-300">
                    Your follow-up focus
                  </p>
                  <h2 className="mt-3 max-w-md text-xl font-semibold leading-snug text-white">
                    {summary.statuses.new
                      ? `${summary.statuses.new} new inquiries are ready for review.`
                      : "You are up to date on new inquiries."}
                  </h2>
                  <p className="mt-3 max-w-md text-sm leading-6 text-slate-300">
                    Open a lead to review the request, add a note, and update
                    its status. Inquiry counts include test submissions and
                    unqualified requests until reviewed.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setView("leads");
                      setStatus("new");
                      setRecentOnly(false);
                    }}
                    className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 text-xs font-semibold text-slate-900"
                  >
                    Review new inquiries{" "}
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>
                </section>
                <section className={cn(panel, "p-5")}>
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">
                      Inquiries by website
                    </h2>
                    <Globe2
                      className="size-4 text-slate-400"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="mt-4 space-y-4">
                    {Object.entries(summary.websites).map(([host, count]) => (
                      <button
                        key={host}
                        type="button"
                        onClick={() => {
                          setWebsite(host);
                          setStatus("");
                          setRecentOnly(false);
                          setView("leads");
                        }}
                        className="block w-full text-left"
                      >
                        <div className="mb-1.5 flex gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate">
                            {host}
                          </span>
                          <span className="font-semibold">{count}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-blue-700"
                            style={{
                              width: `${(count / Math.max(summary.total, 1)) * 100}%`,
                            }}
                          />
                        </div>
                      </button>
                    ))}
                    {!rows.length && (
                      <p className="text-xs text-slate-500">
                        Website breakdown appears after your first inquiry.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </>
          )}

          <section
            className={cn(panel, "overflow-hidden")}
            aria-label="Lead workspace"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="font-semibold">
                  {view === "inbox" ? "Lead conversations" : "Your inquiries"}
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  {view === "inbox"
                    ? "Select a lead to review their request and communication options."
                    : "Newest inquiries first. Select a name to see the full request."}
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                {visible.length} shown
              </span>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50/60 p-3">
              <label className="flex min-w-40 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3">
                <Search className="size-4 text-slate-400" aria-hidden="true" />
                <span className="sr-only">Search leads</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, email, phone or request"
                  className="h-10 w-full min-w-0 bg-transparent text-sm outline-none"
                />
              </label>
              {recentOnly && (
                <button
                  type="button"
                  onClick={() => setRecentOnly(false)}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs text-blue-800"
                >
                  Last 7 days ×
                </button>
              )}
              <label>
                <span className="sr-only">Filter by status</span>
                <select
                  className="h-10 max-w-full rounded-lg border border-slate-200 bg-white px-3 text-xs"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  <option value="new">New</option>
                  <option value="contacted">Contacted</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label>
                <span className="sr-only">Filter by website</span>
                <select
                  className="h-10 max-w-64 rounded-lg border border-slate-200 bg-white px-3 text-xs"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                >
                  <option value="">All websites</option>
                  {Object.keys(summary.websites).map((host) => (
                    <option key={host}>{host}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid xl:grid-cols-[minmax(250px,.8fr)_minmax(0,1.2fr)]">
              <div className="max-h-[680px] overflow-auto border-b border-slate-200 xl:border-r xl:border-b-0">
                <ul className="divide-y divide-slate-100">
                  {visible.map((row) => (
                    <li key={row.id}>
                      <Link
                        href={leadLink(row.id)}
                        scroll={false}
                        className={cn(
                          "block border-l-[3px] p-4 transition hover:bg-slate-50",
                          selected?.id === row.id
                            ? "border-orange-500 bg-orange-50/40"
                            : "border-transparent",
                        )}
                        aria-current={
                          selected?.id === row.id ? "true" : undefined
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">
                            {row.name}
                          </span>
                          <StatusBadge status={row.status} />
                        </div>
                        <p className="mt-1 truncate text-[11px] font-medium text-blue-700">
                          {inquiryWebsite(row.page_url)}
                        </p>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">
                          {row.message}
                        </p>
                        <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400">
                          <time dateTime={row.received_at}>
                            {formatWhen(row.received_at)}
                          </time>
                          <ChevronRight
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
                {!visible.length && (
                  <p className="p-8 text-center text-sm text-slate-500">
                    {rows.length
                      ? "No inquiries match these filters."
                      : "New website inquiries will appear here."}
                  </p>
                )}
              </div>
              {selected ? (
                <div className="min-w-0 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold">{selected.name}</h2>
                      <p className="mt-1 break-all text-xs text-slate-500">
                        {selected.email ||
                          selected.phone ||
                          "Contact information not provided"}
                      </p>
                    </div>
                    <Link
                      href={contactPath}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"
                    >
                      Full record{" "}
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                  <div className="my-4 flex flex-wrap gap-2">
                    <StatusBadge status={selected.status} />
                    {phone && (
                      <a
                        href={phone}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1 text-xs"
                      >
                        <Phone className="size-3" aria-hidden="true" /> Call
                        lead
                      </a>
                    )}
                    {email && (
                      <a
                        href={email}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1 text-xs"
                      >
                        <Mail className="size-3" aria-hidden="true" /> Open
                        email app
                      </a>
                    )}
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <p className={smallLabel}>Original website inquiry</p>
                    <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                      {selected.message}
                    </p>
                    <p className="mt-3 text-[10px] text-slate-400">
                      Received {formatWhen(selected.received_at)}
                    </p>
                  </div>
                  <div className="mt-5 rounded-xl border border-slate-200">
                    <div
                      className="flex gap-1 border-b border-slate-200 p-2"
                      role="group"
                      aria-label="Reply channel"
                    >
                      {(
                        [
                          { key: "email", label: "Email", icon: Mail },
                          {
                            key: "sms",
                            label: "Text message",
                            icon: MessageSquare,
                          },
                        ] as const
                      ).map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          aria-pressed={channel === item.key}
                          onClick={() => setChannel(item.key)}
                          className={cn(
                            "inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium",
                            channel === item.key
                              ? "bg-slate-100 text-slate-900"
                              : "text-slate-500",
                          )}
                        >
                          <item.icon className="size-3.5" aria-hidden="true" />
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <div className="p-3">
                      <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                        {channel === "email"
                          ? "Email connection required. Sending and receiving email inside this workspace will be available after your business mailbox is connected."
                          : "Text messaging is not connected to this workspace yet. Sending requires your business number, verified registration and the lead's recorded consent."}
                      </p>
                      <label className="sr-only" htmlFor="workspace-reply">
                        Reply draft
                      </label>
                      <textarea
                        id="workspace-reply"
                        value={drafts[draftKey] ?? ""}
                        onChange={(e) =>
                          setDrafts({ ...drafts, [draftKey]: e.target.value })
                        }
                        rows={3}
                        maxLength={channel === "sms" ? 1600 : 10000}
                        className="mt-3 w-full resize-y rounded-lg border border-slate-200 p-3 text-sm outline-none focus:ring-2 focus:ring-blue-200"
                        placeholder="Try composing a reply. Nothing will be sent."
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-[10px] leading-4 text-slate-500">
                          Preview draft only. Not saved after leaving this page.
                        </span>
                        <button
                          type="button"
                          disabled
                          className="rounded-lg bg-slate-200 px-4 py-2 text-xs font-medium text-slate-500"
                        >
                          {channel === "email" ? "Send email" : "Send text"}
                        </button>
                      </div>
                    </div>
                  </div>
                  <details className="mt-5 rounded-xl border border-slate-200 p-4">
                    <summary className="cursor-pointer text-sm font-semibold">
                      Follow-up and internal notes
                    </summary>
                    <div className="mt-4 space-y-5">
                      <StatusControls
                        key={`status:${selected.id}`}
                        inquiryId={selected.id}
                        status={selected.status}
                        path={basePath}
                      />
                      <p className="flex items-center gap-2 text-xs text-slate-500">
                        <StickyNote className="size-3.5" aria-hidden="true" />{" "}
                        Notes stay in the CRM and are not sent to the lead.
                      </p>
                      {notes.map((note) => (
                        <article
                          key={note.id}
                          className="rounded-lg bg-slate-50 p-3"
                        >
                          <p className="whitespace-pre-wrap break-words text-sm">
                            {note.body}
                          </p>
                          <p className="mt-2 text-[10px] text-slate-500">
                            {note.author_name} · {formatWhen(note.created_at)}
                          </p>
                        </article>
                      ))}
                      <NoteForm
                        key={`note:${selected.id}`}
                        inquiryId={selected.id}
                        path={basePath}
                      />
                      <p className={smallLabel}>Activity</p>
                      <ol className="space-y-2 border-l border-slate-200 pl-3">
                        {events.map((event) => (
                          <li key={event.id} className="text-xs text-slate-500">
                            {event.kind === "received"
                              ? "Inquiry received"
                              : event.kind === "note_added"
                                ? "Internal note added"
                                : `Status changed to ${event.to_status}`}
                            <span className="mt-1 block text-[10px] text-slate-400">
                              {event.actor_name || "Website"} ·{" "}
                              {formatWhen(event.created_at)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="grid min-h-64 place-items-center p-8 text-center text-sm text-slate-500">
                  <div>
                    <Inbox
                      className="mx-auto mb-3 size-8 text-slate-300"
                      aria-hidden="true"
                    />
                    Select an inquiry to review its details.
                  </div>
                </div>
              )}
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}
