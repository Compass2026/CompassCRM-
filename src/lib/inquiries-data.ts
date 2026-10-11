import type { createClient } from "@/lib/supabase/server";
import { isInquiryStatus, searchFilter, type InquiryStatus } from "@/lib/inquiries";

type Supabase = Awaited<ReturnType<typeof createClient>>;

// CRM Lite reads. A teammate reads the base tables (team RLS); a portal
// contact reads only the portal_* views, which carry their own client's
// inquiries while its portal access is on. Same shape for both screens.
export type Scope = { kind: "team"; clientId: string } | { kind: "portal" };

export type InquiryRow = {
  id: string;
  client_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  location: string | null;
  service_type: string | null;
  budget: string | null;
  message: string;
  page_url: string | null;
  submitted_at: string;
  received_at: string;
  status: InquiryStatus;
  status_changed_at: string | null;
};

export type NoteRow = { id: string; body: string; author_kind: string; author_name: string; created_at: string };
export type EventRow = { id: string; kind: string; from_status: string | null; to_status: string | null; actor_kind: string; actor_name: string | null; created_at: string };

const COLUMNS = "id, client_id, name, email, phone, phone_e164, location, service_type, budget, message, page_url, submitted_at, received_at, status, status_changed_at";

function normalize(rows: unknown[] | null): InquiryRow[] {
  return ((rows ?? []) as InquiryRow[]).filter((r) => r && r.id && isInquiryStatus(r.status));
}

export async function loadInquiries(supabase: Supabase, scope: Scope, opts: { q?: string; status?: string }) {
  const filter = searchFilter(opts.q ?? "");
  const status = isInquiryStatus(opts.status) ? opts.status : null;
  // Team: the base table for one client. Portal: the view (own client only).
  const list = () => {
    if (scope.kind === "team") {
      let q = supabase.from("inquiries").select(COLUMNS).eq("client_id", scope.clientId);
      if (status) q = q.eq("status", status);
      if (filter) q = q.or(filter);
      return q.order("received_at", { ascending: false }).limit(200);
    }
    let q = supabase.from("portal_inquiries").select(COLUMNS);
    if (status) q = q.eq("status", status);
    if (filter) q = q.or(filter);
    return q.order("received_at", { ascending: false }).limit(200);
  };
  // Counts per status for the filter chips (whole list, not the search).
  const all = () => scope.kind === "team"
    ? supabase.from("inquiries").select("status").eq("client_id", scope.clientId)
    : supabase.from("portal_inquiries").select("status");
  const [{ data, error }, { data: every }] = await Promise.all([list(), all()]);
  const tally: Record<InquiryStatus | "all", number> = { all: 0, new: 0, contacted: 0, closed: 0 };
  for (const r of (every ?? []) as { status: string | null }[]) {
    tally.all++;
    if (isInquiryStatus(r.status)) tally[r.status]++;
  }
  return { rows: normalize(data as unknown[] | null), counts: tally, error: error?.message ?? null };
}

export async function loadInquiry(supabase: Supabase, scope: Scope, inquiryId: string) {
  const one = scope.kind === "team"
    ? supabase.from("inquiries").select(COLUMNS).eq("id", inquiryId).eq("client_id", scope.clientId).maybeSingle()
    : supabase.from("portal_inquiries").select(COLUMNS).eq("id", inquiryId).maybeSingle();
  const notes = scope.kind === "team"
    ? supabase.from("inquiry_notes").select("id, body, author_kind, author_name, created_at").eq("inquiry_id", inquiryId).order("created_at")
    : supabase.from("portal_inquiry_notes").select("id, body, author_kind, author_name, created_at").eq("inquiry_id", inquiryId).order("created_at");
  const kinds = ["received", "status_changed", "note_added"];
  const events = scope.kind === "team"
    ? supabase.from("inquiry_events").select("id, kind, from_status, to_status, actor_kind, actor_name, created_at")
        .eq("inquiry_id", inquiryId).in("kind", kinds).order("created_at")
    : supabase.from("portal_inquiry_events").select("id, kind, from_status, to_status, actor_kind, actor_name, created_at")
        .eq("inquiry_id", inquiryId).in("kind", kinds).order("created_at");
  const [{ data: row }, { data: n }, { data: e }] = await Promise.all([one, notes, events]);
  const [inquiry] = normalize(row ? [row] : []);
  return {
    inquiry: inquiry ?? null,
    notes: (n ?? []) as NoteRow[],
    events: (e ?? []) as EventRow[],
  };
}
