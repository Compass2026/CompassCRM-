"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "Overview", segment: "" },
  { label: "Progress", segment: "growth" },
  { label: "Backlinks", segment: "backlinks" },
  { label: "Rankings", segment: "rankings" },
  { label: "Search traffic", segment: "search" },
  { label: "What we've done", segment: "work-log" },
  { label: "Reports", segment: "reports" },
];

// Billing shows once the client has an agreement with Compass (B5);
// Inquiries once Compass turns on CRM Lite portal access for the client.
export function PortalNav({ showBilling = false, showInquiries = false }: { showBilling?: boolean; showInquiries?: boolean }) {
  const pathname = usePathname();
  const visible = [
    ...(showInquiries ? [{ label: "Inquiries", segment: "inquiries" }] : []),
    ...tabs,
    ...(showBilling ? [{ label: "Billing", segment: "billing" }] : []),
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto">
      {visible.map((tab) => {
        const href = tab.segment ? `/portal/${tab.segment}` : "/portal";
        const active = tab.segment
          ? pathname.startsWith(href)
          : pathname === "/portal";
        return (
          <Link
            key={tab.label}
            href={href}
            className={cn(
              "px-3 py-2 font-heading text-sm whitespace-nowrap border-b-2 -mb-px transition-colors",
              active
                ? "border-orange-500 font-semibold text-white"
                : "border-transparent text-cream/70 hover:text-white hover:border-cream/30"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
