import type { DB } from "../client-mailbox/handler.ts";

export const sid = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(value);

// Provider URLs are constructed here, never taken from callbacks or users.
export async function voiceProvider(db: DB, account: string, request: typeof fetch = fetch) {
  if (!sid(account, "AC")) throw Error("provider_not_ready");
  const r = await db.rpc("communication_subaccount_secrets", { p_account_sid: account });
  if (r.error || !r.data?.api_key || !r.data.api_secret) throw Error("provider_not_ready");
  const authorization = "Basic " + btoa(`${r.data.api_key}:${r.data.api_secret}`);
  async function call(path: string, method = "GET", body?: Record<string, string>, intelligence = false) {
    const root = intelligence ? "https://intelligence.twilio.com/v2" : `https://api.twilio.com/2010-04-01/Accounts/${account}`;
    const response = await request(root + path, {
      method, headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: body ? new URLSearchParams(body) : undefined,
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (method === "DELETE" && response.status === 404) return {};
    if (!response.ok) throw Error(`provider_${response.status}`);
    return response.status === 204 ? {} : response.json();
  }
  return { call, authorization };
}

export const recordingNotice = "This call can be recorded and transcribed to help with your inquiry. Press 1 to agree, or press 2 to continue without recording.";
export const xmlEscape = (value: unknown) => String(value ?? "").replace(/[<>&"']/g,
  c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

export function consentPrompt(action: string) {
  return `<Gather input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="true" action="${xmlEscape(action)}" method="POST"><Say>${recordingNotice}</Say></Gather>`;
}
