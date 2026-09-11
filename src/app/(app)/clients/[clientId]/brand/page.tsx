import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isImage, isLightColor, loadBrandBoard } from "@/lib/brand";
import {
  addAssetLinkAction,
  addColorAction,
  addFontAction,
  approveBrandBoardAction,
  deleteAssetAction,
  deleteColorAction,
  deleteFontAction,
  publishBrandBoardAction,
  reopenBrandBoardAction,
  setPrimaryAssetAction,
  updateAssetAction,
  updateColorAction,
  upsertBrandAction,
} from "@/app/brand-actions";
import { BrandBoard } from "@/components/brand-board";
import { BrandAssetUploader } from "@/components/brand-asset-uploader";
import { BrandScanButton } from "@/components/brand-scan-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  brandAssetKindLabels,
  brandAssetKinds,
  brandColorRoleLabels,
  brandColorRoles,
  brandFontRoleLabels,
  brandFontRoles,
  ownerLabels,
} from "@/lib/labels";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs";

export default async function BrandPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const data = await loadBrandBoard(supabase, clientId);
  if (!data) notFound();

  const { client, brand, colors, fonts, assets, task } = data;
  const approved = !!brand.approved_at;

  const saveIdentity = upsertBrandAction.bind(null, clientId);
  const addColor = addColorAction.bind(null, clientId);
  const addFont = addFontAction.bind(null, clientId);
  const addLink = addAssetLinkAction.bind(null, clientId);
  const approve = approveBrandBoardAction.bind(null, clientId);
  const reopen = reopenBrandBoardAction.bind(null, clientId);
  const publish = publishBrandBoardAction.bind(null, clientId);

  return (
    <div className="space-y-6">
      {/* ── Status & actions ─────────────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                approved
                  ? "bg-green-100 text-green-800 border-green-200"
                  : "bg-amber-100 text-amber-800 border-amber-200"
              }
            >
              {approved ? "Approved" : "Draft"}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {approved
                ? `by ${brand.approved_by ?? "team"} on ${brand.approved_at!.slice(0, 10)}`
                : task
                  ? `"Build brand board" · ${ownerLabels[task.owner]} · ${task.status}`
                  : "No brand-board task on file"}
            </span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <a
              href={`/clients/${clientId}/brand-board`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted"
            >
              Printable board ↗
            </a>
            <form action={publish}>
              <Button type="submit" variant="outline">
                Publish snapshot to Documents
              </Button>
            </form>
            {approved ? (
              <form action={reopen}>
                <Button type="submit" variant="ghost">
                  Reopen
                </Button>
              </form>
            ) : (
              <form action={approve}>
                <Button type="submit">Approve brand board</Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── The board ────────────────────────────────────────────────── */}
      <BrandBoard data={data} showEmptyHints />

      {/* ── Editing ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Get a head start</CardTitle>
            <CardDescription>
              Pull colors, fonts, the logo and the share image from the client&apos;s
              live website. Everything lands on the board tagged &quot;found on
              website&quot; for you to rename, assign roles, or delete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BrandScanButton clientId={clientId} websiteUrl={client.website_url} />
          </CardContent>
        </Card>

        {/* Identity */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Identity, voice &amp; messaging</CardTitle>
            <CardDescription>
              This is what AI reads before writing anything for this client — be
              specific.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={saveIdentity} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="tagline">Tagline</Label>
                <Input id="tagline" name="tagline" defaultValue={brand.tagline ?? ""} placeholder="Short line under the logo" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="positioning">Positioning</Label>
                <Textarea id="positioning" name="positioning" rows={3} defaultValue={brand.positioning ?? ""} placeholder="What we do, for whom, and why us — one or two sentences" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="audience">Audience</Label>
                <Textarea id="audience" name="audience" rows={3} defaultValue={brand.audience ?? ""} placeholder="Who we're talking to: homeowners in mid-Missouri, property managers…" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="differentiators">Why choose us</Label>
                <Textarea id="differentiators" name="differentiators" rows={3} defaultValue={brand.differentiators ?? ""} placeholder="Proof points, guarantees, credentials, years in business" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="voice_tone">Voice &amp; tone</Label>
                <Textarea id="voice_tone" name="voice_tone" rows={3} defaultValue={brand.voice_tone ?? ""} placeholder="e.g. Plain-spoken, confident, neighborly. Never salesy." />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="story">Brand story</Label>
                <Textarea id="story" name="story" rows={4} defaultValue={brand.story ?? ""} placeholder="Origin, values, what the owner cares about" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="content_pillars">Content pillars (one per line)</Label>
                <Textarea id="content_pillars" name="content_pillars" rows={4} defaultValue={brand.content_pillars.join("\n")} placeholder={"Project showcases\nHomeowner tips\nBehind the scenes"} />
              </div>
              <div className="grid gap-3">
                <div className="space-y-1">
                  <Label htmlFor="words_we_use">Words we use (one per line)</Label>
                  <Textarea id="words_we_use" name="words_we_use" rows={2} defaultValue={brand.words_we_use.join("\n")} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="words_we_avoid">Words we avoid (one per line)</Label>
                  <Textarea id="words_we_avoid" name="words_we_avoid" rows={2} defaultValue={brand.words_we_avoid.join("\n")} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="imagery_style">Imagery style</Label>
                <Textarea id="imagery_style" name="imagery_style" rows={3} defaultValue={brand.imagery_style ?? ""} placeholder="Real job-site photos, natural light, no stock; people over products…" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="typography_notes">Typography notes</Label>
                <Textarea id="typography_notes" name="typography_notes" rows={3} defaultValue={brand.typography_notes ?? ""} placeholder="Headings in caps, body never below 16px…" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ai_guidance">Guidance for AI-generated content</Label>
                <Textarea id="ai_guidance" name="ai_guidance" rows={4} defaultValue={brand.ai_guidance ?? ""} placeholder="Explicit rules: always mention the service area, never promise timelines, CTA is 'Call for a free estimate'…" />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit">Save identity</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Colors */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Colors</CardTitle>
            <CardDescription>Assign a primary and secondary so the board and AI know the hierarchy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {colors.map((c) => {
                const update = updateColorAction.bind(null, clientId, c.id);
                const del = deleteColorAction.bind(null, clientId, c.id);
                return (
                  <li key={c.id} className="flex items-start gap-2 rounded-md border p-2">
                    <div
                      className="size-10 shrink-0 rounded-md border flex items-center justify-center text-[10px] font-mono"
                      style={{ background: c.hex, color: isLightColor(c.hex) ? "#0b162a" : "#fff" }}
                    >
                      {c.hex.slice(1, 4).toUpperCase()}
                    </div>
                    <form action={update} className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-[1fr_auto_auto_1fr_auto]">
                      <Input name="name" defaultValue={c.name} aria-label="Name" className="h-8" />
                      <input type="color" name="hex" defaultValue={c.hex} aria-label="Color" className="h-8 w-10 rounded border bg-transparent p-0.5" />
                      <select name="role" defaultValue={c.role} className={`${selectClass} h-8`}>
                        {brandColorRoles.map((r) => (
                          <option key={r} value={r}>{brandColorRoleLabels[r]}</option>
                        ))}
                      </select>
                      <Input name="usage" defaultValue={c.usage ?? ""} placeholder="Usage" aria-label="Usage" className="h-8" />
                      <Button type="submit" variant="outline" size="sm">Save</Button>
                    </form>
                    <form action={del}>
                      <Button type="submit" variant="ghost" size="sm" aria-label="Delete color">✕</Button>
                    </form>
                  </li>
                );
              })}
              {colors.length === 0 && (
                <p className="text-sm text-muted-foreground">No colors yet.</p>
              )}
            </ul>
            <form action={addColor} className="grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-[1fr_auto_1fr_auto]">
              <Input name="name" placeholder="Name (e.g. Brand orange)" />
              <div className="flex items-center gap-1">
                <input type="color" name="hex" defaultValue="#e85d04" aria-label="Pick color" className="h-9 w-10 rounded border bg-transparent p-0.5" />
                <Input name="hex_text" placeholder="#hex" className="w-24 font-mono" />
              </div>
              <select name="role" defaultValue="primary" className={selectClass}>
                {brandColorRoles.map((r) => (
                  <option key={r} value={r}>{brandColorRoleLabels[r]}</option>
                ))}
              </select>
              <Button type="submit" variant="outline">Add color</Button>
              <Input name="usage" placeholder="Where it's used (optional)" className="col-span-2 sm:col-span-4" />
            </form>
          </CardContent>
        </Card>

        {/* Fonts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fonts</CardTitle>
            <CardDescription>Google fonts render live on the board when the source is &quot;google&quot;.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {fonts.map((f) => {
                const del = deleteFontAction.bind(null, clientId, f.id);
                return (
                  <li key={f.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{f.family}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {brandFontRoleLabels[f.role]}
                        {f.weights ? ` · ${f.weights}` : ""}
                        {f.source ? ` · ${f.source}` : ""}
                        {f.notes ? ` · ${f.notes}` : ""}
                      </div>
                    </div>
                    {f.url && (
                      <a href={f.url} target="_blank" rel="noreferrer" className="text-xs hover:underline">
                        link
                      </a>
                    )}
                    <form action={del}>
                      <Button type="submit" variant="ghost" size="sm" aria-label="Delete font">✕</Button>
                    </form>
                  </li>
                );
              })}
              {fonts.length === 0 && (
                <p className="text-sm text-muted-foreground">No fonts yet.</p>
              )}
            </ul>
            <form action={addFont} className="grid grid-cols-2 gap-2 border-t pt-3">
              <Input name="family" placeholder="Family (e.g. Montserrat)" required />
              <select name="role" defaultValue="heading" className={selectClass}>
                {brandFontRoles.map((r) => (
                  <option key={r} value={r}>{brandFontRoleLabels[r]}</option>
                ))}
              </select>
              <Input name="source" placeholder="Source: google / adobe / custom" />
              <Input name="weights" placeholder="Weights (400, 700)" />
              <Input name="url" placeholder="URL (optional)" className="col-span-2" />
              <Input name="notes" placeholder="Notes (optional)" className="col-span-2" />
              <Button type="submit" variant="outline" className="col-span-2">Add font</Button>
            </form>
          </CardContent>
        </Card>

        {/* Assets */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Logos, photos &amp; reference material</CardTitle>
            <CardDescription>
              Upload anything that shows the brand: logo files, photos, screenshots of
              the current website and social posts, print pieces. Stored privately in
              Supabase and served to the board with signed links.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <BrandAssetUploader clientId={clientId} />

            <form action={addLink} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
              <Input name="label" placeholder="Label" />
              <Input name="url" placeholder="Link to an Instagram post, Canva design, Drive file…" required />
              <select name="kind" defaultValue="social_post" className={selectClass}>
                {brandAssetKinds.map((k) => (
                  <option key={k} value={k}>{brandAssetKindLabels[k]}</option>
                ))}
              </select>
              <Button type="submit" variant="outline">Add link</Button>
            </form>

            <ul className="grid gap-3 sm:grid-cols-2">
              {assets.map((a) => {
                const update = updateAssetAction.bind(null, clientId, a.id);
                const del = deleteAssetAction.bind(null, clientId, a.id);
                const makePrimary = setPrimaryAssetAction.bind(null, clientId, a.id);
                const image = a.signed_url && isImage(a);
                return (
                  <li key={a.id} className="flex gap-3 rounded-md border p-2">
                    <a
                      href={a.signed_url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="size-20 shrink-0 overflow-hidden rounded-md border bg-white flex items-center justify-center text-[10px] text-muted-foreground"
                    >
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.signed_url!} alt={a.label} className="size-full object-contain" />
                      ) : (
                        "file"
                      )}
                    </a>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <form action={update} className="grid grid-cols-2 gap-1.5">
                        <Input name="label" defaultValue={a.label} className="h-8 col-span-2" aria-label="Label" />
                        <select name="kind" defaultValue={a.kind} className={`${selectClass} h-8`}>
                          {brandAssetKinds.map((k) => (
                            <option key={k} value={k}>{brandAssetKindLabels[k]}</option>
                          ))}
                        </select>
                        <Input name="notes" defaultValue={a.notes ?? ""} placeholder="Notes" className="h-8" aria-label="Notes" />
                        <div className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                          <Button type="submit" variant="outline" size="xs">Save</Button>
                          {a.is_primary && <Badge variant="secondary">primary</Badge>}
                          <span className="truncate">
                            {a.source === "link" ? "link" : a.file_name}
                            {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                            {a.source === "website_scan" ? " · from website" : ""}
                          </span>
                        </div>
                      </form>
                      <div className="flex gap-2">
                        {!a.is_primary && (
                          <form action={makePrimary}>
                            <Button type="submit" variant="ghost" size="xs">Make primary</Button>
                          </form>
                        )}
                        <form action={del}>
                          <Button type="submit" variant="ghost" size="xs" className="text-destructive">Delete</Button>
                        </form>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {assets.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
