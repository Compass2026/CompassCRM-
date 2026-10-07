// Focal-point-aware cover crop. The box is filled from the largest source
// region with the box's shape that keeps the reviewer's focal point as close
// to the centre as the edges allow. The source is never enlarged: a region
// smaller than the box in pixels is refused (the photo is too small for that
// slot), so a marginal photo cannot be upscaled into a hero.
import { CopyRefusal } from "./text.ts";

export type Crop = {
  x: number; y: number; w: number; h: number;   // source pixels
  scale: number;                                  // box px per source px (≤ 1)
  focal: { x: number; y: number };                // normalised, as reviewed
};

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function focalCrop(
  src: { width: number; height: number },
  focal: { x: number; y: number },
  box: { w: number; h: number },
  slot: string,
): Crop {
  const { width: sw, height: sh } = src;
  if (!(sw > 0 && sh > 0)) throw new CopyRefusal("source_dimensions_unknown", "The source photo's size is unknown", slot);
  if (!(focal.x >= 0 && focal.x <= 1 && focal.y >= 0 && focal.y <= 1)) {
    throw new CopyRefusal("focal_point_missing", "The source photo has no reviewed focal point", slot);
  }
  // The largest region of the box's aspect ratio inside the source.
  const boxRatio = box.w / box.h;
  let cw = sw, ch = sw / boxRatio;
  if (ch > sh) { ch = sh; cw = sh * boxRatio; }
  const scale = box.w / cw;
  if (scale > 1 + 1e-9) {
    throw new CopyRefusal("source_too_small",
      `The photo (${sw}×${sh}) would be enlarged ${scale.toFixed(2)}× to fill the ${box.w}×${box.h} ${slot} slot`, slot);
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const x = clamp(focal.x * sw - cw / 2, 0, sw - cw);
  const y = clamp(focal.y * sh - ch / 2, 0, sh - ch);
  return { x: r4(x), y: r4(y), w: r4(cw), h: r4(ch), scale: r4(scale), focal: { x: focal.x, y: focal.y } };
}
