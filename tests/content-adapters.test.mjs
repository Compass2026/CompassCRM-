import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectContentContract, planMutation, assertWriteAllowed, describeAdapter, validateContentEntry, FOUNDATION_V1_SHA } from "../src/lib/content-adapters.ts";

const trees = JSON.parse(readFileSync(new URL("./fixtures/trees.json", import.meta.url), "utf8"));
// The accepted foundation's tree at 94014af35316c94616dadb3f8d606a4b68577fb0 (git ls-tree, brands/ lib/ app/ scripts/qa/).
const foundation = JSON.parse(readFileSync(new URL("./fixtures/foundation-94014af-tree.json", import.meta.url), "utf8"));

test("the accepted foundation tree: a recorded, registered, non-fictional brand is verified and the blog registry path is real", () => {
  const d = detectContentContract(foundation, { brand: "showme" }, { registeredBrands: ["showme", "harbor-lane"] });
  assert.equal(d.adapter, "foundation_brand_content");
  assert.equal(d.writable, true);
  assert.deepEqual(d.missing_inputs, []);
  assert.equal(d.paths.brand, "showme");
  assert.equal(d.paths.content_dir, "brands/showme/content");
  assert.deepEqual(d.foundation.brands, ["harbor-lane", "showme"]);
  // Every write path the adapter declares exists in the accepted tree.
  const desc = describeAdapter("foundation_brand_content", d.paths);
  for (const p of ["brands/showme/content/blog/index.ts", "brands/showme/content/cities/index.ts", "brands/showme/content/services/index.ts"]) {
    assert.ok(foundation.includes(p), `${p} missing from the 94014af tree`);
  }
  assert.match(desc.writes.blog_post, /content\/blog\/<slug>\.ts \+ registry entry in brands\/showme\/content\/blog\/index\.ts/);
  assert.ok(!foundation.some((p) => p.includes("/content/articles/")), "the foundation has no content/articles directory");
  assert.ok(desc.allowedPaths.includes("brands/showme/content/"));
});

test("no recorded brand: the client brand is never guessed, even when only one non-fictional brand exists", () => {
  const d = detectContentContract(foundation);
  assert.equal(d.adapter, "foundation_brand_content");
  assert.equal(d.writable, false);
  assert.equal(d.paths.brand, undefined);
  assert.equal(d.missing_inputs.length, 1);
  assert.match(d.missing_inputs[0], /content_paths\.brand is not recorded/);
  assert.match(d.missing_inputs[0], /showme/);
  assert.throws(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/blog/x.ts", "export const x = 1", d.paths), /no verified client brand/);
});

test("multiple real brands: an unrecorded brand is a specific missing input naming the candidates, not a pick", () => {
  const tree = [...foundation, "brands/ridge/site.config.ts", "brands/ridge/content/blog/index.ts"];
  const d = detectContentContract(tree, null, { registeredBrands: ["showme", "harbor-lane", "ridge"] });
  assert.equal(d.writable, false);
  assert.match(d.missing_inputs[0], /2 client brands \(ridge, showme\)/);
  const ok = detectContentContract(tree, { brand: "ridge" }, { registeredBrands: ["showme", "harbor-lane", "ridge"] });
  assert.equal(ok.writable, true);
  assert.equal(ok.paths.content_dir, "brands/ridge/content");
});

test("invalid recorded brands: missing from the tree, fictional, or unregistered — each a named missing input", () => {
  const gone = detectContentContract(foundation, { brand: "acme" });
  assert.equal(gone.writable, false);
  assert.match(gone.missing_inputs[0], /"acme" has no brands\/acme\/site\.config\.ts/);
  const fictional = detectContentContract(foundation, { brand: "harbor-lane" });
  assert.equal(fictional.writable, false);
  assert.match(fictional.missing_inputs[0], /fictional demonstration brand/);
  const unregistered = detectContentContract([...foundation, "brands/stray/site.config.ts"], { brand: "stray" }, { registeredBrands: ["showme", "harbor-lane"] });
  assert.equal(unregistered.writable, false);
  assert.match(unregistered.missing_inputs[0], /not registered in brands\/registry\.ts/);
});

test("legacy JSON contract (Lucas shape) resolves to lucas_json with pushes for data entries", () => {
  const d = detectContentContract(trees.lucas_json);
  assert.equal(d.adapter, "lucas_json");
  assert.equal(d.writable, true);
  assert.equal(planMutation("lucas_json", "city_page", d.paths).mode, "push");
  assert.equal(planMutation("lucas_json", "blog_post", d.paths).mode, "push");
  assert.equal(planMutation("lucas_json", "service_page", d.paths).mode, "pull_request");
});

test("Markdown blog shape (BHG) resolves to markdown_blog: blog pushes, city pages are proposed documents", () => {
  const d = detectContentContract(trees.markdown_blog);
  assert.equal(d.adapter, "markdown_blog");
  assert.equal(d.paths.blog_dir, "content/blog");
  assert.equal(d.paths.blog_format, "markdown");
  assert.equal(d.paths.city_route, "/locations/{state}/{city}");
  assert.equal(planMutation("markdown_blog", "blog_post", d.paths).mode, "push");
  assert.equal(planMutation("markdown_blog", "city_page", d.paths).mode, "proposed_document");
  assert.equal(planMutation("markdown_blog", "service_page", d.paths).mode, "pull_request");
});

test("an unknown contract (Vite SPA, Astro starter) is unsupported and every change is a proposed document", () => {
  for (const tree of [trees.vite_spa, trees.astro]) {
    const d = detectContentContract(tree);
    assert.equal(d.adapter, "unsupported");
    assert.equal(d.writable, false);
    for (const kind of ["city_page", "blog_post", "service_page", "faq_addition"]) {
      assert.equal(planMutation("unsupported", kind).mode, "proposed_document");
    }
  }
});

test("Foundation typed content is never mutated through JSON, another brand's path or the locations registry", () => {
  const paths = { brand: "showme", content_dir: "brands/showme/content" };
  assert.throws(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/cities/edwardsville.json", "{}", paths), /not JSON/);
  assert.throws(() => assertWriteAllowed("foundation_brand_content", "data/locations.json", "[]", paths), /outside/);
  assert.throws(() => assertWriteAllowed("foundation_brand_content", "brands/harbor-lane/content/cities/x.ts", "export const x = 1", paths), /outside/);
  assert.throws(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/locations/x.ts", "export const x = 1", paths), /separate registry/);
  assert.doesNotThrow(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/blog/new-post.ts", "export const x = 1", paths));
  assert.doesNotThrow(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/cities/edwardsville-il.ts", "export const x = 1", paths));
});

test("legacy JSON writes must parse and stay inside the contract", () => {
  assert.throws(() => assertWriteAllowed("lucas_json", "data/locations.json", "{not json"), /does not parse/);
  assert.throws(() => assertWriteAllowed("lucas_json", "src/components/Nav.tsx", "x"), /outside/);
  assert.doesNotThrow(() => assertWriteAllowed("lucas_json", "data/locations.json", "[]"));
});

test("the content-entry exception: data entries only, on the recorded adapter's push paths, with no deletions", () => {
  assert.equal(validateContentEntry("lucas_json", {}, ["data/blog-posts.json"]).ok, true);
  assert.equal(validateContentEntry("lucas_json", {}, ["data/locations.json", "data/blog-posts.json"]).ok, true);
  assert.equal(validateContentEntry("lucas_json", {}, ["src/app/page.tsx", "src/components/Header.tsx"]).ok, false);
  assert.equal(validateContentEntry("lucas_json", {}, ["data/blog-posts.json", "src/app/layout.tsx"]).ok, false);
  assert.equal(validateContentEntry("lucas_json", {}, ["data/blog-posts.json"], ["src/app/layout.tsx"]).ok, false);
  assert.equal(validateContentEntry("lucas_json", {}, ["src/app/services/roofing/page.tsx"]).ok, false, "service pages are pull requests");
  assert.equal(validateContentEntry("markdown_blog", { blog_dir: "content/blog" }, ["content/blog/new-post.mdx"]).ok, true);
  assert.equal(validateContentEntry("markdown_blog", { blog_dir: "content/blog" }, ["data/locations.json"]).ok, false, "city entries on this shape are proposed documents");
  assert.equal(validateContentEntry("foundation_brand_content", { brand: "showme" }, ["brands/showme/content/blog/x.ts"]).ok, false, "typed content is pull requests only");
  assert.equal(validateContentEntry("unsupported", {}, ["anything.txt"]).ok, false);
  assert.equal(validateContentEntry(null, null, ["data/blog-posts.json"]).ok, false);
  assert.equal(validateContentEntry("lucas_json", {}, []).ok, false);
});

test("every adapter describes its verification and the Foundation pins the accepted SHA", () => {
  for (const key of ["foundation_brand_content", "lucas_json", "markdown_blog"]) assert.ok(describeAdapter(key).verify.length > 0);
  assert.equal(describeAdapter("unsupported").verify.length, 0);
  assert.equal(FOUNDATION_V1_SHA, "94014af35316c94616dadb3f8d606a4b68577fb0");
});
