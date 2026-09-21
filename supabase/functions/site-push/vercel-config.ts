// vercel.json — the CRM's single deployment path, enforced in the repo.
//
// Vercel gives a linked project two ways to deploy a commit: its own Git
// integration, and the explicit POST /v13/deployments that site-push makes.
// Both fire on every push. Until Sept 2026 the Git one was invisible because
// Vercel BLOCKED it — the CRM committed as an address belonging to no team
// member. Giving commits a real team member's address (so Vercel stops
// rejecting them) removes that accidental brake, and every push would deploy
// twice. Worse, on a project with no successful deployment Vercel promotes
// the first deployment to production whatever the branch, so a preview-branch
// commit could go live with no guard in front of it — site-push's own
// zero-deployment guard governs only its own path.
//
// The project-level control (`deploymentPolicy.deploymentSources`) is in
// Vercel's API schema but is not provisioned for this team; it answers
// 404 "Deployment Policy not found". The documented repo-level control is
// this file, verified working on Sept 21 2026: a push carrying it produced
// no Git-integration deployment at all, where three prior pushes to the same
// branch each produced one within ~2s.
//
// So every commit site-push makes carries `git.deploymentEnabled: false`.
// See docs/vercel-deployment-paths.md.

export const VERCEL_CONFIG_PATH = "vercel.json";

export interface VercelConfigBuilt {
  ok: true;
  /** The exact file content to commit. */
  content: string;
  /** False when the existing file already had the property set correctly. */
  changed: boolean;
}
export interface VercelConfigRefusal {
  ok: false;
  error: string;
}
export type VercelConfigResult = VercelConfigBuilt | VercelConfigRefusal;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `./vercel.json` and `vercel.json` are the same file. */
export function isVercelConfigPath(path: string): boolean {
  return path.replace(/^\.\//, "") === VERCEL_CONFIG_PATH;
}

/**
 * Merge `git.deploymentEnabled: false` into an existing vercel.json,
 * preserving every other setting — redirects, headers, framework, functions,
 * regions, and any sibling key under `git`.
 *
 * `existing` is null when the repository has no vercel.json yet. Anything
 * that cannot be parsed or cannot be merged without guessing is a refusal,
 * never a silent overwrite: the caller must fail closed before committing.
 */
export function buildVercelConfig(existing: string | null): VercelConfigResult {
  if (existing === null) {
    return { ok: true, content: JSON.stringify({ git: { deploymentEnabled: false } }, null, 2) + "\n", changed: true };
  }
  if (existing.trim() === "") {
    return { ok: false, error: "vercel.json is empty — refusing to guess its contents" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (e) {
    return { ok: false, error: `vercel.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `vercel.json must be a JSON object, found ${Array.isArray(parsed) ? "an array" : typeof parsed}` };
  }
  const git = parsed.git;
  if (git !== undefined && !isPlainObject(git)) {
    return { ok: false, error: `vercel.json "git" must be an object, found ${Array.isArray(git) ? "an array" : typeof git}` };
  }
  const already = isPlainObject(git) && git.deploymentEnabled === false;
  // Key order is preserved: `git` keeps its position when it already exists
  // and is appended when it does not, and every sibling setting is untouched.
  const merged = { ...parsed, git: { ...(isPlainObject(git) ? git : {}), deploymentEnabled: false } };
  return { ok: true, content: JSON.stringify(merged, null, 2) + "\n", changed: !already };
}

export interface RequestFile {
  path: string;
  content: string;
  encoding?: string;
}

/**
 * What the caller is not allowed to do to this file: remove it, or turn the
 * Git integration back on. A caller may still send its own vercel.json — its
 * settings are kept and the property is merged in — but it may not assert
 * the opposite of the property.
 */
export function guardVercelConfigRequest(
  files: RequestFile[],
  deletes: string[],
): { ok: true } | VercelConfigRefusal {
  if (deletes.some(isVercelConfigPath)) {
    return { ok: false, error: "vercel.json may not be deleted — it carries git.deploymentEnabled:false, the CRM's only guard against Vercel's Git integration deploying the same commit a second time" };
  }
  const supplied = files.find((f) => isVercelConfigPath(f.path));
  if (!supplied) return { ok: true };
  let text: string;
  try {
    text = decodeFileContent(supplied);
  } catch (e) {
    return { ok: false, error: `the supplied vercel.json could not be decoded (${e instanceof Error ? e.message : String(e)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `the supplied vercel.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "the supplied vercel.json must be a JSON object" };
  }
  const git = parsed.git;
  if (git !== undefined && !isPlainObject(git)) {
    return { ok: false, error: 'the supplied vercel.json "git" must be an object' };
  }
  if (isPlainObject(git) && git.deploymentEnabled !== undefined && git.deploymentEnabled !== false) {
    return { ok: false, error: "a push may not set git.deploymentEnabled to anything but false — Vercel's Git integration must stay off so site-push's own deployment is the only one" };
  }
  return { ok: true };
}

/** UTF-8 text of a request file, whichever encoding it arrived in. */
export function decodeFileContent(f: RequestFile): string {
  if ((f.encoding ?? "utf-8") !== "base64") return f.content;
  const bin = atob(f.content.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Put the config first and drop any caller copy of it: for an empty
 * repository the first entry becomes the bootstrap commit, so the Git
 * integration is switched off before Vercel can react to anything else.
 */
export function withVercelConfigFirst(files: RequestFile[], content: string): RequestFile[] {
  return [{ path: VERCEL_CONFIG_PATH, content }, ...files.filter((f) => !isVercelConfigPath(f.path))];
}
