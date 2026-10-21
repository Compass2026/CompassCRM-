// Citations Phase 1 is behind a server-side flag (Oct 20 2026).
//
// The Citations nav item, client tab, pages, export and server actions are off
// in any deployment where CITATIONS_ENABLED is not "true"; with the flag off,
// the module answers 404 even where its migration
// (20261021160410_citations_foundation.sql) is applied. Production set it at
// the Oct 21 2026 release (docs/citations.md, "Turning it on"). Unset it to take
// the module offline without touching data.
//
// Server-only on purpose, like PORTAL_INVITES_ENABLED: not NEXT_PUBLIC_, so it
// cannot be flipped from the browser. Anything other than the exact string
// "true" means off. No Next.js imports, so tests can run it.

export const CITATIONS_FLAG = "CITATIONS_ENABLED";

export function citationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CITATIONS_FLAG] === "true";
}
