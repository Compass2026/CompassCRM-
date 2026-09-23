"use client";

import { useEffect, useRef } from "react";

// A nav rail scrolls sideways on phones; keep its current item in view.
// Only the rail's own scrollLeft moves, never the page.
export function useActiveInView<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const rail = ref.current;
    const active = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollLeft = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
  }, [key]);
  return ref;
}
