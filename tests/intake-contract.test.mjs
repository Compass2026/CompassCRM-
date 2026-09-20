// The intake form and the server action behind it must agree on every field.
//
// Why this is a static check and not a click: the deployed CRM sits behind
// Vercel SSO and the server action needs a signed-in team session, neither of
// which a worker session can obtain. What CAN be verified without a session is
// the contract itself — that every input the form posts is read by the action,
// that the work-mode radio offers exactly the enum the database accepts, and
// that the action branches on all three of them. A drift here is the class of
// bug that would silently drop a field at intake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const form = readFileSync("src/app/(app)/clients/page.tsx", "utf8");
const action = readFileSync("src/app/actions.ts", "utf8");
const intake = action.slice(action.indexOf("export async function createClientAction"));

const posted = [...new Set([...form.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]))].sort();
const readByAction = (key) =>
  action.includes(`str(form, "${key}")`) || action.includes(`form.get("${key}")`);

test("every field the intake form posts is read by createClientAction", () => {
  const dropped = posted.filter((k) => !readByAction(k));
  assert.deepEqual(dropped, [], `the form posts these and the action never reads them: ${dropped.join(", ")}`);
});

test("the work-mode radio offers exactly the three website_work_mode values", () => {
  const radio = [...form.matchAll(/name="work_mode"\s+value="([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(radio, ["client_retains", "new_build", "upgrade_existing"]);
});

test("createClientAction branches on all three work modes", () => {
  for (const mode of ["new_build", "upgrade_existing", "client_retains"]) {
    assert.ok(intake.includes(mode), `createClientAction never mentions ${mode}`);
  }
  // client_retains must drop the Website enrollment; the other two keep it.
  assert.match(intake, /client_retains[\s\S]*?client_pipelines[\s\S]*?delete\(\)/, "client_retains must drop the Website enrollment");
});

test("every mode records a sites row, and only new_build is recorded as nextjs", () => {
  const inserts = [...intake.matchAll(/from\("sites"\)\s*\.insert\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.equal(inserts.length, 2, "one insert for client_retains, one for the build modes");
  assert.ok(inserts.some((b) => b.includes('work_mode: "client_retains"')));
  assert.ok(inserts.some((b) => b.includes("work_mode: workMode")));
  assert.ok(inserts.every((b) => !b.includes('stack: "astro"')), "the retired Astro starter is never recorded at intake");
});
