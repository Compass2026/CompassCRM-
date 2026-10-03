// Where the Twilio credentials live (Vault, read through get_secret() by the
// service role). Names only; never values.
//
// Parent (Compass's ISV account) — a MAIN API key, created in the Twilio
// Console (only Main keys can reach /Accounts and /Keys):
//   TWILIO_ACCOUNT_SID   AC… of the parent account
//   TWILIO_API_KEY       SK… of the Main key
//   TWILIO_API_SECRET    its secret
// Per client subaccount — written by the communications function when it
// creates or links the subaccount:
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

export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

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

export async function subaccountCredential(secret: SecretReader, accountSid: string): Promise<SubaccountCredential | null> {
  const names = subaccountSecretNames(accountSid);
  const [keySid, keySecret] = await Promise.all([secret(names.keySid), secret(names.keySecret)]);
  if (!keySid || !keySecret) return null;
  return { scope: "subaccount", accountSid, keySid, keySecret };
}

export function webhookBase(override: string | null, supabaseUrl: string): string {
  const base = (override || `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/twilio-webhook`).replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("the webhook base must be https");
  return base;
}

export const INBOUND_PATH = "/messages/inbound";
export const STATUS_PATH = "/messages/status";
