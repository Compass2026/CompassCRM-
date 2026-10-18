// A blog's TL;DR (Oct 18 2026): one short, plain-language summary at the top
// of every new client blog. Pure; shared by the linter, the publisher, the
// Markdown export and the review page so there is exactly one representation.
//
//   Order on the page: title (H1) → TL;DR → hero image → article → CTA.
//
// The summary is its own field (content_drafts.tldr), never part of
// body_markdown, so no renderer can show it twice. A site whose
// compass-blog.json advertises `tldr: true` renders the field in its own slot;
// any other site receives it once, as the first paragraph of the body
// (`**TL;DR:** …`), which lands in the same place for sites without a hero.
// The label is the renderer's; the stored text never starts with it.
export const TLDR_LABEL = "TL;DR";

export const TLDR_RULES = {
  tldr_min_sentences: 2,
  tldr_max_sentences: 3,
  tldr_max_chars: 450,
} as const;

/** Sentences as a reader counts them: a terminal . ! or ? followed by a space or the end. */
export function sentenceCount(text: string): number {
  const t = text.replace(/\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|U\.S)\./gi, (m) => m.replace(/\./g, ""));
  return t.split(/(?<=[.!?])["'”’)]?\s+/).map((s) => s.trim()).filter(Boolean).length;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type TldrProblem = { code: string; message: string };

/**
 * Why a TL;DR cannot stand (empty when it can). `context` is the draft's other
 * reader-visible fields, so the summary never duplicates the title or metadata
 * and the body never carries a second one.
 */
export function tldrProblems(tldr: string | null | undefined, context: { title?: string | null; h1?: string | null; meta_description?: string | null; body_markdown?: string | null }): TldrProblem[] {
  const out: TldrProblem[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  const body = context.body_markdown ?? "";
  if (/(^|\n)\s*(?:[*_>#-]+\s*)*tl\s*;?\s*dr\b/i.test(body)) {
    add("tldr_in_body", "The TL;DR is its own field. Remove the TL;DR from the body so it appears exactly once.");
  }
  const t = (tldr ?? "").trim();
  if (!t) {
    add("tldr_missing", `Every blog starts with a ${TLDR_LABEL}: ${TLDR_RULES.tldr_min_sentences}–${TLDR_RULES.tldr_max_sentences} plain sentences that answer the main question.`);
    return out;
  }
  if (/^\W*tl\s*;?\s*dr\b/i.test(t)) add("tldr_label_included", `Write only the summary; the page adds the "${TLDR_LABEL}" label.`);
  if (/\n/.test(t)) add("tldr_format", "The TL;DR is one short paragraph (no line breaks).");
  if (/\[[^\]]*\]\([^)]*\)|https?:\/\/|\bwww\./i.test(t)) add("tldr_format", "The TL;DR has no links or URLs; the article carries the citations.");
  if (/(^|\s)(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)|[*_`<>{}|]/.test(t)) add("tldr_format", "The TL;DR is plain text: no headings, lists, emphasis or markup.");
  if (t.length > TLDR_RULES.tldr_max_chars) add("tldr_too_long", `Keep the TL;DR to ${TLDR_RULES.tldr_max_chars} characters (this is ${t.length}).`);
  const n = sentenceCount(t);
  if (n < TLDR_RULES.tldr_min_sentences || n > TLDR_RULES.tldr_max_sentences) {
    add("tldr_sentences", `Write ${TLDR_RULES.tldr_min_sentences}–${TLDR_RULES.tldr_max_sentences} sentences in the TL;DR (this has ${n}).`);
  }
  if (!/[.!?]["'”’)]?$/.test(t)) add("tldr_format", "End the TL;DR with a full stop.");
  const nt = norm(t);
  for (const [label, v] of [["title", context.title], ["H1", context.h1], ["meta description", context.meta_description]] as const) {
    if (norm(v) && nt === norm(v)) add("tldr_duplicates_metadata", `The TL;DR repeats the ${label}; summarize the article's answer instead.`);
  }
  return out;
}

/** The TL;DR as the first paragraph of a body, for sites that do not render the field. */
export function tldrParagraph(tldr: string): string {
  return `**${TLDR_LABEL}:** ${tldr.trim()}`;
}

/** The body a site without a TL;DR slot receives: the summary once, then the article. */
export function bodyWithTldr(body: string, tldr: string | null | undefined): string {
  return tldr?.trim() ? `${tldrParagraph(tldr)}\n\n${body.replace(/^\s+/, "")}` : body;
}
