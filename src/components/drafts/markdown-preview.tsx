import { parseMarkdown, type MdInline } from "@/lib/content-drafts";

// Renders a draft's Markdown as text elements (src/lib/content-drafts.ts):
// no HTML passes through, and links are http(s) only.
function Inline({ parts }: { parts: MdInline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === "link" ? <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="underline">{p.v}</a>
          : p.t === "strong" ? <strong key={i}>{p.v}</strong>
          : p.t === "em" ? <em key={i}>{p.v}</em>
          : <span key={i}>{p.v}</span>)}
    </>
  );
}

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere]" data-markdown-preview>
      {parseMarkdown(markdown).map((b, i) => {
        if (!("items" in b)) {
          if (b.t === "h2") return <h2 key={i} className="pt-2 text-base font-semibold"><Inline parts={b.inline} /></h2>;
          if (b.t === "h3") return <h3 key={i} className="pt-1 text-sm font-semibold"><Inline parts={b.inline} /></h3>;
          return <p key={i}><Inline parts={b.inline} /></p>;
        }
        const items = b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>);
        return b.t === "ul" ? <ul key={i} className="list-disc space-y-1 pl-5">{items}</ul> : <ol key={i} className="list-decimal space-y-1 pl-5">{items}</ol>;
      })}
    </div>
  );
}
