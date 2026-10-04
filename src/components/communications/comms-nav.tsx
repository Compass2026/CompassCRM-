"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { chip, navCount } from "@/lib/nav-styles";

const sections = [
  { label: "Overview", segment: "" },
  { label: "Inbox", segment: "inbox" },
  { label: "Numbers", segment: "numbers" },
  { label: "Compliance", segment: "compliance" },
  { label: "Settings", segment: "settings" },
];

// Client › Communications sub-sections.
export function CommsNav({ clientId, unread }: { clientId: string; unread: number }) {
  const pathname = usePathname();
  const base = `/clients/${clientId}/communications`;
  return (
    <nav aria-label="Communications sections" className="flex flex-wrap gap-2">
      {sections.map((s) => {
        const href = s.segment ? `${base}/${s.segment}` : base;
        const active = s.segment ? pathname.startsWith(href) : pathname === base;
        return (
          <Link key={s.label} href={href} aria-current={active ? "page" : undefined} className={chip(active)}>
            {s.label}
            {s.segment === "inbox" && unread > 0 && <span className={`ml-1.5 ${navCount("alert")}`}>{unread}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
