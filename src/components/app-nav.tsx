"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItem, navTrack } from "@/lib/nav-styles";
import { cn } from "@/lib/utils";
import { useActiveInView } from "@/components/use-active-in-view";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/tasks", label: "Tasks" },
  { href: "/brief", label: "Brief" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ className }: { className?: string }) {
  const pathname = usePathname();
  const railRef = useActiveInView<HTMLElement>(pathname);
  return (
    <nav ref={railRef} aria-label="Main" className={cn(navTrack, "sm:w-auto", className)}>
      {links.map((link) => {
        const active =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
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
