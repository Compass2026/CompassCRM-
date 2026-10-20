// Citations Phase 1 is behind a server-side flag (Oct 20 2026).
//
// Merging to `main` deploys the CRM to production, but the module's migration
// (20261020230000_citations_foundation.sql) is not applied there and the
// workflow is still in review. So the Citations nav item, client tab, pages,
// export and server actions stay off in every deployment until
// CITATIONS_ENABLED is set to "true" in that deployment's environment
// (docs/citations.md, "Turning it on").
//
// Server-only on purpose, like PORTAL_INVITES_ENABLED: not NEXT_PUBLIC_, so it
// cannot be flipped from the browser. Anything other than the exact string
// "true" means off. No Next.js imports, so tests can run it.

export const CITATIONS_FLAG = "CITATIONS_ENABLED";

export function citationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CITATIONS_FLAG] === "true";
}
