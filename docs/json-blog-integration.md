# Standalone JSON blog integration

The `json_blog` adapter supports a site whose articles are rendered from a JSON array, including statically prerendered React/Vite sites. The site must advertise `compass-blog.json` version 1 with Markdown, SEO and keyword provenance support. Its actual loader, routing and prerender pipeline must be inspected before setting its CRM destination.

Only the recorded blog JSON is a push path. City pages, service pages, components, deletions and other files are excluded. Existing human approval, immutable release, expected-head and live-verification checks apply. A trailing-slash route is preserved in the released URL so verification matches the site's canonical.

The website loader validates provenance and slug collisions, renders Markdown without raw HTML execution, uses approved H1 and SEO fields, and emits the release marker. An empty release array is the initial state; adding the integration does not publish review drafts or change the four legacy articles.

Validation: publication adapter and refusal tests, site unit suite, TypeScript and production prerender build. Initial content remains subject to brand and article review. Social account connections are separate.

## TL;DR slot (optional, October 18 2026)

A site may add `"tldr": true` to `compass-blog.json`. Articles then carry a
`tldr` string, which the site renders once, labelled "TL;DR", between the H1
and the hero image (and in its prerendered HTML). A site without the flag
receives the summary as the first paragraph of `bodyMarkdown`
(`**TL;DR:** …`) instead, so nothing renders it twice. Sites that render hero
images need the flag before a release with both is accepted.
