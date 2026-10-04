// Twilio implementation of the Communications provider contract, over an
// injected fetch (tests pass a fake; nothing here reaches Twilio on its own).
// REST calls use API keys (Twilio's recommended production auth):
//   * the parent's Main key only for /Accounts and /Keys (subaccount
//     management),
//   * the subaccount's own key for everything about the client.
// The official SDK is used for what it must be used for — webhook signature
// validation (twilio-webhook/index.ts) — and not for REST, which keeps the
// function bundles small and the calls fakeable.
import {
  ProviderError,
  type AvailableNumber,
  type CreatedKey,
  type CreatedSubaccount,
  type MessagingProvider,
  type MessagingService,
  type ParentCredential,
  type ProviderNumber,
  type ProvisioningProvider,
  type Registration,
  type SendResult,
  type Subaccount,
  type SubaccountCredential,
  type SubaccountWithToken,
} from "./provider.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.twilio.com/2010-04-01";
const MESSAGING = "https://messaging.twilio.com/v1";
const TRUSTHUB = "https://trusthub.twilio.com/v1";
const TIMEOUT_MS = 20_000;

type Cred = ParentCredential | SubaccountCredential;
type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : v == null ? null : String(v));

function basic(cred: Cred): string {
  return "Basic " + btoa(`${cred.keySid}:${cred.keySecret}`);
}

// Capabilities come as {voice, SMS, MMS} on available numbers and as
// {voice, sms, mms} on owned numbers.
function caps(c: unknown): { sms: boolean; voice: boolean; mms: boolean } {
  const o = (c ?? {}) as Record<string, unknown>;
  return { sms: !!(o.sms ?? o.SMS), voice: !!(o.voice ?? o.Voice), mms: !!(o.mms ?? o.MMS) };
}

function toSubaccount(j: Json): Subaccount {
  return { sid: String(j.sid), friendlyName: str(j.friendly_name), status: String(j.status ?? "active"), ownerAccountSid: str(j.owner_account_sid) };
}

function toNumber(j: Json): ProviderNumber {
  return { sid: String(j.sid), phoneNumber: String(j.phone_number), friendlyName: str(j.friendly_name), accountSid: String(j.account_sid), ...caps(j.capabilities) };
}

export function createTwilioProvider(fetchImpl: FetchLike): ProvisioningProvider & MessagingProvider {
  async function call(cred: Cred, method: "GET" | "POST", url: string, form?: Record<string, string | undefined>): Promise<Json> {
    const headers: Record<string, string> = { Authorization: basic(cred), Accept: "application/json" };
    let body: string | undefined;
    if (form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) if (v !== undefined) p.set(k, v);
      body = p.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json: Json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      throw new ProviderError(res.status, json.code != null ? String(json.code) : null,
        typeof json.message === "string" ? json.message.slice(0, 300) : `Twilio answered ${res.status}`);
    }
    return json;
  }

  // Every subaccount call names the subaccount, so a key from another
  // account is refused by Twilio rather than acting elsewhere.
  const sub = (c: SubaccountCredential, path: string) => `${API}/Accounts/${c.accountSid}${path}`;

  return {
    async fetchParentAccount(parent: ParentCredential): Promise<Subaccount> {
      return toSubaccount(await call(parent, "GET", `${API}/Accounts/${parent.accountSid}.json`));
    },

    async createSubaccount(parent: ParentCredential, friendlyName: string): Promise<CreatedSubaccount> {
      const j = await call(parent, "POST", `${API}/Accounts.json`, { FriendlyName: friendlyName });
      return { ...toSubaccount(j), authToken: String(j.auth_token ?? "") };
    },

    async fetchSubaccount(parent: ParentCredential, subaccountSid: string): Promise<SubaccountWithToken> {
      const j = await call(parent, "GET", `${API}/Accounts/${subaccountSid}.json`);
      return { ...toSubaccount(j), authToken: str(j.auth_token) };
    },

    async createSubaccountKey(parent: ParentCredential, subaccountSid: string, friendlyName: string): Promise<CreatedKey> {
      const j = await call(parent, "POST", `${API}/Accounts/${subaccountSid}/Keys.json`, { FriendlyName: friendlyName });
      return { sid: String(j.sid), secret: String(j.secret ?? "") };
    },

    async searchTollFree(c: SubaccountCredential, opts: { areaCode?: string; limit: number }): Promise<AvailableNumber[]> {
      const q = new URLSearchParams({ SmsEnabled: "true", VoiceEnabled: "true", PageSize: String(opts.limit) });
      if (opts.areaCode) q.set("AreaCode", opts.areaCode);
      const j = await call(c, "GET", sub(c, `/AvailablePhoneNumbers/US/TollFree.json?${q}`));
      const list = Array.isArray(j.available_phone_numbers) ? (j.available_phone_numbers as Json[]) : [];
      return list.map((n) => ({ phoneNumber: String(n.phone_number), friendlyName: str(n.friendly_name), ...caps(n.capabilities) }));
    },

    async purchaseNumber(c: SubaccountCredential, phoneNumber: string, friendlyName: string): Promise<ProviderNumber> {
      return toNumber(await call(c, "POST", sub(c, "/IncomingPhoneNumbers.json"), { PhoneNumber: phoneNumber, FriendlyName: friendlyName }));
    },

    async fetchNumber(c: SubaccountCredential, numberSid: string): Promise<ProviderNumber> {
      return toNumber(await call(c, "GET", sub(c, `/IncomingPhoneNumbers/${numberSid}.json`)));
    },

    async createMessagingService(c: SubaccountCredential, opts): Promise<MessagingService> {
      const j = await call(c, "POST", `${MESSAGING}/Services`, {
        FriendlyName: opts.friendlyName,
        InboundRequestUrl: opts.inboundUrl,
        InboundMethod: "POST",
        StatusCallback: opts.statusCallbackUrl,
        // The service's webhook, not each number's, receives inbound SMS.
        UseInboundWebhookOnNumber: "false",
      });
      return { sid: String(j.sid), friendlyName: String(j.friendly_name ?? opts.friendlyName) };
    },

    async addNumberToService(c: SubaccountCredential, serviceSid: string, numberSid: string): Promise<void> {
      await call(c, "POST", `${MESSAGING}/Services/${serviceSid}/PhoneNumbers`, { PhoneNumberSid: numberSid });
    },

    async sendMessage(c: SubaccountCredential, opts): Promise<SendResult> {
      const j = await call(c, "POST", sub(c, "/Messages.json"), {
        MessagingServiceSid: opts.messagingServiceSid,
        To: opts.to,
        Body: opts.body,
        StatusCallback: opts.statusCallbackUrl,
      });
      return { sid: String(j.sid), status: String(j.status ?? "queued"), errorCode: str(j.error_code), errorMessage: str(j.error_message) };
    },

    async fetchTollFreeVerification(c: SubaccountCredential, sid: string): Promise<Registration> {
      const j = await call(c, "GET", `${MESSAGING}/Tollfree/Verifications/${sid}`);
      return {
        sid: String(j.sid), rawStatus: str(j.status), rejectionCode: str(j.error_code),
        rejectionReason: str(j.rejection_reason), editAllowed: typeof j.edit_allowed === "boolean" ? j.edit_allowed : null,
        submittedAt: str(j.date_created),
      };
    },

    async fetchCustomerProfile(c: SubaccountCredential, sid: string): Promise<Registration> {
      const j = await call(c, "GET", `${TRUSTHUB}/CustomerProfiles/${sid}`);
      return { sid: String(j.sid), rawStatus: str(j.status), rejectionCode: null, rejectionReason: null, editAllowed: null, submittedAt: str(j.date_created) };
    },
  };
}
