"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItem, navTrack } from "@/lib/nav-styles";
import { cn } from "@/lib/utils";
import { useActiveInView } from "@/components/use-active-in-view";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/production", label: "Production" },
  { href: "/production/health", label: "Control Center" },
  { href: "/tasks", label: "Tasks" },
  { href: "/brief", label: "Brief" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ className, citations = false }: { className?: string; citations?: boolean }) {
  const pathname = usePathname();
  // Citations appears only while its server-side flag is on (src/lib/citations-flag.ts).
  const visible = citations ? [...links.slice(0, 4), { href: "/citations", label: "Citations" }, ...links.slice(4)] : links;
  const railRef = useActiveInView<HTMLElement>(pathname);
  return (
    <nav ref={railRef} aria-label="Main" className={cn(navTrack, "sm:w-auto", className)}>
      {visible.map((link) => {
        const active =
          link.href === "/" ? pathname === "/" : link.href === "/production" ? pathname === "/production" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={navItem(active)}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
