"use client";

import { useState } from "react";
import {
  deleteGridConfigAction,
  upsertGridConfigAction,
} from "@/app/rank-actions";
import { gridForRadius } from "@/lib/geo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type GridConfig = {
  id: string;
  grid_size: number;
  spacing_miles: number;
  center_lat: number | null;
  center_lng: number | null;
  keyword_ids: string[];
  is_active: boolean;
};

export function GridConfigCard({
  clientId,
  locationId,
  locationName,
  locationLat,
  locationLng,
  config,
  activeKeywordCount,
}: {
  clientId: string;
  locationId: string;
  locationName: string;
  locationLat: number | null;
  locationLng: number | null;
  config: GridConfig | null;
  activeKeywordCount: number;
}) {
  const [gridSize, setGridSize] = useState(String(config?.grid_size ?? 7));
  const [spacing, setSpacing] = useState(String(config?.spacing_miles ?? 1));
  const [radius, setRadius] = useState("");

  const spanMiles =
    ((Number(gridSize) || 7) - 1) * (Number(spacing) || 0) / 2;

  function applyRadius() {
    const r = Number(radius);
    if (!r || r <= 0) return;
    const derived = gridForRadius(r);
    setGridSize(String(derived.grid_size));
    setSpacing(String(derived.spacing_miles));
  }

  return (
    <div className="border rounded-md p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{locationName}</p>
        {config && (
          <form action={deleteGridConfigAction.bind(null, clientId, config.id)}>
            <Button variant="ghost" size="sm" type="submit">
              Remove grid
            </Button>
          </form>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Radius helper (mi)</Label>
          <Input
            type="number"
            step="0.5"
            min="1"
            max="25"
            placeholder="5"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
            className="h-8 w-24"
          />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={applyRadius}>
          Set grid from radius
        </Button>
      </div>

      <form
        action={upsertGridConfigAction.bind(null, clientId, locationId)}
        className="flex items-end gap-2 flex-wrap"
      >
        <div className="space-y-1">
          <Label className="text-xs">Grid</Label>
          <select
            name="grid_size"
            value={gridSize}
            onChange={(e) => setGridSize(e.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="5">5×5</option>
            <option value="7">7×7</option>
            <option value="9">9×9</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Spacing (mi)</Label>
          <Input
            name="spacing_miles"
            type="number"
            step="0.1"
            min="0.5"
            value={spacing}
            onChange={(e) => setSpacing(e.target.value)}
            className="h-8 w-24"
          />
        </div>
        <input
          type="hidden"
          name="center_lat"
          value={config?.center_lat ?? locationLat ?? ""}
        />
        <input
          type="hidden"
          name="center_lng"
          value={config?.center_lng ?? locationLng ?? ""}
        />
        <Button type="submit" size="sm">
          {config ? "Update grid" : "Create grid"}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        Covers ~{Math.round(spanMiles * 10) / 10} miles out from center
        {config
          ? ` · tracking ${config.keyword_ids.length} keyword${config.keyword_ids.length === 1 ? "" : "s"}`
          : ` · will track all ${activeKeywordCount} active keyword${activeKeywordCount === 1 ? "" : "s"}`}
        {locationLat == null && " · ⚠ no coordinates on this location"}
      </p>
    </div>
  );
}
