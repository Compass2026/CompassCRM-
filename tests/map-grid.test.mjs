import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGrid,
  mapTask,
  parseMapsTask,
  gridMetrics,
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
