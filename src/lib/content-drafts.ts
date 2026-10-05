// Content drafts (0067) in the CRM: statuses, what a teammate may do in each,
// and a small, escaping Markdown preview. The database enforces every rule
// again; this only decides what the draft page offers.

export const DRAFT_STATUSES = ["requested", "draft", "in_review", "approved", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const isDraftStatus = (v: unknown): v is DraftStatus => DRAFT_STATUSES.includes(v as DraftStatus);

export const draftStatusLabels: Record<DraftStatus, { label: string; className: string }> = {
  requested: { label: "Generating", className: "border-violet-200 bg-violet-100 text-violet-800" },
  draft: { label: "Draft", className: "border-slate-200 bg-slate-100 text-slate-700" },
  in_review: { label: "In review", className: "border-amber-200 bg-amber-100 text-amber-900" },
  approved: { label: "Approved", className: "border-green-200 bg-green-100 text-green-800" },
  rejected: { label: "Rejected", className: "border-red-200 bg-red-100 text-red-800" },
};

export type DraftAction = "edit" | "submit" | "withdraw" | "approve" | "reject" | "regenerate" | "reopen" | "delete" | "export";

export function draftActions(d: { status: string; final_content_post_id: string | null; title: string | null }): DraftAction[] {
  const out: DraftAction[] = [];
  switch (d.status) {
    case "draft": out.push("edit", "submit", "regenerate"); break;
    case "rejected": out.push("edit", "regenerate"); break;
    case "in_review": out.push("approve", "reject", "withdraw"); break;
    case "approved": out.push("reopen"); break;
  }
  if (d.status !== "approved" && !d.final_content_post_id) out.push("delete");
  if (d.title) out.push("export");
  return out;
}

// ── Markdown preview ────────────────────────────────────────────────────────
// Headings (##, ###), paragraphs, bullet and numbered lists, **bold**,
// *italic* and [links](http…). Everything is text: nothing is passed through
// as HTML, and a link is only an http(s) URL.
export type MdInline = { t: "text" | "strong" | "em"; v: string } | { t: "link"; v: string; href: string };
export type MdBlock =
  | { t: "h2" | "h3"; inline: MdInline[] }
  | { t: "p"; inline: MdInline[] }
  | { t: "ul" | "ol"; items: MdInline[][] };

export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "link", v: m[1], href: m[2] });
    else if (m[3] !== undefined) out.push({ t: "strong", v: m[3] });
    else out.push({ t: "em", v: m[4] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

export function parseMarkdown(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: MdInline[][] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inline: parseInline(para.join(" ")) });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (!line) { flush(); continue; }
    if (h) { flush(); blocks.push({ t: h[1].length === 2 ? "h2" : "h3", inline: parseInline(h[2]) }); continue; }
    if (ul || ol) {
      if (para.length) { blocks.push({ t: "p", inline: parseInline(para.join(" ")) }); para = []; }
      const kind = ul ? "ul" : "ol";
      if (!list || list.t !== kind) { if (list) blocks.push(list); list = { t: kind, items: [] }; }
      list.items.push(parseInline((ul ?? ol)![1]));
      continue;
    }
    if (list) { blocks.push(list); list = null; }
    para.push(line);
  }
  flush();
  return blocks;
}
