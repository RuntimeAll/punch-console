"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/library", label: "资料库" },
  { href: "/questions", label: "题目库" },
];

export function NavBar() {
  const path = usePathname() || "";
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <nav className="max-w-3xl mx-auto flex items-center gap-1 px-3 h-12">
        <span className="text-sm font-semibold mr-2 shrink-0">资料产线</span>
        {TABS.map((t) => {
          const on = path === t.href || path.startsWith(`${t.href}/`) || (t.href === "/library" && path.startsWith("/book/"));
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm transition-colors",
                on ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/60",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
