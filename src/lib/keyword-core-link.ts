// Linking a long-tail keyword to the core keyword it serves (20261120200000).
// The database decides eligibility (keyword_core_link_problem) and lists the
// options (keyword_core_link_options); this only shapes those rows for the
// Keywords tab and turns a refusal into a sentence.

export type CoreLinkOptionRow = {
  keyword_id: string;
  parent_id: string;
  parent_keyword: string;
  parent_city: string | null;
  list_version: number | null;
  is_current: boolean;
  problem: string | null;
};

export type CoreLinkParent = { id: string; keyword: string; city: string | null; listVersion: number | null };

export type CoreLinkState = {
  current: (CoreLinkParent & { problem: string | null }) | null;
  candidates: CoreLinkParent[];
};

// One entry per keyword the database returned a row for: its current link (with
// the link's problem today, null when sound) and the eligible parents other
// than the current one, in the database's order.
export function groupCoreLinkOptions(rows: readonly CoreLinkOptionRow[]): Map<string, CoreLinkState> {
  const out = new Map<string, CoreLinkState>();
  for (const r of rows) {
    const s = out.get(r.keyword_id) ?? { current: null, candidates: [] };
    const parent = { id: r.parent_id, keyword: r.parent_keyword, city: r.parent_city, listVersion: r.list_version };
    if (r.is_current) s.current = { ...parent, problem: r.problem };
    else if (r.problem === null && !s.candidates.some((c) => c.id === r.parent_id)) s.candidates.push(parent);
    out.set(r.keyword_id, s);
  }
  return out;
}

export const CORE_LINK_REASON_MIN = 3;
export const CORE_LINK_REASON_MAX = 500;

// The same bounds the database enforces (reason_required); checked here so a
// blank reason never makes the round trip.
export function coreLinkReason(raw: FormDataEntryValue | null): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < CORE_LINK_REASON_MIN || reason.length > CORE_LINK_REASON_MAX) {
    return { ok: false, message: `Give a reason (${CORE_LINK_REASON_MIN} to ${CORE_LINK_REASON_MAX} characters).` };
  }
  return { ok: true, reason };
}

const CODE_LABEL: Record<string, string> = {
  not_team: "Only a signed-in teammate can change core links.",
  reason_required: "Give a reason for the change.",
  core_parent_link_required: "Core links change only through Link / Unlink.",
};

// "city_mismatch: the core keyword is for Wichita, ..." → the sentence after
// the code; known codes without a useful sentence get a fixed one.
export function coreLinkErrorMessage(message: string): string {
  const m = /^([a-z_]+):\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return message;
  const [, code, rest] = m;
  if (CODE_LABEL[code]) return CODE_LABEL[code];
  const sentence = rest.trim();
  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : message;
}

export function coreParentLabel(p: Pick<CoreLinkParent, "keyword" | "listVersion">): string {
  return `${p.keyword}${p.listVersion ? ` (core v${p.listVersion})` : ""}`;
}
