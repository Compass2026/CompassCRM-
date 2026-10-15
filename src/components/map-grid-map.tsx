"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import {
  distanceMiles,
  rankColor,
  type GridCheck,
  type GridPoint,
} from "@/lib/map-grid";
import "leaflet/dist/leaflet.css";

const METERS_PER_MILE = 1609.344;
// Spacing to its nearest sampled neighbour sizes each marker, so the dense
// inner lattice shrinks to dots when zoomed out instead of piling up.
function nearestSpacing(points: GridPoint[]) {
  return points.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < points.length; j++)
      if (j !== i) best = Math.min(best, distanceMiles(p, points[j]));
    return Number.isFinite(best) ? best : 10;
  });
}
function markerSize(spacingMiles: number, lat: number, zoom: number) {
  const metersPerPx =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const px = (spacingMiles * METERS_PER_MILE) / metersPerPx;
  return Math.max(12, Math.min(38, Math.round(px * 0.85)));
}

export default function MapGridMap({
  checks,
  onSelect,
  center,
  radiusMiles,
  rings,
  datasetKey,
  centerLabel = "Business location",
}: {
  checks: GridCheck[];
  onSelect: (check: GridCheck) => void;
  center: GridPoint | null;
  // null = the scan's full extent.
  radiusMiles: number | null;
  rings: number[];
  // What the center is: the business, or a named market center.
  centerLabel?: string;
  // Changes only on a deliberate source switch; refits to that dataset's extent.
  datasetKey: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const leaflet = useRef<{
    L: typeof Leaflet;
    map: Leaflet.Map;
    markers: Leaflet.LayerGroup;
    overlay: Leaflet.LayerGroup;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(13);
  const spacing = useMemo(() => nearestSpacing(checks), [checks]);

  // The map is created once. Routine refreshes and resizes never refit it,
  // so a manual zoom or pan survives the 15-second polling during a scan.
  useEffect(() => {
    let disposed = false;
    let cleanup: undefined | (() => void);
    void import("leaflet").then((L) => {
      if (disposed || !container.current) return;
      const el = container.current;
      const map = L.map(el, {
        scrollWheelZoom: false,
        zoomSnap: 0.5,
        maxZoom: 18,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const overlay = L.layerGroup().addTo(map);
      const markers = L.layerGroup().addTo(map);
      const sync = () => {
        const c = map.getCenter();
        el.dataset.zoom = String(map.getZoom());
        el.dataset.center = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
        setZoom(map.getZoom());
      };
      map.on("zoomend moveend", sync);
      // Instant re-centering: an animated pan still running when the map is
      // removed (a location switch during a layout shift) throws in Leaflet.
      const resize = new ResizeObserver(() =>
        map.invalidateSize({ animate: false }),
      );
      resize.observe(el);
      leaflet.current = { L, map, markers, overlay };
      setReady(true);
      cleanup = () => {
        resize.disconnect();
        map.stop();
        map.remove();
        leaflet.current = null;
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // Deliberate radius or source changes (and the first render) fit the view,
  // even when the new dataset happens to share the radius and center.
  const fitKey = `${datasetKey}|${radiusMiles ?? "all"}:${center?.lat},${center?.lng}`;
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const l = leaflet.current;
    if (!ready || !l || fitted.current === fitKey) return;
    if (!checks.length && !center) return;
    fitted.current = fitKey;
    const bounds =
      center && radiusMiles !== null
        ? l.L.latLng(center.lat, center.lng).toBounds(
            radiusMiles * 2 * METERS_PER_MILE,
          )
        : l.L.latLngBounds([
            ...checks.map((c) => [c.lat, c.lng] as [number, number]),
            ...(center ? [[center.lat, center.lng] as [number, number]] : []),
          ]);
    l.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false });
  }, [ready, fitKey, checks, center, radiusMiles]);

  const minSpacing = useMemo(
    () => (spacing.length ? Math.min(...spacing) : 1),
    [spacing],
  );
  useEffect(() => {
    const l = leaflet.current;
    if (!ready || !l) return;
    l.overlay.clearLayers();
    if (!center) return;
    for (const r of rings) {
      l.L.circle([center.lat, center.lng], {
        radius: r * METERS_PER_MILE,
        color: "#0b162a",
        weight: 1.5,
        dashArray: "6 6",
        fill: false,
        interactive: false,
      }).addTo(l.overlay);
      // Labelled on the ring's edge, between the lattice points that sit on it.
      const bearing = Math.PI / 8;
      const label = document.createElement("div");
      label.setAttribute("data-testid", "ring-label");
      label.textContent = `${r} mi`;
      label.style.cssText =
        "display:inline-block;padding:1px 6px;border-radius:9999px;background:#0b162a;color:white;font:600 11px/16px system-ui,sans-serif;white-space:nowrap;transform:translate(-50%,-50%)";
      l.L.marker(
        [
          center.lat + (r * Math.cos(bearing)) / 69.05,
          center.lng +
            (r * Math.sin(bearing)) /
              (69.17 * Math.cos((center.lat * Math.PI) / 180)),
        ],
        {
          icon: l.L.divIcon({ html: label, className: "", iconSize: [0, 0] }),
          interactive: false,
          keyboard: false,
          zIndexOffset: 2000,
        },
      ).addTo(l.overlay);
    }
    // A halo around the center point keeps the business visible at any zoom
    // without covering the rank sampled there.
    const halo = markerSize(minSpacing, center.lat, zoom) + 16;
    const pin = document.createElement("div");
    pin.setAttribute("data-testid", "business-center");
    pin.style.cssText = `width:${halo}px;height:${halo}px;border-radius:50%;border:4px solid #f97316;box-shadow:0 0 0 2px white,inset 0 0 0 2px white`;
    l.L.marker([center.lat, center.lng], {
      icon: l.L.divIcon({
        html: pin,
        className: "",
        iconSize: [halo, halo],
        iconAnchor: [halo / 2, halo / 2],
      }),
      title: `${centerLabel} (scan center)`,
      alt: centerLabel,
      interactive: false,
      keyboard: false,
      zIndexOffset: -1000,
    }).addTo(l.overlay);
  }, [ready, center, rings, minSpacing, zoom, centerLabel]);

  useEffect(() => {
    const l = leaflet.current;
    if (!ready || !l) return;
    l.markers.clearLayers();
    checks.forEach((c, i) => {
      const label =
        c.state === "complete"
          ? c.position === null
            ? "100+"
            : String(c.position)
          : "?";
      const size = markerSize(spacing[i], c.lat, zoom);
      const element = document.createElement("div");
      // Below this size a number cannot be read; the title and side panel carry it.
      element.textContent = size >= 22 ? label : "";
      element.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;display:grid;place-items:center;background:${rankColor(c.state, c.position)};color:white;font-weight:800;font-size:${size >= 30 ? 13 : 11}px;border:${size >= 22 ? 3 : 2}px solid white;box-shadow:0 2px 8px #0005`;
      l.L.marker([c.lat, c.lng], {
        icon: l.L.divIcon({
          html: element,
          className: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        title: `Point ${c.point_index + 1}: ${label}`,
        alt: `Point ${c.point_index + 1}: rank ${label}`,
        keyboard: true,
      })
        .addTo(l.markers)
        .on("click", () => onSelect(c));
    });
  }, [ready, checks, spacing, zoom, onSelect]);

  return (
    <div
      ref={container}
      className="relative z-0 h-[480px] w-full rounded-2xl bg-slate-100 sm:h-[570px]"
      aria-label="Geographic ranking map"
      data-testid="map-grid-map"
    />
  );
}
