import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectContentContract, planMutation, assertWriteAllowed, describeAdapter, FOUNDATION_V1_SHA } from "../src/lib/content-adapters.ts";

const trees = JSON.parse(readFileSync(new URL("./fixtures/trees.json", import.meta.url), "utf8"));

test("Foundation typed brand content is detected from the actual tree and names the brand", () => {
  const d = detectContentContract(trees.foundation);
  assert.equal(d.adapter, "foundation_brand_content");
  assert.equal(d.paths.brand, "showme"); // the fictional demo brand is never chosen
  assert.equal(d.foundation?.version, "v1");
  assert.equal(d.paths.city_route, "/service-area/{slug}");
});

test("the recorded brand wins when the tree carries it", () => {
  const d = detectContentContract(trees.foundation, { brand: "harbor-lane" });
  assert.equal(d.paths.brand, "harbor-lane");
});

test("legacy JSON contract (Lucas shape) resolves to lucas_json with pushes for data entries", () => {
  const d = detectContentContract(trees.lucas_json);
  assert.equal(d.adapter, "lucas_json");
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
  assert.doesNotThrow(() => assertWriteAllowed("foundation_brand_content", "brands/showme/content/cities/edwardsville-il.ts", "export const x = 1", paths));
});

test("legacy JSON writes must parse and stay inside the contract", () => {
  assert.throws(() => assertWriteAllowed("lucas_json", "data/locations.json", "{not json"), /does not parse/);
  assert.throws(() => assertWriteAllowed("lucas_json", "src/components/Nav.tsx", "x"), /outside/);
  assert.doesNotThrow(() => assertWriteAllowed("lucas_json", "data/locations.json", "[]"));
});

test("every adapter describes its verification and the Foundation pins the accepted SHA", () => {
  for (const key of ["foundation_brand_content", "lucas_json", "markdown_blog"]) assert.ok(describeAdapter(key).verify.length > 0);
  assert.equal(describeAdapter("unsupported").verify.length, 0);
  assert.equal(FOUNDATION_V1_SHA, "94014af35316c94616dadb3f8d606a4b68577fb0");
});
