// Architecture check (B5): the Five Layer systems — Client Intelligence, the
// Authority Engine and its runs, the AI Drafter, the Business Profile
// publisher, Creative / source assets — and the entitlement contract they may
// read never reference Stripe or a billing table, and never import billing
// code. Billing reaches them only as "what the agreement includes", through
// client_entitlements_for() (which itself reads no billing table; checked in
// SQL by billing_entitlements_portal.test.sql X1 and 0062's verify block).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FIVE_LAYER = [
  "supabase/functions/authority",
  "supabase/functions/authority-run",
  "supabase/functions/post-drafter",
  "supabase/functions/post-publisher",
  "supabase/functions/source-assets",
  "src/components/authority",
  "src/components/creative-use",
  "src/lib/client-intelligence.ts",
  "src/lib/authority-agreement.ts",
  "src/lib/authority-controls.ts",
  "src/lib/authority-decisions.ts",
  "src/lib/authority-draft.ts",
  "src/lib/authority-lifecycle.ts",
  "src/lib/authority-reconcile.ts",
  "src/lib/authority-run-call.ts",
  "src/lib/authority-view.ts",
  "src/lib/drafter-run.ts",
  "src/lib/creative-use.ts",
  "src/lib/publisher.ts",
  "src/lib/social-posts.ts",
  "src/lib/entitlements.ts",
  "src/lib/reporting-activity.ts",
  "src/app/(app)/clients/[clientId]/authority",
  "src/app/(app)/clients/[clientId]/intelligence",
  "src/app/authority-actions.ts",
  "src/app/authority-decision-actions.ts",
  "src/app/authority-draft-actions.ts",
  "src/app/creative-use-actions.ts",
];
// Billing's tables, views and functions (0058–0061), and Stripe itself.
const FORBIDDEN = /\bstripe|\b(subscriptions|subscription_items|invoices|invoice_line_items|payments|checkout_sessions|client_billing_status|billing_attention|attention_reasons|billing_packages|billing_package_prices|billing_one_time_items|billing_audit_events|billing_reconciliation_\w+|client_billing_reconciliation|billing_sync_health|billing_livemode|plans)\b/i;
const FORBIDDEN_IMPORT = /from\s+["'][^"']*(billing|stripe)[^"']*["']/i;

function files(p) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { recursive: true }).map((f) => path.join(abs, f))
    .filter((f) => fs.statSync(f).isFile() && /\.(ts|tsx|mjs|js|sql)$/.test(f));
}
// Code only: comments may explain the boundary ("never reads billing").
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/^\s*--.*$/gm, "");

test("19 Five Layer systems reference no Stripe or billing table and import no billing code", () => {
  const all = FIVE_LAYER.flatMap(files);
  assert.ok(all.length > 40, `expected the Five Layer sources, found ${all.length}`);
  const hits = [];
  for (const f of all) {
    const src = code(fs.readFileSync(f, "utf8"));
    src.split("\n").forEach((line, i) => {
      if (FORBIDDEN.test(line) || FORBIDDEN_IMPORT.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("19b the check itself catches a billing read", () => {
  assert.ok(FORBIDDEN.test(`supabase.from("client_billing_status")`));
  assert.ok(FORBIDDEN.test(`select * from invoices`));
  assert.ok(FORBIDDEN_IMPORT.test(`import { x } from "@/lib/stripe-billing-call";`));
  assert.ok(!FORBIDDEN.test(`supabase.rpc("client_entitlements_for", { p_client_id })`));
});
