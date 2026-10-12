// External citations use exact sourced URLs, retaining query parameters.
// A source note containing prose or multiple URLs is not a link permission.
export function citationUrl(value: string | null | undefined): string | null {
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
