"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "Overview", segment: "" },
  { label: "Plan", segment: "plan" },
  { label: "Documents", segment: "documents" },
  { label: "Pipelines", segment: "pipelines" },
  { label: "Keywords", segment: "keywords" },
  { label: "Content", segment: "content" },
  { label: "Social", segment: "social" },
  { label: "Reports", segment: "reports" },
  { label: "Billing", segment: "billing" },
];

export function ClientTabs({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}`;

  return (
    <nav className="flex gap-1 border-b overflow-x-auto">
      {tabs.map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const active = tab.segment
          ? pathname.startsWith(href)
          : pathname === base;
        return (
          <Link
            key={tab.label}
            href={href}
            className={cn(
              "px-3 py-2 font-heading text-sm whitespace-nowrap border-b-2 -mb-px transition-colors",
              active
                ? "border-primary font-semibold text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
