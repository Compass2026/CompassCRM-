// creative-engine: the Creative Engine function (0054's "Creative Engine
// function"). A factory over an injected store, so tests drive the real
// request boundary with a fake database and storage.
//
//   version   what this deployment renders: renderer id and every template
//             version with its spec hash.
//   register  registers this code's template versions through
//             creative_register_template (immutable; a changed spec must be a
//             new version, which 0054 enforces).
//   plan      dry run: governs, reads and hash-checks the sources, renders,
//             and answers the hashes, overlay and sources. Writes nothing.
//   preview   a client-specific template preview (0054 purpose
//             template_preview): creative_begin_run → render → upload to
//             creative-assets at the content address → creative_write, which
//             proposes (never approves) the template for the client.
//   post      the creative for a draft post (0054 purpose post), from a
//             template version a teammate approved for the client: the post
//             names the service and the claims (post-bindings.ts), photos are
//             the client's approved own work of that service, and
//             creative_write links the image to the post for review.
//
// Callers: the worker (x-cron-secret) or a signed-in teammate (team JWT).
// No caller passes text or pixels: requests name references only, and every
// word and image is resolved from the governed record (govern.ts).
import type { Facts, RenderRequest } from "./govern.ts";
import { RENDERER_ID, RENDERER_VERSION, render, type Engine } from "./render.ts";
import { findTemplate, lucasTemplates } from "./registry.ts";
import { postRefs, type PostFacts } from "./post-bindings.ts";
import { sha256Hex, specHash, type RegisteredTemplate } from "./spec.ts";
import { CopyRefusal } from "./text.ts";

export const MODES = ["version", "register", "plan", "preview", "post"] as const;

export type Store = {
  secret(name: string): Promise<string | null>;
  caller(jwt: string): Promise<"none" | { member: string | null }>;
  facts(clientId: string): Promise<Facts | null>;
  read(storagePath: string): Promise<Uint8Array>;
  template(key: string, version: number): Promise<{ id: string; spec_hash: string; status: string } | null>;
  post(postId: string): Promise<PostFacts | null>;
  clientTemplateStatus(clientId: string, templateId: string): Promise<string | null>;
  registerTemplate(p: Record<string, unknown>): Promise<{ template_id: string; spec_hash: string; registered: boolean }>;
  beginRun(p: Record<string, unknown>): Promise<{ run_id: string; status: string; reused: boolean; creative_asset_id?: string | null }>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  write(p: Record<string, unknown>): Promise<Record<string, unknown>>;
  failRun(p: { run_id: string; error: string }): Promise<void>;
};

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, body: Json) => Response.json(body, { status });
const refused = (e: CopyRefusal) => reply(409, { status: "refused", code: e.code, message: e.message, slot: e.slot ?? null });

export function createCreativeEngine({ store, engine }: { store: Store; engine: () => Promise<Engine> }) {
  async function caller(req: Request): Promise<{ via: "worker" | "team"; member: string | null } | 401 | 403> {
    const cron = await store.secret("SYNC_CRON_SECRET");
    const header = req.headers.get("x-cron-secret");
    if (cron && header && header === cron) return { via: "worker", member: null };
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const who = await store.caller(jwt);
    if (who === "none") return 401;
    if (!who.member) return 403;
    return { via: "team", member: who.member };
  }

  function parseRequest(body: Json): { t: RegisteredTemplate; req: RenderRequest } | Response {
    const tpl = (body.template ?? {}) as Json;
    const key = String(tpl.key ?? "");
    const version = Number(tpl.version);
    const t = findTemplate(key, version);
    if (!t) return reply(404, { status: "refused", code: "template_unknown", message: `No template ${key} v${version} in this deployment` });
    const clientId = String(body.client_id ?? "");
    if (!UUID.test(clientId)) return reply(400, { error: "client_id is required" });
    if (typeof tpl.spec_hash !== "string") return reply(400, { error: "template.spec_hash is required (the version the request was made for)" });
    for (const k of Object.keys(body)) {
      if (!["mode", "client_id", "template", "service_id", "bindings", "photos", "expected_copy_hash", "expected_source_hashes"].includes(k)) {
        return reply(400, { error: `unknown field ${k}: requests carry references only` });
      }
    }
    return {
      t,
      req: {
        template: { key, version, spec_hash: tpl.spec_hash },
        client_id: clientId,
        service_id: (body.service_id as string | null | undefined) ?? null,
        bindings: (body.bindings ?? {}) as RenderRequest["bindings"],
        photos: (body.photos ?? {}) as RenderRequest["photos"],
        expected_copy_hash: body.expected_copy_hash as string | undefined,
        expected_source_hashes: body.expected_source_hashes as Record<string, string> | undefined,
      },
    };
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const who = await caller(req);
    if (who === 401) return reply(401, { error: "unauthorized" });
    if (who === 403) return reply(403, { error: "forbidden: team members only" });
    let body: Json;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "JSON body required" });
    }
    const mode = body?.mode;
    if (!MODES.includes(mode as typeof MODES[number])) return reply(400, { error: `mode must be one of ${MODES.join(", ")}` });

    if (mode === "version") {
      const templates = await Promise.all(lucasTemplates().map(async (t) =>
        ({ key: t.key, version: t.version, channel: t.channel, width: t.output_width, height: t.output_height, spec_hash: await specHash(t.spec) })));
      return reply(200, { renderer: RENDERER_ID, renderer_version: RENDERER_VERSION, modes: MODES, templates });
    }

    if (mode === "register") {
      const wanted = Array.isArray(body.keys) ? (body.keys as string[]) : null;
      const out = [];
      for (const t of lucasTemplates()) {
        if (wanted && !wanted.includes(t.key)) continue;
        const local = await specHash(t.spec);
        const r = await store.registerTemplate({
          key: t.key, version: t.version, channel: t.channel, name: t.name, description: t.description,
          output_width: t.output_width, output_height: t.output_height, mime_type: t.mime_type, spec: t.spec,
        });
        if (r.spec_hash !== local) throw new Error(`spec hash disagreement for ${t.key}: database ${r.spec_hash}, code ${local}`);
        out.push({ key: t.key, version: t.version, template_id: r.template_id, spec_hash: r.spec_hash, registered: r.registered });
      }
      return reply(200, { mode, templates: out });
    }

    if (mode === "post") return await postMode(body, who);

    const parsed = parseRequest(body);
    if (parsed instanceof Response) return parsed;
    const { t, req: rr } = parsed;
    const facts = await store.facts(rr.client_id);
    if (!facts) return reply(404, { status: "refused", code: "client_unknown", message: "No such client" });

    let registered: { id: string; spec_hash: string; status: string } | null = null;
    if (mode === "preview") {
      registered = await store.template(t.key, t.version);
      if (!registered) return reply(409, { status: "refused", code: "template_not_registered", message: `${t.key} v${t.version} is not registered` });
      if (registered.status !== "published") return reply(409, { status: "refused", code: "template_retired", message: "The template version is retired" });
      if (registered.spec_hash !== await specHash(t.spec)) {
        return reply(409, { status: "refused", code: "template_version_mismatch", message: "The registered spec differs from this code's" });
      }
      rr.template.id = registered.id;
    }

    // Everything that can refuse happens before any write.
    let r;
    try {
      r = await render(await engine(), t, facts, rr, (a) => store.read(a.storage_path));
    } catch (e) {
      if (e instanceof CopyRefusal) return refused(e);
      throw e;
    }
    const summary = {
      content_hash: r.content_hash, width: r.width, height: r.height, size_bytes: r.size_bytes,
      brief_hash: r.brief_hash, copy_hash: r.copy_hash, overlay: r.overlay, sources: r.sources, alt_text: r.alt_text,
      renderer: RENDERER_ID, ms: r.ms,
    };
    if (mode === "plan") return reply(200, { mode, writes: false, ...summary });

    const begun = await store.beginRun({
      client_id: rr.client_id, purpose: "template_preview", template_id: registered!.id, strategy: r.strategy,
      reason: "preview", requested_via: who.via, requested_by: who.member, brief: r.brief, brief_hash: r.brief_hash,
      renderer: RENDERER_ID,
    });
    if (begun.reused) {
      if (begun.creative_asset_id) {
        return reply(200, { mode, writes: false, reused: true, run_id: begun.run_id, creative_asset_id: begun.creative_asset_id, ...summary });
      }
      return reply(409, { status: "refused", code: "run_in_progress", message: "The same preview is rendering", run_id: begun.run_id });
    }
    try {
      const path = `${rr.client_id}/${r.content_hash}.png`;
      await store.upload(path, r.png, "image/png");
      const w = await store.write({
        run_id: begun.run_id,
        asset: {
          content_hash: r.content_hash, format: "png", width: r.width, height: r.height, size_bytes: r.size_bytes,
          alt_text: r.alt_text, overlay: r.overlay,
          generation: { renderer: RENDERER_ID, spec_hash: rr.template.spec_hash, copy_hash: r.copy_hash, brief_hash: r.brief_hash },
        },
        sources: r.sources,
      });
      return reply(200, { mode, writes: true, reused: false, run_id: begun.run_id, ...w, ...summary });
    } catch (e) {
      await store.failRun({ run_id: begun.run_id, error: String((e as Error).message ?? e).slice(0, 500) });
      if (e instanceof CopyRefusal) return refused(e);
      return reply(500, { status: "failed", run_id: begun.run_id, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }

  // The creative for one draft post. Every check that can refuse runs before
  // any write; the database repeats the ones that matter (0054).
  async function postMode(body: Json, who: { via: "worker" | "team"; member: string | null }): Promise<Response> {
    for (const k of Object.keys(body)) {
      if (!["mode", "post_id", "template", "reason", "submit"].includes(k)) {
        return reply(400, { error: `unknown field ${k}: a post's creative takes the post and a template only` });
      }
    }
    const postId = String(body.post_id ?? "");
    if (!UUID.test(postId)) return reply(400, { error: "post_id is required" });
    const tpl = (body.template ?? {}) as Json;
    const t = findTemplate(String(tpl.key ?? ""), Number(tpl.version));
    if (!t) return reply(404, { status: "refused", code: "template_unknown", message: `No template ${tpl.key} v${tpl.version} in this deployment` });
    if (typeof tpl.spec_hash !== "string") return reply(400, { error: "template.spec_hash is required (the version the request was made for)" });
    const reason = body.reason === undefined ? "initial" : String(body.reason);
    if (!["initial", "regenerate", "copy_changed", "retry"].includes(reason)) return reply(400, { error: "reason must be initial, regenerate, copy_changed or retry" });

    const post = await store.post(postId);
    if (!post) return reply(404, { status: "refused", code: "post_unknown", message: "No such post" });
    const no = (code: string, message: string) => reply(409, { status: "refused", code, message });
    if (post.review_status !== "draft") return no("post_not_draft", `The post is ${post.review_status.replace("_", " ")}; request new creative first`);
    if (post.creative_policy === "none") return no("creative_policy_none", "The post's creative policy is none; set it to optional or required first");
    if (t.channel !== post.platform) return no("channel_mismatch", `${t.key} is a ${t.channel} template; the post is for ${post.platform}`);

    const registered = await store.template(t.key, t.version);
    if (!registered) return no("template_not_registered", `${t.key} v${t.version} is not registered`);
    if (registered.status !== "published") return no("template_retired", "The template version is retired");
    const localHash = await specHash(t.spec);
    if (registered.spec_hash !== localHash || tpl.spec_hash !== localHash) {
      return no("template_version_mismatch", "The registered spec differs from this code's or from the requested version");
    }
    if (await store.clientTemplateStatus(post.client_id, registered.id) !== "approved") {
      return no("template_not_approved", "This template version is not approved for the client; approve it on its preview first");
    }
    const facts = await store.facts(post.client_id);
    if (!facts) return reply(404, { status: "refused", code: "client_unknown", message: "No such client" });

    const copyHash = await sha256Hex(new TextEncoder().encode(post.copy ?? ""));
    let r;
    try {
      const refs = postRefs(t.spec, facts, post);
      r = await render(await engine(), t, facts,
        { template: { key: t.key, version: t.version, spec_hash: localHash, id: registered.id }, client_id: post.client_id, ...refs },
        (a) => store.read(a.storage_path),
        { post: { id: post.id, copy_hash: copyHash, creative_version: post.creative_version } });
    } catch (e) {
      if (e instanceof CopyRefusal) return refused(e);
      throw e;
    }
    const summary = {
      post_id: post.id, template: { key: t.key, version: t.version }, content_hash: r.content_hash, width: r.width, height: r.height,
      size_bytes: r.size_bytes, brief_hash: r.brief_hash, overlay: r.overlay, sources: r.sources, alt_text: r.alt_text,
      renderer: RENDERER_ID, ms: r.ms,
    };

    const begun = await store.beginRun({
      client_id: post.client_id, purpose: "post", post_id: post.id, template_id: registered.id, strategy: r.strategy,
      reason, requested_via: who.via, requested_by: who.member, copy_hash: copyHash,
      brief: r.brief, brief_hash: r.brief_hash, renderer: RENDERER_ID,
    });
    if (begun.reused) {
      if (begun.creative_asset_id) {
        return reply(200, { mode: "post", writes: false, reused: true, run_id: begun.run_id, creative_asset_id: begun.creative_asset_id, ...summary });
      }
      return reply(409, { status: "refused", code: "run_in_progress", message: "This creative is already rendering", run_id: begun.run_id });
    }
    try {
      await store.upload(`${post.client_id}/${r.content_hash}.png`, r.png, "image/png");
      const w = await store.write({
        run_id: begun.run_id,
        expected_creative_version: post.creative_version,
        asset: {
          content_hash: r.content_hash, format: "png", width: r.width, height: r.height, size_bytes: r.size_bytes,
          alt_text: r.alt_text, overlay: r.overlay,
          generation: { renderer: RENDERER_ID, spec_hash: localHash, copy_hash: r.copy_hash, brief_hash: r.brief_hash, post_copy_hash: copyHash },
        },
        sources: r.sources,
        submit: body.submit === true,
      });
      return reply(200, { mode: "post", writes: true, reused: false, run_id: begun.run_id, ...w, ...summary });
    } catch (e) {
      await store.failRun({ run_id: begun.run_id, error: String((e as Error).message ?? e).slice(0, 500) });
      return reply(500, { status: "failed", run_id: begun.run_id, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }

  return { handle };
}
