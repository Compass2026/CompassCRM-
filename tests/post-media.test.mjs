// Post media previews: the reviewer sees the saved file the post carries, or a
// plain error, never an empty section or a substitute image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaPreview, noGraphicLine } from "../src/lib/post-media.ts";

const signed = new Map([["lucas/photo-11.jpg", "https://x.supabase.co/storage/v1/object/sign/brand-assets/lucas/photo-11.jpg?token=t"]]);

test("a stored asset shows its signed storage file, even when it also has a link", () => {
  assert.deepEqual(mediaPreview({ storage_path: "lucas/photo-11.jpg", url: "https://lucasconstructionmo.com/a.jpg" }, signed), {
    kind: "image",
    src: signed.get("lucas/photo-11.jpg"),
    origin: "storage",
  });
});

test("a stored asset that cannot be signed is an actionable error, not a fallback to another image", () => {
  const missing = mediaPreview({ storage_path: "lucas/gone.jpg", url: "https://lucasconstructionmo.com/a.jpg" }, signed);
  assert.equal(missing.kind, "error");
  assert.match(missing.message, /could not be found.*Brand → Assets/);
  const failed = mediaPreview({ storage_path: "lucas/photo-11.jpg", url: null }, new Map(), "Bucket not found");
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /could not be loaded from storage \(Bucket not found\)/);
});

test("a link-only asset shows its https link; anything else is an error", () => {
  assert.deepEqual(mediaPreview({ storage_path: null, url: "https://lucasconstructionmo.com/a.jpg" }, signed), {
    kind: "image",
    src: "https://lucasconstructionmo.com/a.jpg",
    origin: "link",
  });
  assert.equal(mediaPreview({ storage_path: null, url: "http://insecure.example/a.jpg" }, signed).kind, "error");
  assert.equal(mediaPreview({ storage_path: null, url: null }, signed).kind, "error");
});

test("no rendered graphic is not the same as no image", () => {
  assert.equal(noGraphicLine("none", 1), "No rendered graphic: the post uses the attached photo (see Media).");
  assert.equal(noGraphicLine("optional", 3), "No rendered graphic: the post uses the 3 attached photos (see Media).");
  assert.equal(noGraphicLine("none", 0), "This post goes out without a rendered graphic or photo.");
  assert.equal(noGraphicLine("required", 0), "No graphic is linked yet.");
});
