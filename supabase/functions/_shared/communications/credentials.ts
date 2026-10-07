// Where the Twilio credentials live (Vault, read through get_secret() by the
// service role). Names only; never values.
//
// Parent (Compass's ISV account) — a MAIN API key, created in the Twilio
// Console (only Main keys can reach /Accounts and /Keys):
//   TWILIO_ACCOUNT_SID   AC… of the parent account
//   TWILIO_API_KEY       SK… of the Main key
//   TWILIO_API_SECRET    its secret
// Per client subaccount — the key written by the communications function
// when it creates or links the subaccount; the Auth Token written by it only
// when Twilio returns one (Twilio does not return Auth Tokens to API-key
// callers, so it is normally copied from the Twilio Console into Vault):
//   TWILIO_SUB_<AC…>_API_KEY     a Standard key created IN the subaccount
//   TWILIO_SUB_<AC…>_API_SECRET  its secret
//   TWILIO_SUB_<AC…>_AUTH_TOKEN  the subaccount's Auth Token: Twilio signs the
//                                subaccount's webhooks with it, so
//                                twilio-webhook needs it to validate them.
// Optional:
//   TWILIO_WEBHOOK_BASE_URL      public base of twilio-webhook when it is not
//                                <SUPABASE_URL>/functions/v1/twilio-webhook.
import type { ParentCredential, SubaccountCredential } from "./provider.ts";

export const PARENT_SECRETS = {
  accountSid: "TWILIO_ACCOUNT_SID",
  keySid: "TWILIO_API_KEY",
  keySecret: "TWILIO_API_SECRET",
} as const;

// Twilio SIDs: two letters and 32 hex digits, which Twilio documents as
// [0-9a-fA-F] (in practice lower case; both are accepted everywhere).
export const twilioSid = (prefix: string) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);
export const ACCOUNT_SID = twilioSid("AC");
export const API_KEY_SID = twilioSid("SK");
export const NUMBER_SID = twilioSid("PN");
export const SERVICE_SID = twilioSid("MG");
export const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;

export function subaccountSecretNames(accountSid: string) {
  if (!ACCOUNT_SID.test(accountSid)) throw new Error("not a Twilio account SID");
  return {
    keySid: `TWILIO_SUB_${accountSid}_API_KEY`,
    keySecret: `TWILIO_SUB_${accountSid}_API_SECRET`,
    authToken: `TWILIO_SUB_${accountSid}_AUTH_TOKEN`,
  };
}

type SecretReader = (name: string) => Promise<string | null>;

export async function parentCredential(secret: SecretReader): Promise<ParentCredential | null> {
  const [accountSid, keySid, keySecret] = await Promise.all([
    secret(PARENT_SECRETS.accountSid), secret(PARENT_SECRETS.keySid), secret(PARENT_SECRETS.keySecret),
  ]);
  if (!accountSid || !keySid || !keySecret) return null;
  return { scope: "parent", accountSid, keySid, keySecret };
}

// A subaccount's three credentials as one Vault read returns them
// (communication_subaccount_secrets, 0065): each value, the exact name it
// belongs under, and the name it was found under (the same name, or the one
// name that differs only in the SID's letter case). Values never leave the
// function that reads them.
export type SubaccountSecrets = {
  accountSid: string;
  keySid: string | null;
  keySecret: string | null;
  authToken: string | null;
  names: { keySid: string; keySecret: string; authToken: string };
  authTokenFoundAs: string | null;
  // Other subaccount SIDs Vault holds an Auth Token for: how a token stored
  // under the wrong SID is spotted. SIDs only.
  otherAuthTokenAccounts: string[];
};

export function subaccountCredential(s: SubaccountSecrets): SubaccountCredential | null {
  if (!s.keySid || !s.keySecret) return null;
  return { scope: "subaccount", accountSid: s.accountSid, keySid: s.keySid, keySecret: s.keySecret };
}

export function webhookBase(override: string | null, supabaseUrl: string): string {
  const base = (override || `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/twilio-webhook`).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("the webhook base must be https");
  return base;
}

export const INBOUND_PATH = "/messages/inbound";
export const STATUS_PATH = "/messages/status";
