import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgreementEmail } from "../src/lib/agreement-email.ts";

const origin = "https://compass.example.test";
const url = `${origin}/sign/${"a".repeat(43)}`;
const contract = {
  title: "Marketing Services Agreement",
  recipient_name: "Fictional Recipient",
  snapshot: {
    issuer_name: "Compass Marketing Advisors LLC",
    scope: { client_name: "Fictional Client", plan: { amount_cents: 50000, currency: "usd", interval: "month", interval_count: 1, term_months: null }, services: [] },
  },
};

test("delivery uses saved scope and preserves separate payment authorization", () => {
  const before = JSON.stringify(contract);
  const email = buildAgreementEmail(contract, origin, url);
  assert.match(email.html, /\$500\.00 \/ month/);
  assert.match(email.text, /\$500\.00 \/ month/);
  assert.match(email.html, /Month-to-month/);
  assert.match(email.html, /Signing does not authorize payment/);
  assert.match(email.text, /Verify your email/);
  assert.equal((email.html.match(/href=/g) ?? []).length, 2);
  assert.ok(email.html.includes(`href="${url}"`));
  assert.ok(email.text.includes(url));
  assert.ok(email.html.includes(`${origin}/compass-agreement-logo.png`));
  assert.equal(JSON.stringify(contract), before);
});

test("preview is inert and retains the same client, price, subject and payment copy", () => {
  const preview = buildAgreementEmail(contract, origin, null);
  const delivery = buildAgreementEmail(contract, origin, url);
  assert.equal(preview.subject, delivery.subject);
  assert.doesNotMatch(preview.html, /href=|<script|<form|\/sign\//);
  assert.doesNotMatch(preview.text, /\/sign\//);
  assert.match(preview.html, /Fictional Client/);
  assert.match(preview.html, /\$500\.00 \/ month/);
});

test("all interpolated customer content is escaped in HTML", () => {
  const hostile = structuredClone(contract);
  hostile.recipient_name = '<img src=x onerror="alert(1)">';
  hostile.title = '<script>alert("x")</script>';
  hostile.snapshot.scope.client_name = "A & B <Company>";
  hostile.snapshot.issuer_name = "Issuer <svg onload='alert(1)'>";
  const email = buildAgreementEmail(hostile, origin, url);
  assert.doesNotMatch(email.html, /<script|<svg|<img src=x/);
  assert.match(email.html, /A &amp; B &lt;Company&gt;/);
  assert.match(email.html, /&quot;alert\(1\)&quot;/);
});

test("fee and term adapt to the agreement instead of using BHG constants", () => {
  const other = structuredClone(contract);
  Object.assign(other.snapshot.scope.plan, { amount_cents: 195000, interval_count: 3, term_months: 12 });
  const email = buildAgreementEmail(other, origin, url);
  assert.match(email.text, /\$1,950\.00 \/ 3 months/);
  assert.match(email.html, /12 months/);
});

test("delivery rejects noncanonical signing URLs", () => {
  for (const bad of ["javascript:alert(1)", url.replace(origin, "https://other.example.test"), `${url}?tracking=1`, `${url}#fragment`, `${origin}/sign/short`]) {
    assert.throws(() => buildAgreementEmail(contract, origin, bad));
  }
});
