// A content draft as Markdown, for Copy / Download (the manual delivery path
// while publishing is by hand). Front matter carries the SEO fields; the
// governed claims stay in the CRM, not in the file.
export function toMarkdown(d: { title: string | null; slug: string | null; meta_title: string | null; meta_description: string | null; h1: string | null;
  body_markdown: string | null; cta: { text?: string; url?: string | null } | null; primary_keyword?: string | null;
  page_path?: string | null; page_objective?: string | null; page_type?: string | null; page_change?: string | null;
  structured_data?: unknown }): string {
  const q = (s: string | null | undefined) => JSON.stringify(s ?? "");
  const front = [
    "---",
    `title: ${q(d.title)}`,
    `slug: ${q(d.slug)}`,
    `meta_title: ${q(d.meta_title)}`,
    `meta_description: ${q(d.meta_description)}`,
    ...(d.primary_keyword ? [`primary_keyword: ${q(d.primary_keyword)}`] : []),
    ...(d.page_path ? [`url_path: ${q(d.page_path)}`] : []),
    ...(d.page_type ? [`page_type: ${q(d.page_type)}`] : []),
    ...(d.page_change ? [`change: ${q(d.page_change === "page_rewrite" ? "refresh of an existing page" : "new page")}`] : []),
    ...(d.page_objective ? [`objective: ${q(d.page_objective)}`] : []),
    // JSON is valid YAML: the JSON-LD recommendation, ready to paste.
    ...(d.structured_data ? [`structured_data: ${JSON.stringify(d.structured_data)}`] : []),
    "---",
  ].join("\n");
  const cta = d.cta?.text ? `\n\n${d.cta.url ? `[${d.cta.text}](${d.cta.url})` : d.cta.text}\n` : "\n";
  return `${front}\n\n# ${d.h1 ?? ""}\n\n${(d.body_markdown ?? "").trim()}${cta}`;
}
