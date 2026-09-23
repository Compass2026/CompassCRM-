"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItem, navTrack } from "@/lib/nav-styles";
import { useActiveInView } from "@/components/use-active-in-view";

const tabs = [
  { label: "Overview", segment: "" },
  { label: "Plan", segment: "plan" },
  { label: "Brand", segment: "brand" },
  { label: "Documents", segment: "documents" },
  { label: "Pipelines", segment: "pipelines" },
  { label: "Tasks", segment: "tasks" },
  { label: "Foundation", segment: "foundation" },
  { label: "Intelligence", segment: "intelligence" },
  { label: "Services", segment: "services" },
  { label: "Keywords", segment: "keywords" },
  { label: "Content", segment: "content" },
  { label: "Social", segment: "social" },
  { label: "Reports", segment: "reports" },
  { label: "Billing", segment: "billing" },
];

export function ClientTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;
  const railRef = useActiveInView<HTMLElement>(pathname);

  return (
    <nav ref={railRef} aria-label="Client sections" className={navTrack}>
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
  );
}
