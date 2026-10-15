// BrightLocal → Compass map-grid migration, Oct 2026 (Executive OS task b7fd8c93).
// Prints ONE guarded, idempotent SQL script that prepares the nine remaining
// BrightLocal locations for dense 1/2/5-mile scans. It never connects to a
// database. Review the printed preview (stderr), then run the SQL deliberately.
//
// What the SQL does, all in one transaction:
// - creates Silverback, MADHAIRLAB and Premier as map-tracking-only clients
//   (paused, service_scope 'map_tracking': no onboarding, content or billing),
//   with their location and their BrightLocal grid keywords (not rank-tracked);
// - records Show Me Design's user-confirmed phone (CRM only, never its GBP);
// - adds grid configs where the old center was wrong (Ginger Huff, Show Me
//   Design) or the business has no public address (Logic Wichita, market
//   center). Old configs and their BrightLocal history are never changed;
// - creates one map_grid_profile per location, DISABLED with weekly OFF.
//   Enabling, the first scan and weekly scheduling are separate steps after
//   the collector capacity fix is deployed.
//
// Usage: node --no-warnings scripts/brightlocal-migration-onboarding.mjs > onboarding.sql
import {
  localGrid,
  scanPreview,
  validateGrid,
  withinRadius,
} from "../supabase/functions/_shared/map-grid.ts";

// Verified Oct 15 2026: BrightLocal location record + LSG gmb_info, Google
// listing by CID (DataForSEO Business Listings), OpenStreetMap geocoding.
const ROSTER = [
  {
    key: "ginger-huff",
    client: { id: "db9009c2-a04b-4e93-843f-e20c49263b5b", name: "Ginger Huff Interiors" },
    location: { name: "Edwardsville, IL" },
    gridConfig: { reuse: null, oldId: "4be2b877-d3f4-4b56-916d-6cdbbf4319ce" },
    // Service-area business. Old center 38.763434,-90.278501 was a copied
    // coordinate (neither Edwardsville nor the Google pin); this is the
    // business address 906 Chaderic Ct, Edwardsville IL (house-level geocode).
    center: { lat: 38.8054072, lng: -89.9405907 },
    placeId: "ChIJnXPBV0j9dYgRg7f-R093WoE",
    keywords: ["interior designer Edwardsville IL", "home interior design Edwardsville", "home decorating services Edwardsville", "interior decorator Edwardsville IL", "interior styling Edwardsville"],
  },
  {
    key: "logic-overland-park",
    client: { id: "70211d71-d9f4-46ab-abe2-ef39c41591fb", name: "Logic Solar" },
    location: { name: "Overland Park, KS" },
    gridConfig: { reuse: "97913405-2cee-4924-acd0-6b4545b5b899" },
    center: { lat: 38.931076, lng: -94.67073 }, // = grid config = Google pin
    placeId: "ChIJLWbuWlu8FgcRSYp_-iE2BCU",
    keywords: ["solar installer overland park ks", "solar panels overland park ks", "solar installation overland park ks", "solar energy company overland park ks", "solar company in kansas city"],
  },
  {
    key: "logic-wichita",
    client: { id: "70211d71-d9f4-46ab-abe2-ef39c41591fb", name: "Logic Solar" },
    location: { name: "Wichita, KS" },
    gridConfig: { reuse: null, oldId: "fa4a2276-1007-4a40-9581-bf113ca026bf" },
    // Service-area business with no public address (Tom, Oct 15 11:34 CT).
    // Searchers are sampled around the Wichita market: OpenStreetMap city
    // relation 129814. Ranks are still matched to Logic Wichita's own listing.
    center: { lat: 37.6922361, lng: -97.3375448 },
    market: "Wichita, KS market center",
    placeId: "ChIJv4ASxjIv0QoRd8sw7qPgEls",
    keywords: ["solar panels wichita ks", "solar installation wichita ks", "solar company wichita ks", "solar energy wichita ks", "solar installers wichita ks"],
  },
  {
    key: "pensacola-equipment",
    client: { id: "1e12fc47-731a-4d84-a4f1-4aed777db451", name: "Pensacola Equipment Rentals" },
    location: { name: "Pensacola, FL" },
    gridConfig: { reuse: "058b8b08-0b7a-4b86-b3ac-dc5b2b01c76d" },
    center: { lat: 30.497347, lng: -87.214623 }, // = grid config = Google pin
    // Its own listing (CID 9161359117850950736, 850-407-6566), not Premier's.
    placeId: "ChIJUy3ofcuwo4ERULxKJ5SvI38",
    keywords: ["equipment rental pensacola", "tool rental pensacola", "construction equipment rental pensacola", "mini excavator rental pensacola", "bobcat rental pensacola"],
  },
  {
    key: "show-me-design",
    client: { id: "d94cfde2-0751-4002-a149-c83b4c6c956d", name: "Show Me Design", confirmPhone: { from: "314-724-6895", to: "314-571-9756" } },
    location: { name: "St. Louis, MO" },
    gridConfig: { reuse: null, oldId: "a669670a-8e8b-40a8-8dbe-cccb22d211bc" },
    // Service-area business. Old center was the same copied coordinate as
    // Ginger Huff's; this is the business address 5602 Heege Rd (geocode,
    // within ~4 m of Google's pin for Show Me Electrical at that address).
    center: { lat: 38.5647035, lng: -90.311939 },
    placeId: "ChIJGU2MbbXKXAURWwPOpDLkc5E",
    keywords: ["design build st louis", "home remodeling st louis", "remodeling contractors st louis", "construction company st louis", "home renovation st louis"],
  },
  {
    key: "show-me-electrical",
    client: { id: "9a8e05f5-3d28-4839-9735-79bcdd0e277d", name: "Show Me Electrical" },
    location: { name: "St. Louis, MO" },
    gridConfig: { reuse: "04980c4e-d4ba-46f6-80c4-d4d28744787d" },
    center: { lat: 38.564664, lng: -90.311971 }, // = grid config = Google pin
    placeId: "ChIJt3avua_J2IcRK_ISbij5_JY",
    keywords: ["Electrician St Louis MO", "Licensed electrician St Louis", "Emergency electrician St Louis", "Residential electrician St Louis", "Commercial electrical services St Louis"],
  },
  ...[
    {
      key: "silverback",
      name: "Silverback Plumbing & Contracting LLC", industry: "Plumbing",
      website: "http://silverbackplumbingstl.com/", phone: "636-487-7003",
      address: "317 Aspen Creek Drive", city: "Wentzville", state: "MO", zip: "63385",
      center: { lat: 38.8312555, lng: -90.8428014 },
      placeId: "ChIJvx1HuyzH3ocRhFh2LB3lR68", blLocation: "3817186", blLrt: "1685297", blLsg: "316347",
      keywords: ["plumber near me", "plumber wentzville mo", "water heater repair", "emergency plumber"],
    },
    {
      key: "madhairlab",
      name: "MADHAIRLAB", industry: "Hair salon",
      website: "http://www.madhairlab.com/", phone: "480-295-9787",
      address: "21455 South Ellsworth Road, Suite 47", city: "Queen Creek", state: "AZ", zip: "85142",
      center: { lat: 33.2529768, lng: -111.6322437 },
      placeId: "ChIJtbEOoqVNKocR0Dusf69CqdY", blLocation: "3817215", blLrt: "1685304", blLsg: "316361",
      keywords: ["hair salon Queen Creek AZ", "hair stylist Queen Creek AZ", "best hair salon near me", "women's haircut Queen Creek", "hair coloring Queen Creek AZ"],
    },
    {
      key: "premier-building",
      name: "Premier Building Solutions", industry: "Construction",
      website: "https://www.premier-building-solutions.com/", phone: "850-637-4442",
      address: "7013 Chapel Street", city: "Pensacola", state: "FL", zip: "32504",
      center: { lat: 30.4973473, lng: -87.2146226 },
      placeId: "ChIJtzII7e9mpGUR_1bTJF9ADa4", blLocation: "3817278", blLrt: "1690334", blLsg: "321484",
      keywords: ["Construction Company", "Builder", "General Contractor"],
    },
  ].map((n) => ({ ...n, newClient: true, location: { name: `${n.city}, ${n.state}` }, gridConfig: { reuse: null } })),
];

const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replaceAll("'", "''")}'`);
const json = (v) => `${lit(JSON.stringify(v))}::jsonb`;
const id = (table, key) => `extensions.uuid_generate_v5(extensions.uuid_ns_dns(), ${lit(`brightlocal-migration-2026-10:${table}:${key}`)})`;

let weekly = 0;
const out = [
  "-- Generated by scripts/brightlocal-migration-onboarding.mjs. Review before running.",
  "-- Guarded, idempotent: re-running changes nothing. Profiles are created DISABLED.",
  "begin;",
  "do $$ begin",
  "  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='clients' and column_name='service_scope') then",
  "    raise exception 'apply 20261015170000_client_service_scope first'; end if;",
  `  if not public.map_grid_geometry_valid('{"version":"local-multiscale-v1","center":{"lat":1,"lng":1},"tiers":[{"max_miles":5,"spacing_miles":1}],"radii_miles":[5],"default_radius_miles":5,"point_count":1,"center_kind":"market"}'::jsonb, 1) is false then`,
  "    raise exception 'apply 20261015171000_map_grid_market_center first'; end if;",
  "end $$;",
];
for (const r of ROSTER) {
  const { points, geometry } = localGrid(r.center, undefined, r.market ? { label: r.market } : undefined);
  const kw = r.keywords.map((k, i) => ({ id: `00000000-0000-4000-a000-00000000000${i}`, keyword: k }));
  validateGrid({ target_place_id: r.placeId, zoom: 13, points, keywords: kw, geometry });
  const p = scanPreview({ points, keywords: kw });
  weekly += p.estimatedCost;
  console.error(
    `${(r.client?.name ?? r.name).padEnd(38)} ${r.location.name.padEnd(18)} ${points.length} pts ${[1, 2, 5].map((x) => withinRadius(points, r.center, x).length).join("/")} × ${kw.length} kw = ${p.checks} checks $${p.estimatedCost.toFixed(3)}  center ${r.center.lat},${r.center.lng}${r.market ? ` (${r.market})` : ""}`,
  );
  const clientId = r.newClient ? id("clients", r.key) : lit(r.client.id);
  out.push(`\n-- ${r.client?.name ?? r.name}, ${r.location.name}`);
  if (r.newClient) {
    out.push(
      `insert into public.clients (id, name, industry, website_url, phone, address_line1, city, state, zip, status, service_scope, notes)
 values (${clientId}, ${lit(r.name)}, ${lit(r.industry)}, ${lit(r.website)}, ${lit(r.phone)}, ${lit(r.address)}, ${lit(r.city)}, ${lit(r.state)}, ${lit(r.zip)}, 'paused', 'map_tracking',
   'Map tracking only (BrightLocal migration, Oct 2026). No onboarding, content, reporting or billing services.')
 on conflict (id) do nothing;`,
      `insert into public.locations (id, client_id, name, city, state, lat, lng, is_physical_location, gbp_place_id, brightlocal_location_id, brightlocal_lrt_report_id)
 values (${id("locations", r.key)}, ${clientId}, ${lit(r.location.name)}, ${lit(r.city)}, ${lit(r.state)}, ${r.center.lat}, ${r.center.lng}, true, ${lit(r.placeId)}, ${lit(r.blLocation)}, ${lit(r.blLrt)})
 on conflict (id) do nothing;`,
      ...r.keywords.map(
        (k) => `insert into public.keywords (id, client_id, keyword, city, is_tracked, source)
 values (${id("keywords", `${r.key}:${k.toLowerCase()}`)}, ${clientId}, ${lit(k)}, ${lit(r.city)}, false, 'brightlocal_map_grid')
 on conflict (id) do nothing;`,
      ),
    );
  } else {
    out.push(
      `do $$ begin if not exists (select 1 from public.clients where id = ${clientId} and name = ${lit(r.client.name)}) then raise exception ${lit(`client ${r.client.name} not found`)}; end if; end $$;`,
    );
    if (r.client.confirmPhone)
      out.push(
        `-- User-confirmed (Tom, Oct 15 11:34 CT) for CRM identity only; its live Google profile is not changed.
update public.clients set phone = ${lit(r.client.confirmPhone.to)} where id = ${clientId} and phone = ${lit(r.client.confirmPhone.from)};`,
      );
  }
  // The location this grid hangs off: matched by client + name, exactly one.
  const locExpr = r.newClient
    ? id("locations", r.key)
    : `(select l.id from public.locations l where l.client_id = ${clientId} and l.name = ${lit(r.location.name)})`;
  if (!r.newClient)
    out.push(
      `do $$ begin if (select count(*) from public.locations where client_id = ${clientId} and name = ${lit(r.location.name)}) <> 1 then raise exception ${lit(`location ${r.location.name} for ${r.client.name} is not unique`)}; end if; end $$;`,
    );
  // Keywords resolved by client + exact CRM text (case-insensitive match, CRM spelling kept).
  const kwJson = `(select jsonb_agg(jsonb_build_object('id', k.id, 'keyword', k.keyword) order by array_position(array[${r.keywords.map((k) => lit(k.toLowerCase())).join(", ")}], lower(k.keyword)))
   from public.keywords k where k.client_id = ${clientId} and lower(k.keyword) = any (array[${r.keywords.map((k) => lit(k.toLowerCase())).join(", ")}]))`;
  let gridId;
  if (r.gridConfig.reuse) {
    gridId = lit(r.gridConfig.reuse);
    out.push(
      `do $$ begin if not exists (select 1 from public.grid_configs where id = ${gridId} and location_id = ${locExpr} and center_lat = ${r.center.lat} and center_lng = ${r.center.lng}) then raise exception ${lit(`grid config ${r.gridConfig.reuse} no longer matches the verified center`)}; end if; end $$;`,
    );
  } else {
    gridId = id("grid_configs", r.key);
    out.push(
      `insert into public.grid_configs (id, location_id, brightlocal_lsg_report_id, grid_size, spacing_miles, center_lat, center_lng, keyword_ids, is_active)
 values (${gridId}, ${locExpr}, ${lit(r.blLsg ?? null)}, 11, 1, ${r.center.lat}, ${r.center.lng}, '{}'::uuid[], true)
 on conflict (id) do nothing;`,
    );
  }
  out.push(
    `insert into public.map_grid_profiles (id, client_id, grid_config_id, label, target_place_id, points, keywords, zoom, search_this_area, geometry, enabled, weekly_enabled)
 select ${id("map_grid_profiles", r.key)}, ${clientId}, ${gridId}, ${lit(`${r.client?.name ?? r.name} — ${r.location.name}`)}, ${lit(r.placeId)},
   ${json(points)}, ${kwJson}, 13, false, ${json(geometry)}, false, false
 where not exists (select 1 from public.map_grid_profiles where grid_config_id = ${gridId})
 on conflict (id) do nothing;`,
    `do $$ begin if (select jsonb_array_length(keywords) from public.map_grid_profiles where grid_config_id = ${gridId}) is distinct from ${r.keywords.length} then raise exception ${lit(`${r.key}: expected ${r.keywords.length} matched keywords`)}; end if; end $$;`,
  );
}
out.push(
  `\n-- Every prepared profile is disabled, weekly off, valid, and the three new clients got no onboarding.
do $$ begin
  if (select count(*) from public.map_grid_profiles where id in (${ROSTER.map((r) => id("map_grid_profiles", r.key)).join(", ")}) and not enabled and not weekly_enabled) <> ${ROSTER.length} then
    raise exception 'prepared profiles are not all present, disabled and weekly-off'; end if;
  if exists (select 1 from public.client_pipelines where client_id in (${ROSTER.filter((r) => r.newClient).map((r) => id("clients", r.key)).join(", ")})) then
    raise exception 'a map-tracking client was enrolled in a pipeline'; end if;
end $$;`,
  "commit;",
);
console.error(`TOTAL ${ROSTER.length} locations: $${weekly.toFixed(3)}/week (plus Lucas $0.459 = $${(weekly + 0.459).toFixed(3)}), ≈ $${(((weekly + 0.459) * 52) / 12).toFixed(2)}/month`);
console.log(out.join("\n"));
