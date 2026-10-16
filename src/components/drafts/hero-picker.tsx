"use client";

import { useActionState, useState } from "react";
import { setDraftHeroAction, type DraftFormState } from "@/app/draft-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type HeroOption = { id: string; label: string; kind: string; preview: string | null; width: number | null; height: number | null };

// Choose or replace a blog draft's hero image from the client's stored,
// hashed photos and social graphics (20261015210000), with its alt text.
export function HeroPicker({ clientId, draftId, version, options, current, alt, illustrativeLabel }: {
  clientId: string; draftId: string; version: number; options: HeroOption[];
  current: string | null; alt: string | null; illustrativeLabel: string;
}) {
  const [state, action, pending] = useActionState<DraftFormState, FormData>(setDraftHeroAction.bind(null, clientId, draftId, version), {});
  const [chosen, setChosen] = useState<string | null>(current);
  const picked = options.find((o) => o.id === chosen);
  if (options.length === 0) {
    return <p className="text-xs text-muted-foreground">No stored, hashed photo or social graphic for this client yet. Add one on the Brand tab.</p>;
  }
  return (
    <form action={action} className="space-y-3" data-hero-picker>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium">{current ? "Replace the hero image" : "Choose a hero image"}</legend>
        <div className="grid grid-cols-3 gap-2">
          {options.map((o) => (
            <label key={o.id} title={o.label} data-hero-option={o.id}
              className={cn("relative block cursor-pointer overflow-hidden rounded-md border-2 bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                chosen === o.id ? "border-primary" : "border-transparent hover:border-muted-foreground/40")}>
              <input type="radio" name="hero_asset_id" value={o.id} checked={chosen === o.id} onChange={() => setChosen(o.id)} className="sr-only" />
              {o.preview
                ? // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                  <img src={o.preview} alt="" className="aspect-[4/3] w-full object-cover" />
                : <span className="flex aspect-[4/3] items-center justify-center p-1 text-center text-[10px] text-muted-foreground">{o.label}</span>}
              {o.kind === "social_post" && <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 text-[9px] text-white">Illustrative</span>}
              <span className="sr-only">{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {picked && <p className="text-xs [overflow-wrap:anywhere]">{picked.label}{picked.kind === "social_post" ? <span className="block text-amber-800">{illustrativeLabel}</span> : null}</p>}
      <div className="space-y-1">
        <Label htmlFor="hero_alt" className="text-xs">Alt text</Label>
        <Textarea id="hero_alt" name="hero_alt" rows={2} maxLength={250} defaultValue={alt ?? ""}
          placeholder="What the image shows, for people who cannot see it" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !chosen}>{pending ? "Saving…" : "Save hero image"}</Button>
        {current && <Button type="submit" size="sm" variant="ghost" name="remove" value="1" disabled={pending}>Remove</Button>}
      </div>
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.text && <p role="status" className="text-sm text-green-800">{state.text}</p>}
    </form>
  );
}
