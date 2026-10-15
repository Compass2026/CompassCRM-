// Prints the dense 1/2/5-mile layout for one map-grid profile and the SQL that
// would apply it. It never connects to a database: review the preview, then run
// the SQL deliberately (service role). Usage:
//   node --no-warnings scripts/map-grid-local-geometry.mjs <profile_id> <lat> <lng> [keywords] [--market "<label>"]
// --market centres the scan on a documented market center (a service-area
// business with no public address); the viewer then measures from the scan
// center, and the SQL does not require the center to equal the grid config's.
import {
  localGrid,
  scanPreview,
  withinRadius,
  validateGrid,
} from "../supabase/functions/_shared/map-grid.ts";

const args = process.argv.slice(2);
const marketAt = args.indexOf("--market");
const marketLabel = marketAt >= 0 ? args[marketAt + 1] : undefined;
if (marketAt >= 0) args.splice(marketAt, 2);
if (marketAt >= 0 && !marketLabel?.trim()) {
  console.error("--market needs a label");
  process.exit(1);
}
const [profileId, lat, lng, keywordCount = "5"] = args;
if (!/^[0-9a-f-]{36}$/i.test(profileId ?? "") || !lat || !lng) {
  console.error("usage: <profile_id> <lat> <lng> [keywords]");
  process.exit(1);
}
const center = { lat: Number(lat), lng: Number(lng) };
const { points, geometry } = localGrid(
  center,
  undefined,
  marketLabel ? { label: marketLabel } : undefined,
);
const keywords = Array.from({ length: Number(keywordCount) }, (_, i) => ({
  id: `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
  keyword: `keyword ${i + 1}`,
}));
validateGrid({ target_place_id: "preview-only", zoom: 13, points, keywords, geometry });
const preview = scanPreview({ points, keywords });
console.error(
  `${preview.points} points (${geometry.radii_miles
    .map((r) => `${withinRadius(points, center, r).length} within ${r} mi`)
    .join(", ")}) x ${preview.keywords} keywords = ${preview.checks} checks, est. $${preview.estimatedCost.toFixed(3)}`,
);
const json = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
// Only the points and their geometry change. Keywords, Place ID, zoom, search
// mode and both enable switches are untouched; earlier runs keep their own
// frozen copy of the broad points. For a business-centred scan the join
// refuses a center that is not the grid config's recorded home location.
console.log(`update public.map_grid_profiles p
   set points = ${json(points)},
       geometry = ${json(geometry)}
  from public.grid_configs g
 where p.id = '${profileId}'
   and g.id = p.grid_config_id
${marketLabel ? "" : `   and g.center_lat = ${center.lat}
   and g.center_lng = ${center.lng}
`}   and not exists (select 1 from public.map_grid_runs r where r.profile_id = p.id and r.status = 'running')
returning p.id, jsonb_array_length(p.points) as points, p.geometry->>'version' as geometry, p.enabled, p.weekly_enabled, p.search_this_area;`);
