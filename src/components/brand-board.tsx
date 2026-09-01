import {
  googleFontsHref,
  isImage,
  isLightColor,
  pickPrimary,
  splitAssets,
  type BrandAsset,
  type BrandBoardData,
} from "@/lib/brand";
import {
  brandAssetKindLabels,
  brandColorRoleLabels,
  brandFontRoleLabels,
} from "@/lib/labels";
import { cn } from "@/lib/utils";

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3 break-inside-avoid", className)}>
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground border-b pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Prose({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
    </div>
  );
}

function Chips({ items, avoid }: { items: string[]; avoid?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span
          key={i}
          className={cn(
            "rounded-full border px-3 py-1 text-xs",
            avoid && "line-through text-muted-foreground"
          )}
        >
          {i}
        </span>
      ))}
    </div>
  );
}

function AssetFigure({ asset }: { asset: BrandAsset }) {
  const image = asset.signed_url && isImage(asset);
  return (
    <figure className="rounded-lg border overflow-hidden bg-muted/30 break-inside-avoid">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.signed_url!}
          alt={asset.label}
          className="block w-full h-44 object-cover bg-white"
        />
      ) : (
        <a
          href={asset.signed_url ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="flex h-44 items-center justify-center px-3 text-center text-xs text-muted-foreground break-all hover:underline"
        >
          {asset.file_name ?? asset.url ?? asset.label}
        </a>
      )}
      <figcaption className="px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{asset.label}</span>
        <br />
        {brandAssetKindLabels[asset.kind]}
        {asset.notes ? ` · ${asset.notes}` : ""}
      </figcaption>
    </figure>
  );
}

/**
 * The visual brand board. Pure presentation — used on the Brand tab, the
 * printable page, and mirrored by the HTML snapshot in brand-board-html.ts.
 */
export function BrandBoard({
  data,
  showEmptyHints = false,
}: {
  data: BrandBoardData;
  showEmptyHints?: boolean;
}) {
  const { client, brand, colors, fonts, assets } = data;
  const primary = colors.find((c) => c.role === "primary") ?? colors[0] ?? null;
  const secondary = colors.find((c) => c.role === "secondary") ?? null;
  const logo = pickPrimary(assets, "logo_primary") ?? pickPrimary(assets, "wordmark");
  const { logos, references } = splitAssets(assets);
  const fontsHref = googleFontsHref(fonts);
  const empty =
    colors.length === 0 && fonts.length === 0 && assets.length === 0 && !brand.tagline;

  return (
    <div
      className="bg-white text-navy-900 rounded-xl border shadow-xs p-6 sm:p-10 space-y-10"
      style={{ "--brand": primary?.hex ?? "#e85d04", "--brand2": secondary?.hex ?? "#16294e" } as React.CSSProperties}
    >
      {fontsHref && <link rel="stylesheet" href={fontsHref} />}

      <header
        className="flex flex-wrap items-end justify-between gap-6 pb-6"
        style={{ borderBottom: "4px solid var(--brand)" }}
      >
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground mb-2">
            Brand board
          </div>
          <h1 className="font-heading text-4xl font-semibold tracking-tight leading-none">
            {client.name}
          </h1>
          {brand.tagline && (
            <p className="mt-2 text-xl" style={{ color: "var(--brand2)" }}>
              {brand.tagline}
            </p>
          )}
        </div>
        <div className="text-right text-sm text-muted-foreground">
          {client.industry && <div>{client.industry}</div>}
          {client.website_url && (
            <div>{client.website_url.replace(/^https?:\/\//, "")}</div>
          )}
          <div>
            {brand.approved_at
              ? `Approved ${brand.approved_at.slice(0, 10)}`
              : "Draft"}
          </div>
        </div>
      </header>

      {empty && showEmptyHints && (
        <p className="text-sm text-muted-foreground">
          Nothing on the board yet. Scan the website for a head start, upload
          logos and reference material, and fill in the identity fields below.
        </p>
      )}

      {(logo || showEmptyHints) && (
        <Section title="Logo">
          {logo?.signed_url && isImage(logo) ? (
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { bg: "#ffffff", border: true },
                { bg: primary?.hex ?? "#0b162a", border: false },
                { bg: "#0b162a", border: false },
              ].map((tile, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-xl flex items-center justify-center p-8 min-h-44",
                    tile.border && "border"
                  )}
                  style={{ background: tile.bg }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logo.signed_url ?? undefined}
                    alt={logo.label}
                    className="max-h-32 max-w-full object-contain"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              No primary logo yet — upload one below and mark it primary.
            </p>
          )}
        </Section>
      )}

      {colors.length > 0 && (
        <Section title="Color palette">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {colors.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border p-4 min-h-28 flex flex-col justify-end"
                style={{
                  background: c.hex,
                  color: isLightColor(c.hex) ? "#0b162a" : "#ffffff",
                }}
              >
                <div className="font-semibold text-sm">{c.name}</div>
                <div className="font-mono text-xs opacity-90">{c.hex.toUpperCase()}</div>
                <div className="text-[11px] opacity-85 mt-1">
                  {brandColorRoleLabels[c.role]}
                  {c.usage ? ` · ${c.usage}` : ""}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(fonts.length > 0 || brand.typography_notes) && (
        <Section title="Typography">
          <div className="divide-y">
            {fonts.map((f) => (
              <div key={f.id} className="py-3">
                <div
                  className="text-3xl leading-tight"
                  style={{ fontFamily: `'${f.family}', system-ui, sans-serif` }}
                >
                  Aa Bb Cc 0123 — The quick brown fox
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  <span className="font-medium text-foreground">{f.family}</span>
                  {" · "}
                  {brandFontRoleLabels[f.role]}
                  {f.weights ? ` · ${f.weights}` : ""}
                  {f.source ? ` · ${f.source}` : ""}
                  {f.notes ? ` · ${f.notes}` : ""}
                </div>
              </div>
            ))}
          </div>
          <Prose text={brand.typography_notes} />
        </Section>
      )}

      {(brand.positioning || brand.audience || brand.differentiators || brand.voice_tone || brand.story) && (
        <Section title="Positioning & voice">
          <div className="grid gap-6 sm:grid-cols-2">
            {[
              ["Positioning", brand.positioning],
              ["Audience", brand.audience],
              ["Why choose us", brand.differentiators],
              ["Voice & tone", brand.voice_tone],
            ]
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label}>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                    {label}
                  </div>
                  <Prose text={v} />
                </div>
              ))}
          </div>
          {brand.story && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                Brand story
              </div>
              <Prose text={brand.story} />
            </div>
          )}
        </Section>
      )}

      {(brand.content_pillars.length > 0 || brand.words_we_use.length > 0 || brand.words_we_avoid.length > 0) && (
        <Section title="Content pillars & language">
          {brand.content_pillars.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                Content pillars
              </div>
              <Chips items={brand.content_pillars} />
            </div>
          )}
          {brand.words_we_use.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                Words we use
              </div>
              <Chips items={brand.words_we_use} />
            </div>
          )}
          {brand.words_we_avoid.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
                Words we avoid
              </div>
              <Chips items={brand.words_we_avoid} avoid />
            </div>
          )}
        </Section>
      )}

      {brand.imagery_style && (
        <Section title="Imagery style">
          <Prose text={brand.imagery_style} />
        </Section>
      )}

      {brand.ai_guidance && (
        <Section title="Guidance for AI-generated content">
          <div className="rounded-xl bg-cream p-4">
            <Prose text={brand.ai_guidance} />
          </div>
        </Section>
      )}

      {logos.length > 1 && (
        <Section title="Logo variations">
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {logos.map((a) => (
              <AssetFigure key={a.id} asset={a} />
            ))}
          </div>
        </Section>
      )}

      {references.length > 0 && (
        <Section title="Reference material">
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {references.map((a) => (
              <AssetFigure key={a.id} asset={a} />
            ))}
          </div>
        </Section>
      )}

      <footer className="flex justify-between border-t pt-4 text-xs text-muted-foreground">
        <span>Compass Marketing Advisors · Client Platform</span>
        <span>
          {client.name} · updated {brand.updated_at.slice(0, 10)}
        </span>
      </footer>
    </div>
  );
}
