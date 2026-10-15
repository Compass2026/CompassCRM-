"use client";
import { useEffect, useRef } from "react";
import { rankColor, type GridCheck } from "@/lib/map-grid";
import "leaflet/dist/leaflet.css";

export default function MapGridMap({
  checks,
  onSelect,
}: {
  checks: GridCheck[];
  onSelect: (check: GridCheck) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: undefined | (() => void);
    void import("leaflet").then((L) => {
      if (disposed || !container.current || !checks.length) return;
      const map = L.map(container.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const bounds = L.latLngBounds(
        checks.map((c) => [c.lat, c.lng] as [number, number]),
      );
      map.fitBounds(bounds, { padding: [35, 35], maxZoom: 13 });
      for (const c of checks) {
        const label =
          c.state === "complete"
            ? c.position === null
              ? "100+"
              : String(c.position)
            : "?";
        const element = document.createElement("div");
        element.textContent = label;
        element.style.cssText = `width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:${rankColor(c.state, c.position)};color:white;font-weight:800;font-size:13px;border:3px solid white;box-shadow:0 2px 8px #0005`;
        L.marker([c.lat, c.lng], {
          icon: L.divIcon({
            html: element,
            className: "",
            iconSize: [38, 38],
            iconAnchor: [19, 19],
          }),
          title: `Point ${c.point_index + 1}: ${label}`,
          alt: `Point ${c.point_index + 1}: rank ${label}`,
          keyboard: true,
        })
          .addTo(map)
          .on("click", () => onSelect(c));
      }
      const resize = new ResizeObserver(() => map.invalidateSize());
      resize.observe(container.current);
      cleanup = () => {
        resize.disconnect();
        map.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [checks, onSelect]);
  return (
    <div
      ref={container}
      className="relative z-0 h-[480px] w-full rounded-2xl bg-slate-100 sm:h-[570px]"
      aria-label="Geographic ranking map"
    />
  );
}
