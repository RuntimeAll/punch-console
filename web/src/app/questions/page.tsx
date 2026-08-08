import Link from "next/link";

import { FilterChips } from "@/components/filter-chips";
import { SearchBox } from "@/components/search-box";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { filterOptions, kpCoverage, searchQuestions } from "@/lib/search";

export const dynamic = "force-dynamic";

/** 考点覆盖条:标签轴铺到哪了,一眼看完。 */
function CoverageBar({
  items,
  tagged,
  untagged,
  query,
}: {
  items: { kp: string; count: number }[];
  tagged: number;
  untagged: number;
  query: Record<string, string | undefined>;
}) {
  const total = tagged + untagged;
  const pct = total ? Math.round((tagged / total) * 100) : 0;
  return (
    <Card className="py-3">
      <CardContent className="px-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">考点覆盖</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            已标 {tagged} / 共 {total} 题 · {items.length} 个考点
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-emerald-600" style={{ width: `${pct}%` }} />
        </div>
        {untagged > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {untagged} 题还没打考点 —— 打标属深度处理,留给 M2 的 agent 任务。
          </p>
        )}
        {items.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {items.slice(0, 40).map((k) => {
              const q = new URLSearchParams();
              for (const [key, v] of Object.entries({ ...query, 考点: k.kp })) {
                if (v) q.set(key, v);
              }
              return (
                <Link key={k.kp} href={`/questions?${q}`}>
                  <Badge variant="secondary" className="text-[10px] font-normal hover:bg-secondary/70">
                    {k.kp}
                    <span className="ml-1 opacity-60 tabular-nums">{k.count}</span>
                  </Badge>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined;

  const q = one("q") || "";
  const kp = one("考点");
  const qtype = one("题型");
  const docId = one("doc") ? Number(one("doc")) : undefined;
  const query: Record<string, string | undefined> = {
    q: q || undefined,
    考点: kp,
    题型: qtype,
    doc: one("doc"),
  };

  const res = await searchQuestions({ q, kp, qtype, docId, limit: 60 });
  const opts = filterOptions();
  const cov = kpCoverage({ qtype, docId });

  const sem = res.semantic;

  return (
    <div className="space-y-3">
      <SearchBox defaultValue={q} hidden={{ 考点: kp, 题型: qtype, doc: one("doc") }} />

      {/* 语意轴状态如实写在脸上:没就绪就是没就绪,不假装 */}
      <div className="text-[11px] px-0.5">
        {sem.ready ? (
          <span className="text-muted-foreground">
            三路检索就绪 · 关键词 FTS5 + 考点过滤 + 语意向量({sem.vectored}/{sem.total} 题已算)
            {q && sem.used ? " · 本次已融合语意排序" : ""}
          </span>
        ) : (
          <span className="text-amber-600">
            语意轴未就绪({sem.reason || "未知原因"})—— 当前只走 FTS 关键词 + 考点过滤
          </span>
        )}
      </div>

      <div className="space-y-0.5">
        <FilterChips
          label="题型"
          items={opts.qtypes.map((t) => ({ v: t.v, c: t.c }))}
          active={qtype}
          paramKey="题型"
          base="/questions"
          query={query}
        />
        <FilterChips
          label="册"
          items={opts.docs.map((d) => ({
            v: String(d.id),
            c: d.c,
            label: `${d.name}${d.version && d.version !== "正册" ? `·${d.version}` : ""}`,
          }))}
          active={one("doc")}
          paramKey="doc"
          base="/questions"
          query={query}
        />
      </div>

      <CoverageBar items={cov.items} tagged={cov.tagged} untagged={cov.untagged} query={query} />

      {kp && (
        <p className="text-xs">
          考点筛选:<Badge variant="default">{kp}</Badge>{" "}
          <Link href="/questions" className="text-sky-600 hover:underline ml-1">
            清除
          </Link>
        </p>
      )}

      <p className="text-xs text-muted-foreground px-0.5">
        命中 {res.rows.length} 题{res.total > res.rows.length ? ` / 共 ${res.total}` : ""}
      </p>

      {!res.rows.length && (
        <p className="text-sm text-muted-foreground py-8 text-center">没搜到题</p>
      )}

      <div className="space-y-1.5">
        {res.rows.map((r) => (
          <Card key={r.id} className="py-2">
            <CardContent className="px-3">
              <p className="text-sm break-words">{r.stem}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-muted-foreground">
                {r.题型 && (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    {r.题型}
                  </Badge>
                )}
                <span
                  className={
                    r.实算 === "绿"
                      ? "text-emerald-600"
                      : r.实算 === "红"
                        ? "text-red-600"
                        : "text-muted-foreground"
                  }
                >
                  实算{r.实算}
                </span>
                <span>
                  {r.册名}
                  {r.版本名 && r.版本名 !== "正册" ? `·${r.版本名}` : ""}
                </span>
                {r.day != null && <span>第 {r.day} 天</span>}
                {r.section && <span>{r.section}</span>}
                {r.seq != null && <span>#{r.seq}</span>}
                {(() => {
                  try {
                    const ks = r.考点 ? (JSON.parse(r.考点) as string[]) : [];
                    return ks.map((k) => (
                      <Badge key={k} variant="secondary" className="text-[10px] font-normal">
                        {k}
                      </Badge>
                    ));
                  } catch {
                    return null;
                  }
                })()}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
