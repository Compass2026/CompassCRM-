"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { registerAssetAction } from "@/app/brand-actions";
import { BRAND_BUCKET } from "@/lib/brand";
import { brandAssetKindLabels, brandAssetKinds, type BrandAssetKind } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs";

type Progress = { name: string; state: "uploading" | "done" | "error"; detail?: string };

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
}

async function imageSize(file: File): Promise<{ width: number | null; height: number | null }> {
  if (!file.type.startsWith("image/")) return { width: null, height: null };
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Drag-and-drop / multi-file uploader. Files go straight from the browser to
 * the private `brand-assets` bucket (so large photos and screenshots aren't
 * limited by the server action body size), then a server action records the
 * row.
 */
export function BrandAssetUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<BrandAssetKind>("photo");
  const [label, setLabel] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [pending, startTransition] = useTransition();

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    const supabase = createClient();
    setProgress(files.map((f) => ({ name: f.name, state: "uploading" })));

    for (const [i, file] of files.entries()) {
      const update = (state: Progress["state"], detail?: string) =>
        setProgress((p) => p.map((row, j) => (j === i ? { ...row, state, detail } : row)));
      try {
        const path = `${clientId}/${Date.now()}-${i}-${slug(file.name) || "file"}`;
        const { error } = await supabase.storage
          .from(BRAND_BUCKET)
          .upload(path, file, { contentType: file.type || undefined, upsert: false });
        if (error) throw new Error(error.message);
        const { width, height } = await imageSize(file);
        await registerAssetAction(clientId, {
          storage_path: path,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: file.size,
          kind,
          label: files.length === 1 && label ? label : label ? `${label} ${i + 1}` : file.name,
          width,
          height,
        });
        update("done");
      } catch (e) {
        update("error", e instanceof Error ? e.message : "Upload failed");
      }
    }

    setLabel("");
    if (inputRef.current) inputRef.current.value = "";
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="asset-kind">Type</Label>
          <select
            id="asset-kind"
            className={`${selectClass} w-full`}
            value={kind}
            onChange={(e) => setKind(e.target.value as BrandAssetKind)}
          >
            {brandAssetKinds.map((k) => (
              <option key={k} value={k}>
                {brandAssetKindLabels[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-label">Label (optional)</Label>
          <Input
            id="asset-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Homepage hero, Instagram post"
          />
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          uploadFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors",
          dragging ? "border-primary bg-accent" : "border-border bg-muted/30"
        )}
      >
        <p className="text-muted-foreground">
          Drag &amp; drop logos, photos, website or social screenshots here — anything
          that shows the brand. Multiple files are fine.
        </p>
        <div className="mt-3 flex items-center justify-center gap-2">
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => uploadFiles(Array.from(e.target.files ?? []))}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
          >
            Choose files
          </Button>
        </div>
      </div>

      {progress.length > 0 && (
        <ul className="text-xs space-y-1">
          {progress.map((p, i) => (
            <li
              key={i}
              className={cn(
                p.state === "error" && "text-destructive",
                p.state === "done" && "text-muted-foreground"
              )}
            >
              {p.state === "uploading" ? "⏳" : p.state === "done" ? "✓" : "✕"} {p.name}
              {p.detail ? ` — ${p.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
