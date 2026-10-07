"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { navItem, navTrack } from "@/lib/nav-styles";
import { useActiveInView } from "@/components/use-active-in-view";

const tabs = [
  { label: "Overview", segment: "" },
  { label: "Plan", segment: "plan" },
  { label: "Agreements", segment: "agreements" },
  { label: "Brand", segment: "brand" },
  { label: "Documents", segment: "documents" },
  { label: "Pipelines", segment: "pipelines" },
  { label: "Tasks", segment: "tasks" },
  { label: "Foundation", segment: "foundation" },
  { label: "Intelligence", segment: "intelligence" },
  { label: "Authority", segment: "authority" },
  { label: "Services", segment: "services" },
  { label: "Keywords", segment: "keywords" },
  { label: "Planner", segment: "planner" },
  { label: "Content", segment: "content" },
  { label: "Social", segment: "social" },
  { label: "Communications", segment: "communications" },
  { label: "Reports", segment: "reports" },
  { label: "Billing", segment: "billing" },
];

export function ClientTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;
  const railRef = useActiveInView<HTMLElement>(pathname);
  const railId = useId();
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const update = () => {
      const left = rail.scrollLeft > 1;
      const right = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
      setCanScroll((previous) =>
        previous.left === left && previous.right === right
          ? previous
          : { left, right }
      );
    };
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    for (const tab of rail.children) observer.observe(tab);
    rail.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      rail.removeEventListener("scroll", update);
    };
  }, [railRef]);

  function scrollTabs(direction: number) {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({
      left: direction * rail.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }

  const arrowClass =
    "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-royal-50 text-navy-900 ring-1 ring-royal-100 transition-colors hover:bg-royal-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-30";

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <button
        type="button"
        aria-label="Scroll client sections left"
        aria-controls={railId}
        disabled={!canScroll.left}
        onClick={() => scrollTabs(-1)}
        className={arrowClass}
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
      </button>
      <nav
        id={railId}
        ref={railRef}
        aria-label="Client sections"
        className={`${navTrack} min-w-0 flex-1`}
      >
        {tabs.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const active = tab.segment
            ? pathname.startsWith(href)
            : pathname === base;
          return (
            <Link
              key={tab.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={navItem(active)}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <button
        type="button"
        aria-label="Scroll client sections right"
        aria-controls={railId}
        disabled={!canScroll.right}
        onClick={() => scrollTabs(1)}
        className={arrowClass}
      >
        <ChevronRight className="size-5" aria-hidden="true" />
      </button>
    </div>
  );
}
