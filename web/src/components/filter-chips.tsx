import Link from "next/link";

import { cn } from "@/lib/utils";

/** v = 进 URL 的值,label = 给人看的字(不给就用 v)。 */
export type ChipItem = { v: string; c?: number; label?: string };

/**
 * 一行筛选 chips。手机上横向滚动,不换行挤成一团。
 * 用 Link 而不是 onClick —— 筛选态放 URL 里,刷新/分享都还在。
 */
export function FilterChips({
  label,
  items,
  active,
  paramKey,
  base,
  query,
}: {
  label: string;
  items: ChipItem[];
  active?: string;
  paramKey: string;
  base: string;
  query: Record<string, string | undefined>;
}) {
  if (!items.length) return null;

  const hrefFor = (v?: string) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...query, [paramKey]: v })) {
      if (val) q.set(k, val);
    }
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div className="flex items-center gap-1.5 -mx-3 px-3 overflow-x-auto scrollbar-none py-1">
      <span className="text-xs text-muted-foreground shrink-0 w-8">{label}</span>
      <Link
        href={hrefFor(undefined)}
        className={cn(
          "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
          !active ? "bg-primary text-primary-foreground border-primary" : "hover:bg-secondary",
        )}
      >
        全部
      </Link>
      {items.map((it) => (
        <Link
          key={it.v}
          href={hrefFor(it.v)}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
            active === it.v
              ? "bg-primary text-primary-foreground border-primary"
              : "hover:bg-secondary",
          )}
        >
          {it.label ?? it.v}
          {typeof it.c === "number" && (
            <span className="ml-1 opacity-60 tabular-nums">{it.c}</span>
          )}
        </Link>
      ))}
    </div>
  );
}
