// google-ops — the CRM's hands on Google for the worker: Business Profile,
// GA4 Admin, Gmail drafts. The worker runs in a cloud session with no Google
// login; this function runs in Supabase with one OAuth refresh token for the
// Compass Workspace account and does the writes the worker used to hand to
// Tom as tasks.
//
// Token: GOOGLE_OPS_REFRESH_TOKEN in Vault, minted for the same OAuth app as
// GSC (GSC_CLIENT_ID / GSC_CLIENT_SECRET; GOOGLE_OPS_CLIENT_ID / _SECRET
// override) with these scopes:
//   https://www.googleapis.com/auth/business.manage
//   https://www.googleapis.com/auth/analytics.edit
//   https://www.googleapis.com/auth/gmail.compose
// Without it the function falls back to GSC_REFRESH_TOKEN, which lacks those
// scopes; every op then reports "failed" with Google's 403 and the worker
// leaves the step as Tom's task. Also GA4_ACCOUNT_ID (the numeric GA account
// the client properties are created under).
//
// Auth to this function: a team JWT or the x-cron-secret header.
//
// Body: { client_id, op, ...op fields }. Ops:
//   gbp_locate                       find the client's Business Profile location
//                                    among the accounts the token manages (by
//                                    phone, then name); stores clients.gbp_location
//   gbp_apply    { spec? }           patch categories, description, services,
//                                    hours, website from clients.gbp_spec (body.spec
//                                    is stored first when given). Never the title.
//   gbp_posts    { posts: [{ summary, cta_url? }] }   create local posts
//   gbp_qa       { qa: [{ q, a }] }                   create questions + owner answers
//   ga4_provision { site_url, display_name?, timezone? }
//                                    create a GA4 property + web stream + key
//                                    events phone_click / form_submit; stores
//                                    clients.ga4_property, sites.ga4_measurement_id
//   gmail_draft  { to, subject, text, html? }         create a Gmail draft
//
// Every op answers { op, status: "done" | "skipped" | "failed", detail, ...data }.
// "skipped" = a secret is missing (names it); "failed" = Google said no
// (its message). Nothing here retries, deletes or sends mail.

import { createClient } from "npm:@supabase/supabase-js@2";

const BIZ = "https://mybusinessbusinessinformation.googleapis.com/v1";
const ACCT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";
const QA = "https://mybusinessqanda.googleapis.com/v1";
const GA = "https://analyticsadmin.googleapis.com/v1beta";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";

type Result = Record<string, unknown> & { op: string; status: "done" | "skipped" | "failed"; detail: string };

function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const secret = async (name: string): Promise<string | null> => {
    const { data } = await supabase.rpc("get_secret", { secret_name: name });
    return (data as string | null) || null;
  };

  const cronSecret = await secret("SYNC_CRON_SECRET");
  const isCron =
    req.headers.get("x-cron-secret") && req.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData } = await supabase.auth.getUser(jwt);
    if (!userData?.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const op: string | undefined = body?.op;
  if (!body?.client_id || !op) {
    return Response.json({ error: "client_id and op are required" }, { status: 400 });
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, name, dba, phone, website_url, city, state, gbp_location, gbp_spec, ga4_property")
    .eq("id", body.client_id)
    .single();
  if (clientError || !client) {
    return Response.json({ error: clientError?.message ?? "client not found" }, { status: 404 });
  }

  // ── Google token ────────────────────────────────────────────────────────
  const clientId = (await secret("GOOGLE_OPS_CLIENT_ID")) ?? (await secret("GSC_CLIENT_ID"));
  const clientSecret = (await secret("GOOGLE_OPS_CLIENT_SECRET")) ?? (await secret("GSC_CLIENT_SECRET"));
  const opsToken = await secret("GOOGLE_OPS_REFRESH_TOKEN");
  const refresh = opsToken ?? (await secret("GSC_REFRESH_TOKEN"));
  const skipped = (detail: string): Result => ({ op, status: "skipped", detail });
  const failed = (detail: string, extra: Record<string, unknown> = {}): Result => ({ op, status: "failed", detail, ...extra });
  const done = (detail: string, extra: Record<string, unknown> = {}): Result => ({ op, status: "done", detail, ...extra });

  if (!clientId || !clientSecret || !refresh) {
    return Response.json(
      skipped("Google not configured — set GOOGLE_OPS_REFRESH_TOKEN (scopes business.manage, analytics.edit, gmail.compose) in Vault; GSC_CLIENT_ID / GSC_CLIENT_SECRET are reused."),
      { status: 200 }
    );
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  if (!tokenRes.ok) {
    return Response.json(failed(`Google token refresh failed: ${(await tokenRes.text()).slice(0, 200)}`), { status: 502 });
  }
  const accessToken = (await tokenRes.json()).access_token as string;
  const g = async (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  const gerr = async (step: string, res: Response) =>
    `${step} failed (${res.status}): ${(await res.text()).slice(0, 300)}${!opsToken ? " — GOOGLE_OPS_REFRESH_TOKEN is not set; the GSC token has no Business Profile / Analytics / Gmail scope" : ""}`;

  // ── Business Profile helpers ────────────────────────────────────────────
  // v1 names look like locations/{id}; v4 and posts want accounts/{a}/locations/{id}.
  const locate = async (): Promise<{ account: string; location: string } | Result> => {
    if (client.gbp_location) {
      const [account, location] = String(client.gbp_location).split("/locations/");
      return { account, location: `locations/${location}` };
    }
    const accounts = await g(`${ACCT}/accounts?pageSize=20`);
    if (!accounts.ok) return failed(await gerr("list accounts", accounts));
    const accts: { name: string }[] = (await accounts.json()).accounts ?? [];
    const want = digits(client.phone);
    const names = [client.name, client.dba].filter(Boolean).map((n) => String(n).toLowerCase());
    for (const a of accts) {
      const locs = await g(`${BIZ}/${a.name}/locations?readMask=name,title,phoneNumbers,websiteUri&pageSize=100`);
      if (!locs.ok) continue;
      const list: { name: string; title?: string; phoneNumbers?: { primaryPhone?: string } }[] = (await locs.json()).locations ?? [];
      const hit =
        list.find((l) => want && digits(l.phoneNumbers?.primaryPhone) === want) ??
        list.find((l) => names.some((n) => (l.title ?? "").toLowerCase() === n)) ??
        list.find((l) => names.some((n) => (l.title ?? "").toLowerCase().includes(n)));
      if (hit) {
        const full = `${a.name}/${hit.name}`;
        await supabase.from("clients").update({ gbp_location: full }).eq("id", client.id);
        return { account: a.name, location: hit.name };
      }
    }
    return failed(
      `No Business Profile location for "${client.name}" (phone ${client.phone ?? "unset"}) under the ${accts.length} account(s) this token manages — grant the Compass Google account manager access on the client's profile, then retry.`
    );
  };

  const categoryName = async (displayName: string): Promise<string | null> => {
    const res = await g(
      `${BIZ}/categories?regionCode=US&languageCode=en&view=BASIC&pageSize=20&filter=${encodeURIComponent(`displayName="${displayName}"`)}`
    );
    if (!res.ok) return null;
    const cats: { name: string; displayName: string }[] = (await res.json()).categories ?? [];
    const exact = cats.find((c) => c.displayName.toLowerCase() === displayName.toLowerCase());
    return (exact ?? cats[0])?.name ?? null;
  };

  let result: Result;
  try {
    switch (op) {
      // ── gbp_locate ────────────────────────────────────────────────────
      case "gbp_locate": {
        const loc = await locate();
        result = "op" in loc ? loc : done("Location found and stored on clients.gbp_location.", { location: `${loc.account}/${loc.location}` });
        break;
      }

      // ── gbp_apply ─────────────────────────────────────────────────────
      case "gbp_apply": {
        let spec = body.spec ?? client.gbp_spec;
        if (body.spec) {
          await supabase.from("clients").update({ gbp_spec: body.spec }).eq("id", client.id);
          spec = body.spec;
        }
        if (!spec || typeof spec !== "object") {
          result = failed("No GBP spec on clients.gbp_spec and none in the body.");
          break;
        }
        const loc = await locate();
        if ("op" in loc) { result = loc; break; }

        const patch: Record<string, unknown> = {};
        const mask: string[] = [];
        const applied: string[] = [];
        const unresolved: string[] = [];

        // Categories: display names → gcid names. The primary is required for
        // service items, so it is resolved first.
        if (spec.primary_category) {
          const primary = await categoryName(String(spec.primary_category));
          if (primary) {
            const additional: { name: string }[] = [];
            for (const d of (spec.secondary_categories ?? []) as string[]) {
              const n = await categoryName(d);
              if (n && n !== primary) additional.push({ name: n });
              else if (!n) unresolved.push(`category "${d}"`);
            }
            patch.categories = { primaryCategory: { name: primary }, additionalCategories: additional };
            mask.push("categories");
            applied.push(`categories (${1 + additional.length})`);

            if (Array.isArray(spec.services) && spec.services.length) {
              patch.serviceItems = (spec.services as { name: string; description?: string }[]).slice(0, 50).map((s) => ({
                freeFormServiceItem: {
                  category: primary,
                  label: { displayName: String(s.name).slice(0, 120), description: String(s.description ?? "").slice(0, 300), languageCode: "en" },
                },
              }));
              mask.push("serviceItems");
              applied.push(`services (${spec.services.length})`);
            }
          } else {
            unresolved.push(`primary category "${spec.primary_category}"`);
          }
        }
        if (spec.description) {
          patch.profile = { description: String(spec.description).slice(0, 750) };
          mask.push("profile.description");
          applied.push("description");
        }
        if (spec.website) {
          patch.websiteUri = String(spec.website);
          mask.push("websiteUri");
          applied.push("website");
        }
        // Hours only when the spec marks them confirmed; "confirm" placeholders stay Tom's.
        if (spec.hours_confirmed === true && Array.isArray(spec.hours) && spec.hours.length) {
          const toTime = (s: string) => { const [h, m] = String(s).split(":").map(Number); return { hours: h, minutes: m || 0 }; };
          patch.regularHours = {
            periods: (spec.hours as { day: string; open: string; close: string }[]).map((h) => ({
              openDay: h.day.toUpperCase(), openTime: toTime(h.open), closeDay: h.day.toUpperCase(), closeTime: toTime(h.close),
            })),
          };
          mask.push("regularHours");
          applied.push("hours");
        }
        if (!mask.length) {
          result = failed("Nothing in the spec maps to a Business Profile field.", { unresolved });
          break;
        }
        const res = await g(`${BIZ}/${loc.location}?updateMask=${encodeURIComponent(mask.join(","))}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        if (!res.ok) { result = failed(await gerr("patch location", res), { attempted: applied, unresolved }); break; }
        result = done(`Applied: ${applied.join(", ")}.`, { applied, unresolved, location: `${loc.account}/${loc.location}` });
        break;
      }

      // ── gbp_posts ─────────────────────────────────────────────────────
      case "gbp_posts": {
        const posts = (body.posts ?? []) as { summary: string; cta_url?: string }[];
        if (!posts.length) { result = failed("posts[] is empty."); break; }
        const loc = await locate();
        if ("op" in loc) { result = loc; break; }
        const created: string[] = [];
        const errors: string[] = [];
        for (const p of posts.slice(0, 8)) {
          const res = await g(`${V4}/${loc.account}/${loc.location}/localPosts`, {
            method: "POST",
            body: JSON.stringify({
              languageCode: "en-US",
              topicType: "STANDARD",
              summary: String(p.summary).slice(0, 1500),
              ...(p.cta_url ? { callToAction: { actionType: "LEARN_MORE", url: p.cta_url } } : {}),
            }),
          });
          if (res.ok) created.push((await res.json()).name);
          else errors.push(await gerr("create post", res));
        }
        result = created.length
          ? done(`${created.length} post(s) published${errors.length ? `, ${errors.length} failed` : ""}.`, { created, errors })
          : failed(errors[0] ?? "no posts created", { errors });
        break;
      }

      // ── gbp_qa ────────────────────────────────────────────────────────
      case "gbp_qa": {
        const qa = (body.qa ?? []) as { q: string; a: string }[];
        if (!qa.length) { result = failed("qa[] is empty."); break; }
        const loc = await locate();
        if ("op" in loc) { result = loc; break; }
        const created: string[] = [];
        const errors: string[] = [];
        for (const item of qa.slice(0, 10)) {
          const q = await g(`${QA}/${loc.location}/questions`, { method: "POST", body: JSON.stringify({ text: String(item.q).slice(0, 500) }) });
          if (!q.ok) { errors.push(await gerr("create question", q)); continue; }
          const name = (await q.json()).name as string;
          const a = await g(`${QA}/${name}/answers:upsert`, { method: "PUT", body: JSON.stringify({ answer: { text: String(item.a).slice(0, 1000) } }) });
          if (!a.ok) { errors.push(await gerr("answer question", a)); continue; }
          created.push(name);
        }
        result = created.length
          ? done(`${created.length} Q&A pair(s) posted${errors.length ? `, ${errors.length} failed` : ""}.`, { created, errors })
          : failed(errors[0] ?? "no Q&A created", { errors });
        break;
      }

      // ── ga4_provision ─────────────────────────────────────────────────
      case "ga4_provision": {
        const account = await secret("GA4_ACCOUNT_ID");
        if (!account) { result = skipped("GA4_ACCOUNT_ID is not in Vault — the numeric Analytics account id client properties are created under."); break; }
        const siteUrl: string = body.site_url ?? client.website_url;
        if (!siteUrl) { result = failed("No site_url and the client has no website_url."); break; }

        let property = client.ga4_property as string | null;
        if (!property) {
          const res = await g(`${GA}/properties`, {
            method: "POST",
            body: JSON.stringify({
              displayName: body.display_name ?? client.name,
              parent: `accounts/${String(account).replace(/^accounts\//, "")}`,
              timeZone: body.timezone ?? "America/Chicago",
              currencyCode: "USD",
              industryCategory: "OTHER",
            }),
          });
          if (!res.ok) { result = failed(await gerr("create property", res)); break; }
          property = (await res.json()).name as string;
          await supabase.from("clients").update({ ga4_property: property }).eq("id", client.id);
        }

        // One web stream per property; reuse if it exists.
        let measurementId: string | null = null;
        const streams = await g(`${GA}/${property}/dataStreams?pageSize=50`);
        if (streams.ok) {
          const list: { type: string; webStreamData?: { measurementId?: string } }[] = (await streams.json()).dataStreams ?? [];
          measurementId = list.find((s) => s.type === "WEB_DATA_STREAM")?.webStreamData?.measurementId ?? null;
        }
        if (!measurementId) {
          const res = await g(`${GA}/${property}/dataStreams`, {
            method: "POST",
            body: JSON.stringify({ type: "WEB_DATA_STREAM", displayName: new URL(siteUrl).host, webStreamData: { defaultUri: siteUrl } }),
          });
          if (!res.ok) { result = failed(await gerr("create web stream", res), { property }); break; }
          measurementId = (await res.json()).webStreamData?.measurementId ?? null;
        }

        const keyEvents: string[] = [];
        for (const eventName of ["phone_click", "form_submit"]) {
          const res = await g(`${GA}/${property}/keyEvents`, {
            method: "POST",
            body: JSON.stringify({ eventName, countingMethod: "ONCE_PER_EVENT" }),
          });
          if (res.ok || res.status === 409) keyEvents.push(eventName);
        }

        await supabase.from("sites").update({ ga4_measurement_id: measurementId }).eq("client_id", client.id);
        result = done(`GA4 ready: ${property}, stream ${measurementId ?? "?"}, key events ${keyEvents.join(" + ") || "none"}.`, {
          property, measurement_id: measurementId, key_events: keyEvents,
        });
        break;
      }

      // ── gmail_draft ───────────────────────────────────────────────────
      case "gmail_draft": {
        const to = String(body.to ?? "").trim();
        const subject = String(body.subject ?? "").trim();
        const text = String(body.text ?? "");
        if (!to || !subject || !text) { result = failed("to, subject and text are required."); break; }
        const html = typeof body.html === "string" ? body.html : null;
        const boundary = "compass-" + crypto.randomUUID();
        const mime = html
          ? [
              `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0",
              `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
              `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", text, "",
              `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "", html, "",
              `--${boundary}--`,
            ].join("\r\n")
          : [`To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", text].join("\r\n");
        const res = await g(`${GMAIL}/users/me/drafts`, { method: "POST", body: JSON.stringify({ message: { raw: b64url(mime) } }) });
        if (!res.ok) { result = failed(await gerr("create draft", res)); break; }
        const d = await res.json();
        result = done(`Draft to ${to} saved in Gmail.`, { draft_id: d.id, message_id: d.message?.id, link: "https://mail.google.com/mail/u/0/#drafts" });
        break;
      }

      default:
        return Response.json({ error: `unknown op "${op}"` }, { status: 400 });
    }
  } catch (e) {
    result = failed(e instanceof Error ? e.message : String(e));
  }

  return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
});
