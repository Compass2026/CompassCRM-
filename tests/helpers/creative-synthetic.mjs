// Pure (runtime-neutral) synthetic stand-ins for the Creative Engine tests:
// an SVG per asset at its production size — photos with a marker at the
// reviewed focal point, a white-on-transparent logo. Rasterised by the pinned
// engine in Node (tests) and Deno (scripts/creative-deno-check.ts) alike.
export const ORANGE = "#e87722";
export function syntheticSvg(a) {
  if (a.kind === "photo") {
    const fx = (a.focal_x ?? 0.5) * a.width, fy = (a.focal_y ?? 0.5) * a.height;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b8fb5"/><stop offset="1" stop-color="#3d4a3a"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/><path d="M0 ${a.height * 0.55} L${a.width / 2} ${a.height * 0.3} L${a.width} ${a.height * 0.55} Z" fill="#4a3b33"/>` +
      `<circle cx="${fx}" cy="${fy}" r="${Math.round(a.width / 18)}" fill="${ORANGE}"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}"><rect x="${a.width * 0.1}" y="${a.height * 0.2}" width="${a.width * 0.8}" height="${a.height * 0.5}" fill="#ffffff"/><rect x="${a.width * 0.05}" y="${a.height * 0.1}" width="${a.width * 0.06}" height="${a.height * 0.7}" fill="#b0601b"/></svg>`;
}
