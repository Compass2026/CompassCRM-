// A content draft as Markdown, for Copy / Download (the manual delivery path
// while publishing is by hand). Front matter carries the SEO fields; the
// governed claims stay in the CRM, not in the file.
export function toMarkdown(d: { title: string | null; slug: string | null; meta_title: string | null; meta_description: string | null; h1: string | null;
  body_markdown: string | null; cta: { text?: string; url?: string | null } | null; primary_keyword?: string | null }): string {
  const q = (s: string | null | undefined) => JSON.stringify(s ?? "");
  const front = [
    "---",
    `title: ${q(d.title)}`,
    `slug: ${q(d.slug)}`,
    `meta_title: ${q(d.meta_title)}`,
    `meta_description: ${q(d.meta_description)}`,
    ...(d.primary_keyword ? [`primary_keyword: ${q(d.primary_keyword)}`] : []),
    "---",
  ].join("\n");
  const cta = d.cta?.text ? `\n\n${d.cta.url ? `[${d.cta.text}](${d.cta.url})` : d.cta.text}\n` : "\n";
  return `${front}\n\n# ${d.h1 ?? ""}\n\n${(d.body_markdown ?? "").trim()}${cta}`;
}
