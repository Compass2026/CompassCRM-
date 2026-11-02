import test from "node:test";
import assert from "node:assert/strict";
import {
  inquiryWebsite,
  workspaceSummary,
  filterWorkspace,
} from "../src/lib/client-workspace.ts";
const now = Date.parse("2026-10-31T12:00:00Z");
const rows = [
  {
    id: "a",
    name: "Sam",
    email: "sam@example.test",
    phone: null,
    status: "new",
    page_url: "https://www.safety.example/contact",
    received_at: "2026-10-30T12:00:00Z",
    message: "On-site training",
  },
  {
    id: "b",
    name: "Alex",
    email: "alex@example.test",
    phone: "5551230000",
    status: "contacted",
    page_url: "https://forklift.example/contact",
    received_at: "2026-10-01T12:00:00Z",
    message: "Forklift quote",
  },
  {
    id: "c",
    name: "Test",
    email: null,
    phone: null,
    status: "closed",
    page_url: null,
    received_at: "2026-11-01T12:00:00Z",
    message: "System test",
  },
];
test("website display accepts only HTTP URLs and uses host, not credentials or page paths", () => {
  assert.equal(
    inquiryWebsite("https://name:password@www.safety.example/private?q=token"),
    "safety.example",
  );
  for (const value of [
    null,
    "javascript:alert(1)",
    "file:///tmp/test",
    "not a url",
  ])
    assert.equal(inquiryWebsite(value), "Website not recorded");
});
test("summary counts records without pretending they are qualified, with a bounded trailing window", () => {
  const summary = workspaceSummary(rows, now);
  assert.equal(summary.total, 3);
  assert.equal(summary.lastSevenDays, 1);
  assert.deepEqual(summary.statuses, { new: 1, contacted: 1, closed: 1 });
  assert.deepEqual(summary.websites, {
    "safety.example": 1,
    "forklift.example": 1,
    "Website not recorded": 1,
  });
});
test("combined filters cannot reintroduce rows outside the provided authorized records", () => {
  assert.deepEqual(
    filterWorkspace(rows, " TRAINING ", "new", "safety.example").map(
      (x) => x.id,
    ),
    ["a"],
  );
  assert.deepEqual(filterWorkspace(rows, "sam", "new", "forklift.example"), []);
  assert.deepEqual(
    filterWorkspace(rows, "555123", "", "").map((x) => x.id),
    ["b"],
  );
  assert.deepEqual(filterWorkspace(rows, "", "", "another-client.example"), []);
  assert.equal(filterWorkspace([], "", "", "").length, 0);
});
