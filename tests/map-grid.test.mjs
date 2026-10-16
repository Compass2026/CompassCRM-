import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateGrid,
  mapTask,
  parseMapsTask,
  gridMetrics,
  localGrid,
  withinRadius,
  distanceMiles,
  scanPreview,
  usableGeometry,
  centerDescription,
  LOCAL_TIERS,
} from "../supabase/functions/_shared/map-grid.ts";
const id = "00000000-0000-4000-a000-000000000001";
const config = {
  target_place_id: "ChIJfixture",
  zoom: 13,
  points: [{ lat: 38.8, lng: -90.8 }],
  keywords: [{ id, keyword: "roof repair" }],
};
test("validates unique bounded coordinates and keyword fan-out before spend", () => {
  validateGrid(config);
  for (const patch of [
    { points: [...config.points, ...config.points] },
    { points: [{ lat: NaN, lng: 1 }] },
    { keywords: [...config.keywords, ...config.keywords] },
    { zoom: 22 },
    {
      points: Array.from({ length: 225 }, (_, i) => ({
        lat: 10 + i / 100,
        lng: 2,
      })),
      keywords: Array.from({ length: 5 }, (_, i) => ({
        id: `00000000-0000-4000-a000-00000000000${i}`,
        keyword: "roof",
      })),
    },
  ])
    assert.throws(() => validateGrid({ ...config, ...patch }));
});
test("queued requests pin coordinates, depth, tag, zoom and local intent", () => {
  const task = mapTask({ id, keyword: "A+B 10%", lat: 38.8, lng: -90.8 }, 13);
  assert.equal(task.location_coordinate, "38.8000000,-90.8000000,13z");
  assert.equal(task.keyword, "A%2BB 10%25");
  assert.equal(task.tag, id);
  assert.equal(task.depth, 100);
  assert.equal(task.priority, 1);
  assert.equal(task.search_places, false);
  assert.equal(task.search_this_area, true);
  assert.equal(mapTask({ id, keyword: "roofer in wentzville mo", lat: 38.8, lng: -90.8 }, 13, false).search_this_area, false);
  assert.throws(() => validateGrid({ ...config, search_this_area: "false" }));
});
test("matches exact place ID, never a similar name, host or advertisement", () => {
  const t = {
    status_code: 20000,
    result: [
      {
        items: [
          { type: "paid", place_id: "ChIJfixture", rank_group: 1 },
          {
            type: "maps_search",
            place_id: "other",
            title: "Lucas Construction",
            rank_group: 1,
          },
          {
            type: "maps_search",
            place_id: "ChIJfixture",
            title: "Lucas",
            rank_group: 4,
          },
        ],
      },
    ],
  };
  const r = parseMapsTask(t, "ChIJfixture");
  assert.equal(r.position, 4);
  assert.equal(r.results.length, 2);
  assert.equal(parseMapsTask(t, "absent").position, null);
});
test("pending and malformed provider responses do not become ranking losses", () => {
  assert.equal(parseMapsTask({ status_code: 40602 }, "id").pending, true);
  assert.throws(() =>
    parseMapsTask({ status_code: 20000, result: null }, "id"),
  );
  assert.throws(() =>
    parseMapsTask({ status_code: 20000, result: [{}] }, "id"),
  );
  assert.equal(
    parseMapsTask({ status_code: 20000, result: [{ items: null }] }, "id")
      .position,
    null,
  );
});
test("explicit no-search-results tasks complete without retrying or accepting malformed envelopes", () => {
  for (const items of [null, []]) {
    assert.deepEqual(
      parseMapsTask({ status_code: 40102, result: [{ items }] }, "id"),
      { pending: false, position: null, results: [] },
    );
  }
  for (const result of [null, [], [{}], [{ items: [{ type: "maps_search" }] }]])
    assert.throws(() => parseMapsTask({ status_code: 40102, result }, "id"));
  assert.throws(() => parseMapsTask({ status_code: 40103, result: [{ items: null }] }, "id"));
});
test("coverage excludes incomplete checks and mean explicitly includes found ranks only", () => {
  const m = gridMetrics([
    { state: "complete", position: 1 },
    { state: "complete", position: 5 },
    { state: "complete", position: null },
    { state: "failed", position: null },
  ]);
  assert.equal(m.complete, 3);
  assert.equal(m.top3Percent, 33);
  assert.equal(m.averageFound, 3);
  assert.equal(gridMetrics([]).averageFound, null);
});
// Lucas's verified home location (locations 60a4e3dc), read Oct 14 2026.
const lucas = { lat: 38.805024, lng: -90.814768 };
test("dense local layout is deterministic, deduplicated and nested once around the center", () => {
  const a = localGrid(lucas),
    b = localGrid(lucas);
  assert.deepEqual(a, b);
  const { points, geometry } = a;
  assert.equal(points.length, 153);
  assert.equal(geometry.point_count, 153);
  assert.equal(new Set(points.map((p) => `${p.lat},${p.lng}`)).size, 153);
  // The business center is sampled exactly once, first.
  assert.deepEqual(points[0], lucas);
  assert.equal(points.filter((p) => distanceMiles(lucas, p) < 0.01).length, 1);
  assert.deepEqual(geometry.radii_miles, [1, 2, 5]);
  assert.equal(geometry.default_radius_miles, 5);
  assert.equal(geometry.version, "local-multiscale-v1");
  validateGrid({ ...config, points, geometry });
});
test("radius means distance from the center and tiers keep their spacing", () => {
  const { points } = localGrid(lucas);
  assert.deepEqual(
    [1, 2, 5].map((r) => withinRadius(points, lucas, r).length),
    [49, 85, 153],
  );
  assert.equal(withinRadius(points, lucas, null).length, 153);
  const d = points.map((p) => distanceMiles(lucas, p));
  assert.ok(Math.max(...d) <= 5.001);
  // Boundary points are geodesically on the ring, not a projection away from it.
  for (const r of [1, 2, 5]) {
    const ring = d.filter((x) => Math.abs(x - r) < 0.01);
    assert.ok(ring.length >= 4);
    for (const x of ring) assert.ok(Math.abs(x - r) < 0.00001);
  }
  // Each ring holds only its own lattice: nearest neighbour equals tier spacing.
  for (const [i, p] of points.entries()) {
    const nn = Math.min(
      ...points.filter((_, j) => j !== i).map((q) => distanceMiles(p, q)),
    );
    const tier = LOCAL_TIERS.find((t) => d[i] <= t.max_miles + 0.001);
    assert.ok(nn <= tier.spacing_miles + 0.001, `point ${i} too sparse`);
    assert.ok(nn >= 0.25 - 0.001, `point ${i} duplicated`);
  }
  // Exactly one mile north is inside 1 mi; the next lattice step is not.
  const north = points.find((p) => Math.abs(distanceMiles(lucas, p) - 1) < 0.00001 && p.lat > lucas.lat && Math.abs(p.lng - lucas.lng) < 1e-6);
  assert.ok(north);
  assert.equal(withinRadius([north], lucas, 1).length, 1);
  assert.equal(withinRadius([north], lucas, 0.99).length, 0);
});
test("scan preview and guards keep dense scans inside the 1,000-check budget", () => {
  const { points, geometry } = localGrid(lucas);
  const kw = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-a000-00000000001${i}`,
      keyword: `roof ${i}`,
    }));
  const preview = scanPreview({ points, keywords: kw(5) });
  assert.equal(preview.checks, 765);
  assert.equal(preview.estimatedCost.toFixed(3), "0.459");
  validateGrid({ ...config, points, geometry, keywords: kw(6) });
  assert.throws(() => validateGrid({ ...config, points, geometry, keywords: kw(7) }), /scan limit/);
  // Declared geometry must describe the points actually charged.
  assert.throws(() => validateGrid({ ...config, points: points.slice(1), geometry }), /geometry/);
  assert.throws(
    () => validateGrid({ ...config, points: [...points.slice(1), { lat: 38.9, lng: -90.8 }], geometry }),
    /outside declared radius/,
  );
  assert.throws(() => validateGrid({ ...config, points, geometry: { ...geometry, version: "v0" } }), /geometry/);
  // Old broad configs have no geometry and still validate unchanged.
  validateGrid({ ...config, geometry: null });
  assert.throws(() => localGrid(lucas, [{ max_miles: 1, spacing_miles: 0.3 }]));
  assert.throws(() => localGrid({ lat: NaN, lng: 0 }));
});
test("incomplete or inconsistent geometry metadata is refused before spending", () => {
  const { points, geometry } = localGrid(lucas);
  const drop = (k) => {
    const g = { ...geometry };
    delete g[k];
    return g;
  };
  const bad = [
    {},
    [],
    "local-multiscale-v1",
    drop("version"),
    drop("center"),
    drop("tiers"),
    drop("radii_miles"),
    drop("default_radius_miles"),
    drop("point_count"),
    { ...geometry, center: { lat: "38.8", lng: -90.8 } },
    { ...geometry, tiers: [] },
    { ...geometry, tiers: [{}], radii_miles: [5] },
    { ...geometry, tiers: [{ max_miles: 5 }], radii_miles: [5] },
    { ...geometry, tiers: [{ max_miles: 5, spacing_miles: 0 }], radii_miles: [5] },
    { ...geometry, tiers: [{ max_miles: 5, spacing_miles: 6 }], radii_miles: [5] },
    { ...geometry, tiers: [{ max_miles: Infinity, spacing_miles: 1 }], radii_miles: [Infinity] },
    { ...geometry, tiers: [...geometry.tiers.slice(0, 2), { max_miles: 2, spacing_miles: 1 }], radii_miles: [1, 2, 2] },
    { ...geometry, radii_miles: [1, 2] },
    { ...geometry, radii_miles: [1, 2, 4] },
    { ...geometry, default_radius_miles: 3 },
    { ...geometry, point_count: "153" },
  ];
  for (const g of bad) {
    assert.throws(() => validateGrid({ ...config, points, geometry: g }), undefined, JSON.stringify(g));
    assert.equal(usableGeometry({ points, geometry: g }), null);
  }
  // Legacy configs and the generated layout stay valid.
  for (const g of [undefined, null]) {
    validateGrid({ ...config, geometry: g });
    assert.equal(usableGeometry({ points: config.points, geometry: g }), null);
  }
  assert.equal(usableGeometry({ points, geometry }), geometry);
});
test("a market-centered grid is labelled and validated; business stays the default", () => {
  const wichita = { lat: 37.6922361, lng: -97.3375448 };
  const market = localGrid(wichita, undefined, { label: "Wichita, KS market center" });
  assert.equal(market.geometry.center_kind, "market");
  assert.equal(market.geometry.center_label, "Wichita, KS market center");
  assert.deepEqual(market.points, localGrid(wichita).points);
  validateGrid({ ...config, points: market.points, geometry: market.geometry });
  assert.deepEqual(centerDescription(market.geometry), {
    isBusiness: false,
    noun: "scan center",
    label: "Wichita, KS market center",
  });
  // Every geometry written so far has no center_kind and still means "business".
  const business = localGrid(lucas).geometry;
  assert.equal(business.center_kind, undefined);
  assert.equal(centerDescription(business).isBusiness, true);
  assert.equal(centerDescription(null).noun, "business");
  for (const [g, reason] of [
    [{ ...market.geometry, center_label: undefined }, /needs a center label/],
    [{ ...market.geometry, center_kind: "storefront" }, /Unknown grid center kind/],
    [{ ...market.geometry, center_label: "  " }, /center label/],
    [{ ...market.geometry, center_label: "x".repeat(81) }, /center label/],
    [{ ...market.geometry, center_label: 5 }, /center label/],
  ])
    assert.throws(() => validateGrid({ ...config, points: market.points, geometry: g }), reason);
  validateGrid({ ...config, points: market.points, geometry: { ...business, center: wichita, center_kind: "business" } });
});

// Edge kills an invocation at 2,000 ms CPU. Sizing from production
// (2026-10-15): ~5.4 ms per result parse (370 parses hit the cap), up to
// 62.5 ms per 100-task POST (500 ms for a 765-check run).
test("map-grid-sync v5 sizes every invocation by CPU, not wall clock", () => {
  const source = readFileSync("supabase/functions/map-grid-sync/index.ts", "utf8");
  const value = (name) =>
    Number(eval(source.match(new RegExp(`const ${name} = ([^;]+);`))[1]));
  assert.match(source, /const VERSION = "map-grid-v5";/);
  const worst =
    Math.ceil(1000 / value("POST_BATCH")) * 62.5 + value("COLLECT_TOTAL") * (2000 / 370);
  assert.ok(worst <= 1500, `a full 1,000-check post plus the read cap costs ~${worst} ms`);
  assert.ok(value("COLLECT_PER_RUN") <= value("COLLECT_TOTAL"));
  // A lease outlives one invocation (150 s wall clock) and lapses before the next 5-minute tick.
  assert.ok(value("LEASE_MS") > 150000 && value("LEASE_MS") < 300000);
  // weekly / collect only dispatch: the one processRuns call outside start is gone.
  const scheduler = source.slice(source.indexOf('if (body.mode === "weekly" || body.mode === "collect")'));
  assert.doesNotMatch(scheduler, /processRuns\(/);
  assert.match(scheduler, /mode: "start"/);
});
