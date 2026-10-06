// communications (Compass Communications, 0063): a signed-in teammate's
// door to Twilio. Team JWT only (verify_jwt = true); there is no cron or
// worker path — sending and provisioning are people's actions.
//
//   version                 what this deployment is
//   send                    one SMS to a contact with consent (any teammate)
//   search_numbers          available US toll-free numbers, SMS + voice,
//                           800 first (any teammate; buys nothing)
//   sync_compliance         Twilio's status of the client's registrations
//                           (any teammate; reads Twilio, writes the status)
//   check_parent            is the parent credential a working MAIN key (admin)
//   create_subaccount       a new subaccount for the client (admin, confirm =
//                           the client's name); refused when Twilio already
//                           has one by that name; recorded as soon as Twilio
//                           answers, so a missing Auth Token is a partial
//                           state to finish, never a reason to create again
//   link_subaccount         register an existing subaccount, or finish one
//                           (admin): found in the parent's own Accounts list
//                           (never /Accounts/<sid>.json, which Twilio refuses
//                           to a parent API key with 20404); needs its Auth
//                           Token in Vault
//   create_messaging_service  the client's Messaging Service (admin)
//   purchase_number         buy ONE toll-free number the admin picked (admin,
//                           confirm = the number); never automatic
//   link_number             register a number already in the subaccount (admin)
//   attach_number           put a number in the client's Messaging Service (admin)
//
// Credentials: the parent's Main key only on the parent's own Accounts
// collection (create, list / find a subaccount). Twilio denies a parent API
// key every subaccount resource, so the subaccount's Standard key is minted
// with the subaccount's own Auth Token (Vault), and everything else runs with
// that key. Keys,
// secrets and auth tokens go from Twilio straight to Vault and never appear in
// a response or a log. Twilio returns a subaccount's Auth Token only to Auth
// Token callers, never to an API key, so with Compass's Main key it is copied
// from the Twilio Console into Vault as TWILIO_SUB_<sid>_AUTH_TOKEN; the
// response names that secret exactly. Every database write is a 0063
// function; a subaccount's credentials are read in one call
// (communication_subaccount_secrets, 0065).
//
// Status codes: a Twilio failure is 424 and a missing prerequisite 409 / 412,
// never 5xx — Supabase's gateway replaces a function's 5xx body with its own,
// so the reason (and the secret name to store) would not reach the person.
import {
  isUsTollFree,
  mapCustomerProfileStatus,
  mapTollFreeStatus,
} from "../../../src/lib/communications.ts";
import {
  ACCOUNT_SID,
  API_KEY_SID,
  INBOUND_PATH,
  NUMBER_SID,
  STATUS_PATH,
  parentCredential,
  subaccountCredential,
  subaccountSecretNames,
  type SubaccountSecrets,
} from "../_shared/communications/credentials.ts";
import {
  ProviderError,
  type MessagingProvider,
  type ProvisioningProvider,
  type SubaccountCredential,
  type SubaccountTokenCredential,
} from "../_shared/communications/provider.ts";

export const HANDLER_VERSION = 3;
export const MODES = [
  "version", "send", "search_numbers", "sync_compliance", "check_parent", "create_subaccount", "link_subaccount",
  "create_messaging_service", "purchase_number", "link_number", "attach_number",
] as const;
type Mode = typeof MODES[number];
const ADMIN_MODES: Mode[] = ["check_parent", "create_subaccount", "link_subaccount", "create_messaging_service",
  "purchase_number", "link_number", "attach_number"];

export type Caller = "none" | { member: string | null; role: string | null };
export type AccountRow = { id: string; provider_account_sid: string; status: string };
export type ServiceRow = { id: string; provider_service_sid: string; friendly_name: string; status: string };
export type NumberRow = { id: string; provider_phone_number_sid: string; phone_number_e164: string; messaging_service_id: string | null; status: string };
export type RegistrationRow = { id: string; profile_type: "secondary_customer_profile" | "toll_free_verification"; provider_profile_sid: string | null };

export type Store = {
  secret(name: string): Promise<string | null>;
  subaccountSecrets(accountSid: string): Promise<SubaccountSecrets>;
  setSecret(name: string, value: string): Promise<void>;
  caller(jwt: string): Promise<Caller>;
  client(id: string): Promise<{ id: string; name: string; status: string } | null>;
  settings(clientId: string): Promise<{ enabled: boolean; outbound_enabled: boolean; display_name?: string | null } | null>;
  account(clientId: string): Promise<AccountRow | null>;
  messagingService(clientId: string): Promise<ServiceRow | null>;
  number(clientId: string, numberId: string): Promise<NumberRow | null>;
  registrations(clientId: string): Promise<RegistrationRow[]>;
  rpc(fn: string, p: Record<string, unknown>): Promise<Record<string, unknown>>;
};

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });
const dbCode = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return { code: (m.match(/^([a-z_]+):/) ?? [])[1] ?? "error", detail: m.replace(/^[a-z_]+:\s*/, "").slice(0, 300) };
};
const providerFailure = (e: unknown) =>
  e instanceof ProviderError
    ? { code: "twilio_error", twilio_status: e.status, twilio_code: e.code, detail: e.message }
    : { code: "twilio_unreachable", detail: "Twilio did not answer (timeout or network)" };

export function createCommunications(deps: {
  store: Store;
  provider: ProvisioningProvider & MessagingProvider;
  webhookBase: () => Promise<string>;
  log?: (event: string, detail: Json) => void;
}) {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const parent = () => parentCredential((n) => store.secret(n));
  const subFor = async (accountSid: string) => subaccountCredential(await store.subaccountSecrets(accountSid));
  const sameSid = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  // Mints a Standard key inside the subaccount with the subaccount's own Auth
  // Token (Twilio refuses the parent's API key there) and keeps it in Vault.
  // Without the token there is nothing to mint with: the key waits for it.
  // The secret is never returned.
  async function ensureSubaccountKey(vault: SubaccountSecrets): Promise<"existing" | "created" | "waiting_for_auth_token"> {
    if (subaccountCredential(vault)) return "existing";
    if (!vault.authToken) return "waiting_for_auth_token";
    const tokenCred: SubaccountTokenCredential = { scope: "subaccount_token", accountSid: vault.accountSid, authToken: vault.authToken };
    const key = await provider.createSubaccountKey(tokenCred, "Compass CRM communications");
    if (!API_KEY_SID.test(key.sid) || !key.secret) throw new Error("twilio_key: Twilio's answer had no API key");
    await store.setSecret(vault.names.keySid, key.sid);
    await store.setSecret(vault.names.keySecret, key.secret);
    return "created";
  }

  // What is still missing for a registered subaccount, said so a person can
  // act on it: the exact Vault name for the Auth Token, and any other SIDs
  // Vault holds a token for (a token stored under the wrong SID).
  function missingToken(vault: SubaccountSecrets): Json {
    const others = vault.otherAuthTokenAccounts;
    return {
      auth_token: "missing",
      auth_token_secret: vault.names.authToken,
      other_auth_token_accounts: others,
      detail: `Twilio does not return a subaccount's Auth Token to an API key. Copy it from the Twilio Console (subaccount ${vault.accountSid}) into Vault as ${vault.names.authToken}, then use “Store the subaccount's key and token again”.`
        + (others.length ? ` Vault holds an Auth Token for ${others.join(", ")} instead — check that SID is this client's subaccount.` : ""),
    };
  }

  // After the subaccount is registered: the key (minted if missing) and the
  // Auth Token (Vault). 200 when both are in place, else 207 saying what is
  // left; the registration stays either way.
  async function finishSubaccount(accountSid: string, extra: Json): Promise<Response> {
    let vault = await store.subaccountSecrets(accountSid);
    let key: "existing" | "created" | "waiting_for_auth_token" | "missing";
    let keyFailure: Json = {};
    try {
      key = await ensureSubaccountKey(vault);
      vault = await store.subaccountSecrets(accountSid);
    } catch (e) {
      key = "missing";
      keyFailure = e instanceof ProviderError ? providerFailure(e) : { key_error: dbCode(e).code };
    }
    const tokenStored = !!vault.authToken;
    const body: Json = { account_sid: accountSid, ...extra, key, auth_token: tokenStored ? "stored in Vault" : "missing",
      auth_token_secret: vault.names.authToken };
    if ((key === "existing" || key === "created") && tokenStored) return reply(200, body);
    const parts: Json = { ...body, ...(tokenStored ? {} : missingToken(vault)), ...keyFailure, next: "link_subaccount" };
    if (key === "missing") {
      parts.detail = `The subaccount's API key could not be created${keyFailure.twilio_code ? ` (Twilio ${String(keyFailure.twilio_code)})` : ""}.`
        + (tokenStored ? "" : ` ${String(missingToken(vault).detail)}`);
    }
    return reply(207, parts);
  }

  // Unexpected errors answer 500 with no detail (it could name a row or a
  // secret); the log has the code.
  async function handle(req: Request): Promise<Response> {
    try {
      return await route(req);
    } catch (e) {
      const code = dbCode(e).code;
      log("error", { code });
      // A failed Vault read is said as such (424: the gateway would replace a
      // 5xx body), never as a credential to go and store.
      if (code === "vault_read") return reply(424, { code, error: "Compass could not read its credentials from Vault just now. Try again; if it persists, check the function's logs." });
      return reply(500, { error: "internal error" });
    }
  }

  async function route(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who === "none") return reply(401, { error: "unauthorized" });
    if (!who.member) return reply(403, { error: "forbidden: Compass team only" });

    const body = (await req.json().catch(() => null)) as Json | null;
    const mode = body?.mode as Mode;
    if (!MODES.includes(mode)) return reply(400, { error: `mode must be one of ${MODES.join(", ")}` });
    if (mode === "version") return reply(200, { version: HANDLER_VERSION, modes: MODES, admin_modes: ADMIN_MODES });
    if (ADMIN_MODES.includes(mode) && who.role !== "admin") {
      return reply(403, { error: "forbidden: a Compass admin does this", code: "admin_only" });
    }

    if (mode === "check_parent") {
      const p = await parent();
      if (!p) return reply(200, { configured: false, main_key: false, missing: ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET"] });
      try {
        const acct = await provider.fetchParentAccount(p);
        return reply(200, { configured: true, main_key: true, account_status: acct.status, account_sid: p.accountSid });
      } catch (e) {
        // A Standard key cannot read /Accounts: Twilio answers 401 / 403.
        if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
          return reply(200, { configured: true, main_key: false, account_sid: p.accountSid,
            detail: "Twilio refused the parent key on /Accounts. Subaccount management needs a Main API key (created in the Twilio Console)." });
        }
        return reply(424, providerFailure(e));
      }
    }

    const clientId = String(body?.client_id ?? "");
    if (!UUID.test(clientId)) return reply(400, { error: "client_id is required" });
    const client = await store.client(clientId);
    if (!client) return reply(404, { error: "no such client" });

    if (mode === "send") return send(clientId, who.member, body!);

    const settings = await store.settings(clientId);
    if (!settings?.enabled) return reply(409, { code: "not_enabled", error: "Turn communications on for this client first (Settings)." });
    const account = await store.account(clientId);

    if (mode === "create_subaccount" || mode === "link_subaccount") {
      const p = await parent();
      if (!p) return reply(412, { code: "parent_not_configured", error: "The parent Twilio Main key is not in Vault (TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET)." });

      if (mode === "create_subaccount") {
        if (account) return reply(409, { code: "account_exists", account_sid: account.provider_account_sid,
          error: `This client already has subaccount ${account.provider_account_sid}. Use “Store the subaccount's key and token again” to finish it.` });
        if (String(body?.confirm ?? "") !== client.name) {
          return reply(400, { code: "confirm", error: "Type the client's name exactly to create its Twilio subaccount." });
        }
        const friendly = `Compass - ${client.name}`;
        // Never a second subaccount for the client: a creation whose answer
        // was lost, or one made in the Console, is linked instead.
        let existing;
        try {
          existing = (await provider.listSubaccounts(p, friendly))
            .filter((a) => !sameSid(a.sid, p.accountSid) && a.status !== "closed" && (!a.ownerAccountSid || sameSid(a.ownerAccountSid, p.accountSid)));
        } catch (e) {
          return reply(424, providerFailure(e));
        }
        if (existing.length) {
          const sids = existing.map((a) => a.sid);
          return reply(409, { code: "subaccount_exists_in_twilio", account_sids: sids,
            error: `Twilio already has a subaccount named “${friendly}” (${sids.join(", ")}). Link it instead of creating another.` });
        }
        let created;
        try {
          created = await provider.createSubaccount(p, friendly);
        } catch (e) {
          return reply(424, { ...providerFailure(e), next: "Check the Twilio Console for a new subaccount before trying again; link it if it exists." });
        }
        if (!ACCOUNT_SID.test(created.sid)) {
          return reply(424, { code: "twilio_error", detail: "Twilio's answer named no subaccount SID. Check the Twilio Console before trying again; link the subaccount if it exists." });
        }
        // Recorded at once: from here the client has its subaccount, whatever
        // is still missing.
        await store.rpc("communication_register_account", { client_id: clientId, account_sid: created.sid,
          friendly_name: created.friendlyName, status: created.status, created_by: who.member });
        log("subaccount_created", { client: clientId, account: created.sid, auth_token_returned: !!created.authToken });
        if (created.authToken) await store.setSecret(subaccountSecretNames(created.sid).authToken, created.authToken);
        return finishSubaccount(created.sid, { created: true });
      }

      const typed = String(body?.account_sid ?? "").trim();
      if (!ACCOUNT_SID.test(typed)) return reply(400, { error: "account_sid must be a Twilio account SID (AC…)" });
      if (account && !sameSid(account.provider_account_sid, typed)) return reply(409, { code: "account_exists", account_sid: account.provider_account_sid });
      if (sameSid(typed, p.accountSid)) {
        return reply(409, { code: "not_a_subaccount", error: "That is Compass's parent account, not a client's subaccount." });
      }
      // Found in the parent's own Accounts list, never fetched directly:
      // Twilio answers 20404 to a parent API key on /Accounts/<sub>.json.
      let sub;
      try {
        sub = await provider.findSubaccount(p, typed);
      } catch (e) {
        return reply(424, providerFailure(e));
      }
      if (!sub) {
        return reply(409, { code: "not_in_parent", account_sid: typed,
          error: `Twilio's list of Compass's subaccounts (parent ${p.accountSid}) has no ${typed}. Check the SID in the Twilio Console; only a subaccount of Compass's parent account can be linked.` });
      }
      if (!sameSid(sub.ownerAccountSid, p.accountSid)) {
        return reply(409, { code: "not_a_subaccount", error: "That account is not a subaccount of Compass's parent account." });
      }
      if (sub.status === "closed") {
        return reply(409, { code: "subaccount_closed", account_sid: sub.sid, error: `Subaccount ${sub.sid} is closed in Twilio; a closed subaccount cannot be linked.` });
      }
      // Twilio's own spelling of the SID names the registry row and the Vault
      // secrets; a link typed in another letter case finds the same ones.
      const sid = account?.provider_account_sid ?? (ACCOUNT_SID.test(sub.sid) ? sub.sid : typed);
      const vault = await store.subaccountSecrets(sid);
      if (!vault.authToken) {
        // Nothing is registered without the token that validates the
        // subaccount's webhooks; the answer names the secret to store.
        log("auth_token_missing", { client: clientId, account: sid, others: vault.otherAuthTokenAccounts.length });
        const m = missingToken(vault);
        return reply(409, { code: "auth_token_missing", account_sid: sid, ...m, error: m.detail });
      }
      if (vault.authTokenFoundAs && vault.authTokenFoundAs !== vault.names.authToken) {
        log("auth_token_found_as", { account: sid, found_as: vault.authTokenFoundAs });
      }
      if (!account) {
        try {
          await store.rpc("communication_register_account", { client_id: clientId, account_sid: sid,
            friendly_name: sub.friendlyName, status: sub.status, created_by: who.member });
        } catch (e) {
          return reply(409, dbCode(e));
        }
      }
      return finishSubaccount(sid, { status: sub.status });
    }

    // Everything below runs with the client's own subaccount key.
    if (!account) return reply(409, { code: "no_account", error: "This client has no Twilio subaccount yet." });
    const sub = await subFor(account.provider_account_sid);
    if (!sub) return reply(412, { code: "subaccount_key_missing", error: "The subaccount's API key is not in Vault; run Link subaccount again." });

    switch (mode) {
      case "create_messaging_service": return createService(clientId, settings.display_name || client.name, sub, body!);
      case "search_numbers": return searchNumbers(sub, body!);
      case "purchase_number": return purchase(clientId, client.name, sub, body!);
      case "link_number": return linkNumber(clientId, sub, body!);
      case "attach_number": return attachNumber(clientId, sub, body!);
      case "sync_compliance": return syncCompliance(clientId, sub);
    }
    return reply(400, { error: "unsupported mode" });
  }

  // Named "<display name> Messaging" (the client's Communications display
  // name, else its name) unless the admin names it.
  async function createService(clientId: string, clientName: string, sub: SubaccountCredential, body: Json): Promise<Response> {
    const existing = await store.messagingService(clientId);
    if (existing) return reply(409, { code: "service_exists", messaging_service_sid: existing.provider_service_sid });
    const friendlyName = String(body.friendly_name ?? "").trim() || `${clientName} Messaging`;
    const useCase = String(body.use_case ?? "customer_care").trim() || "customer_care";
    const base = await deps.webhookBase();
    let svc;
    try {
      svc = await provider.createMessagingService(sub, {
        friendlyName, useCase, inboundUrl: base + INBOUND_PATH, statusCallbackUrl: base + STATUS_PATH,
      });
    } catch (e) {
      return reply(424, providerFailure(e));
    }
    await store.rpc("communication_register_messaging_service", { client_id: clientId, service_sid: svc.sid,
      friendly_name: svc.friendlyName, use_case: useCase });
    return reply(200, { messaging_service_sid: svc.sid, friendly_name: svc.friendlyName, inbound_url: base + INBOUND_PATH });
  }

  async function searchNumbers(sub: SubaccountCredential, body: Json): Promise<Response> {
    const limit = 20;
    const prefer = String(body.area_code ?? "800");
    try {
      const preferred = /^8[0-9]{2}$/.test(prefer) ? await provider.searchTollFree(sub, { areaCode: prefer, limit }) : [];
      const others = preferred.length >= limit ? [] : await provider.searchTollFree(sub, { limit });
      const seen = new Set<string>();
      const numbers = [...preferred, ...others]
        .filter((n) => n.sms && n.voice && isUsTollFree(n.phoneNumber) && !seen.has(n.phoneNumber) && seen.add(n.phoneNumber))
        .slice(0, limit)
        .map((n) => ({ phone_number: n.phoneNumber, friendly_name: n.friendlyName, sms: n.sms, voice: n.voice, mms: n.mms,
          preferred_prefix: n.phoneNumber.startsWith(`+1${prefer}`) }));
      return reply(200, { numbers, preferred_prefix: prefer, purchased: false });
    } catch (e) {
      return reply(424, providerFailure(e));
    }
  }

  async function purchase(clientId: string, clientName: string, sub: SubaccountCredential, body: Json): Promise<Response> {
    const phone = String(body.phone_number ?? "");
    if (!isUsTollFree(phone)) return reply(400, { error: "phone_number must be a US toll-free number in E.164 (+18…)" });
    if (String(body.confirm ?? "") !== phone) {
      return reply(400, { code: "confirm", error: "Confirm the purchase by sending the exact number again." });
    }
    let bought;
    try {
      bought = await provider.purchaseNumber(sub, phone, `${clientName} toll-free`);
    } catch (e) {
      return reply(424, providerFailure(e));
    }
    log("number_purchased", { client: clientId, number: bought.sid });
    await store.rpc("communication_register_number", { client_id: clientId, number_sid: bought.sid, phone_number: bought.phoneNumber,
      friendly_name: bought.friendlyName, number_type: "toll_free", voice: bought.voice, sms: bought.sms, mms: bought.mms,
      purchased_at: new Date().toISOString() });
    const attached = await attachTo(clientId, sub, bought.sid, bought.phoneNumber);
    return reply(200, { number_sid: bought.sid, phone_number: bought.phoneNumber, ...attached });
  }

  async function attachTo(clientId: string, sub: SubaccountCredential, numberSid: string, phone: string): Promise<Json> {
    const svc = await store.messagingService(clientId);
    if (!svc) return { messaging_service: "none yet" };
    try {
      await provider.addNumberToService(sub, svc.provider_service_sid, numberSid);
    } catch (e) {
      // Twilio's 21710: the number is already in this service.
      if (!(e instanceof ProviderError && e.code === "21710")) return { messaging_service: "not attached", ...providerFailure(e) };
    }
    await store.rpc("communication_register_number", { client_id: clientId, number_sid: numberSid, phone_number: phone,
      messaging_service_sid: svc.provider_service_sid });
    return { messaging_service: svc.provider_service_sid };
  }

  async function linkNumber(clientId: string, sub: SubaccountCredential, body: Json): Promise<Response> {
    const sid = String(body.number_sid ?? "");
    if (!NUMBER_SID.test(sid)) return reply(400, { error: "number_sid must be a Twilio phone number SID (PN…)" });
    let n;
    try {
      n = await provider.fetchNumber(sub, sid);
    } catch (e) {
      return reply(424, providerFailure(e));
    }
    if (n.accountSid !== sub.accountSid) return reply(409, { code: "wrong_account", error: "That number is not in this client's subaccount." });
    try {
      await store.rpc("communication_register_number", { client_id: clientId, number_sid: n.sid, phone_number: n.phoneNumber,
        friendly_name: n.friendlyName, number_type: isUsTollFree(n.phoneNumber) ? "toll_free" : "local",
        voice: n.voice, sms: n.sms, mms: n.mms });
    } catch (e) {
      return reply(409, dbCode(e));
    }
    return reply(200, { number_sid: n.sid, phone_number: n.phoneNumber, ...(await attachTo(clientId, sub, n.sid, n.phoneNumber)) });
  }

  async function attachNumber(clientId: string, sub: SubaccountCredential, body: Json): Promise<Response> {
    const id = String(body.number_id ?? "");
    if (!UUID.test(id)) return reply(400, { error: "number_id is required" });
    const n = await store.number(clientId, id);
    if (!n) return reply(404, { error: "no such number for this client" });
    return reply(200, { number_sid: n.provider_phone_number_sid, ...(await attachTo(clientId, sub, n.provider_phone_number_sid, n.phone_number_e164)) });
  }

  async function syncCompliance(clientId: string, sub: SubaccountCredential): Promise<Response> {
    const results: Json[] = [];
    for (const r of await store.registrations(clientId)) {
      if (!r.provider_profile_sid) { results.push({ profile_id: r.id, result: "not_linked" }); continue; }
      try {
        const reg = r.profile_type === "toll_free_verification"
          ? await provider.fetchTollFreeVerification(sub, r.provider_profile_sid)
          : await provider.fetchCustomerProfile(sub, r.provider_profile_sid);
        const status = r.profile_type === "toll_free_verification" ? mapTollFreeStatus(reg.rawStatus) : mapCustomerProfileStatus(reg.rawStatus);
        await store.rpc("communication_record_compliance_sync", {
          profile_id: r.id, provider_profile_sid: r.provider_profile_sid, provider_status: reg.rawStatus, status,
          submitted_at: reg.submittedAt, rejection_code: reg.rejectionCode, rejection_reason: reg.rejectionReason,
          edit_allowed: reg.editAllowed,
        });
        results.push({ profile_id: r.id, result: "synced", provider_status: reg.rawStatus, status });
      } catch (e) {
        results.push({ profile_id: r.id, result: "failed", ...(e instanceof ProviderError ? providerFailure(e) : dbCode(e)) });
      }
    }
    return reply(200, { results });
  }

  // Outbound: every rule in communication_begin_outbound (consent under a
  // lock), then Twilio with the subaccount's key, then what Twilio answered.
  // A retried request_id never sends twice. If Twilio's answer is lost the
  // message stays pending and the status callback (?m=<id>) settles it.
  async function send(clientId: string, member: string, body: Json): Promise<Response> {
    const requestId = String(body.request_id ?? "");
    if (!UUID.test(requestId)) return reply(400, { error: "request_id (uuid) is required" });
    let begun: Json;
    try {
      begun = await store.rpc("communication_begin_outbound", {
        request_id: requestId, client_id: clientId, sent_by: member,
        conversation_id: body.conversation_id ?? null, contact_id: body.contact_id ?? null, number_id: body.number_id ?? null,
        body: typeof body.body === "string" ? body.body : "",
      });
    } catch (e) {
      const r = dbCode(e);
      return reply(r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : 409, r);
    }
    const messageId = String(begun.message_id);
    if (begun.duplicate === true) {
      return reply(200, { message_id: messageId, conversation_id: begun.conversation_id, status: begun.provider_status, duplicate: true });
    }
    const accountSid = String(begun.account_sid);
    const sub = await subFor(accountSid);
    if (!sub) {
      await store.rpc("communication_mark_sent", { message_id: messageId, error_code: "compass_no_credentials",
        error_message: "The subaccount's API key is not in Vault" });
      return reply(412, { code: "subaccount_key_missing", message_id: messageId, status: "failed" });
    }
    const base = await deps.webhookBase();
    try {
      const sent = await provider.sendMessage(sub, {
        messagingServiceSid: String(begun.messaging_service_sid), to: String(begun.to), body: String(begun.body),
        statusCallbackUrl: `${base}${STATUS_PATH}?m=${messageId}`,
      });
      try {
        await store.rpc("communication_mark_sent", { message_id: messageId, provider_message_sid: sent.sid,
          provider_status: sent.status, error_code: sent.errorCode, error_message: sent.errorMessage });
      } catch {
        return reply(202, { message_id: messageId, conversation_id: begun.conversation_id, status: "uncertain",
          detail: "Twilio accepted the message; its status will arrive by callback." });
      }
      log("sent", { client: clientId, message: sent.sid, status: sent.status });
      return reply(200, { message_id: messageId, conversation_id: begun.conversation_id, status: sent.status, provider_message_sid: sent.sid });
    } catch (e) {
      if (e instanceof ProviderError && e.status >= 400 && e.status < 500) {
        await store.rpc("communication_mark_sent", { message_id: messageId, error_code: e.code ?? String(e.status), error_message: e.message });
        log("send_refused", { client: clientId, message_id: messageId, twilio_code: e.code });
        return reply(200, { message_id: messageId, conversation_id: begun.conversation_id, status: "failed",
          error_code: e.code, error: e.message });
      }
      // 5xx, timeout, network: Twilio may or may not have taken it.
      log("send_uncertain", { client: clientId, message_id: messageId });
      return reply(202, { message_id: messageId, conversation_id: begun.conversation_id, status: "uncertain",
        detail: "Twilio did not confirm; the message stays pending until its status callback arrives." });
    }
  }

  return { handle };
}
