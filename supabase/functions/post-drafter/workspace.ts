import type { DrafterInput, SocialAccountRow } from './types.ts';

// The scoped loader adds metadata without changing legacy Intelligence input.
export type WorkspaceInput = DrafterInput & {
  workspace?: { id: string; version: number; facebook_account_id: string | null };
};
export function workspaceGate(input: DrafterInput): Record<string, string> {
  const w = (input as WorkspaceInput).workspace;
  return w ? { brand_workspace_id: w.id, brand_workspace_version: String(w.version) } : {};
}
export function workspaceAccounts(input: DrafterInput, accounts: SocialAccountRow[]): SocialAccountRow[] {
  const w = (input as WorkspaceInput).workspace;
  // A brand site has its own Facebook Page; Business Profile locations are the client's.
  return w ? accounts.filter(a => a.platform === "google_business" || a.id === w.facebook_account_id) : accounts;
}
