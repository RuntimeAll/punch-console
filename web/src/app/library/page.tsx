import Link from "next/link";

import { FilterChips } from "@/components/filter-chips";
import { LaneBadge } from "@/components/lane-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DOC_TYPES } from "@/db/schema";
import { groupDocs, laneOf, libraryFacets, listDocs, type DocRow } from "@/lib/library";

export const dynamic = "force-dynamic";

const LANES = ["在售", "可发布", "在产", "停售"];

function DocLine({ d, showVersion }: { d: DocRow; showVersion: boolean }) {
  return (
    <Link
      href={`/book/${d.id}`}
      className="flex items-center gap-2 py-2 px-3 -mx-3 hover:bg-secondary/60 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          {showVersion ? d.版本名 || "正册" : d.名称}
          {d.册型 === "合刊" && (
            <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
              合刊
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[d.年级, d.科目].filter(Boolean).join(" · ")}
          {d.题数 > 0 && ` · ${d.题数} 题`}
          {d.物料数 > 0 && ` · 物料 ${d.物料数}`}
          {d.图数 > 0 && ` · 图 ${d.图数}`}
        </div>
      </div>
      <LaneBadge lane={laneOf(d)} />
    </Link>
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined;

  const filter = {
    类型: one("类型"),
    科目: one("科目"),
    年级: one("年级"),
    状态: one("状态"),
  };
  const rows = listDocs(filter);
  const groups = groupDocs(rows);
  const facets = libraryFacets();
  const query = filter as Record<string, string | undefined>;

  // 六类资料常驻显示(库里没有的也列出来,好知道哪类还是空的)
  const typeItems = DOC_TYPES.map((t) => ({
    v: t,
    c: facets.类型.find((x) => x.v === t)?.c ?? 0,
  }));

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <FilterChips label="类型" items={typeItems} active={filter.类型} paramKey="类型" base="/library" query={query} />
        <FilterChips label="科目" items={facets.科目} active={filter.科目} paramKey="科目" base="/library" query={query} />
        <FilterChips label="年级" items={facets.年级} active={filter.年级} paramKey="年级" base="/library" query={query} />
        <FilterChips
          label="状态"
          items={LANES.map((v) => ({ v }))}
          active={filter.状态}
          paramKey="状态"
          base="/library"
          query={query}
        />
      </div>

      <p className="text-xs text-muted-foreground px-0.5">
        {groups.length} 组 · {rows.length} 份资料
      </p>

      {!rows.length && (
        <p className="text-sm text-muted-foreground py-8 text-center">没有符合条件的资料</p>
      )}

      <div className="space-y-2">
        {groups.map((g) => {
          // 打卡多版本的册折叠成一组;单版本的直接平铺,别为一行加个壳
          if (g.docs.length === 1) {
            return (
              <Card key={g.key} className="py-0">
                <CardContent className="px-3 py-0">
                  <DocLine d={g.docs[0]} showVersion={false} />
                </CardContent>
              </Card>
            );
          }
          return (
            <Card key={g.key} className="py-0">
              <CardContent className="px-3 py-2">
                <div className="text-sm font-medium mb-1">
                  {g.key}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {g.docs.length} 个版本
                  </span>
                </div>
                <div className="divide-y">
                  {g.docs.map((d) => (
                    <DocLine key={d.id} d={d} showVersion />
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
