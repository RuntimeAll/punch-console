import Link from "next/link";
import { notFound } from "next/navigation";

import { LaneBadge } from "@/components/lane-badge";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { docDetail, type Check } from "@/lib/library";

export const dynamic = "force-dynamic";

function parseList(s: string | null): string[] {
  if (!s) return [];
  try {
    const o = JSON.parse(s);
    return Array.isArray(o) ? o.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 体检灯:灯写在脸上,但不锁任何操作(地基第 3 条)。
 * 三态 —— 绿=过了 / 缺=黄灯提醒 / 免=这类资料不查这项(灰,不参与判定)。
 */
function CheckPill({ c }: { c: Check }) {
  const tone = {
    绿: { box: "border-emerald-600/40 bg-emerald-600/10", dot: "bg-emerald-600" },
    缺: { box: "border-amber-500/40 bg-amber-500/10", dot: "bg-amber-500" },
    免: { box: "border-border bg-muted/40", dot: "bg-muted-foreground/40" },
  }[c.态];
  return (
    <div className={"rounded-lg border px-2.5 py-2 " + tone.box}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <span className={"inline-block size-2 rounded-full " + tone.dot} />
        {c.名}
        {c.态 === "免" && <span className="text-[10px] font-normal text-muted-foreground">不判</span>}
      </div>
      <div className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{c.说明}</div>
    </div>
  );
}

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = docDetail(Number(id));
  if (!detail) notFound();

  const { doc, lane, checks, materials, assets, questions, 成员, 被收录 } = detail;
  const kps = parseList(doc.考点);
  // 「卷」= 成品(题目卷/答案卷/合订卷),其余(图A/图B/页图/封面)都算图
  const pdfs = assets.filter((a) => a.类型.endsWith("卷"));
  const imgs = assets.filter((a) => !a.类型.endsWith("卷"));

  return (
    <div className="space-y-3">
      <div>
        <Link href="/library" className="text-xs text-muted-foreground hover:underline">
          ← 资料库
        </Link>
        <div className="flex items-start gap-2 mt-1">
          <h1 className="text-lg font-semibold leading-tight flex-1">
            {doc.名称}
            {doc.版本名 && doc.版本名 !== "正册" && (
              <span className="text-muted-foreground font-normal"> · {doc.版本名}</span>
            )}
          </h1>
          <LaneBadge lane={lane} />
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {[doc.类型, doc.年级, doc.科目, doc.册型].filter(Boolean).join(" · ")}
          {detail.天数 ? ` · ${detail.天数} 天` : ""}
        </div>
      </div>

      {/* 四项体检:每次打开现算,不读任何存下来的状态 */}
      <div className="grid grid-cols-2 gap-2">
        {checks.map((c) => (
          <CheckPill key={c.名} c={c} />
        ))}
      </div>

      <Card className="py-3">
        <CardContent className="px-3 space-y-1.5 text-sm">
          <Row k="网盘">
            {doc.网盘链接 ? (
              <a
                href={doc.网盘链接}
                target="_blank"
                rel="noreferrer"
                className="text-sky-600 underline break-all"
              >
                {doc.网盘链接}
              </a>
            ) : (
              <span className="text-muted-foreground">未挂</span>
            )}
          </Row>
          {doc.提取码 && <Row k="提取码">{doc.提取码}</Row>}
          <Row k="线上">
            {doc.线上book_id || <span className="text-muted-foreground">未录 prod</span>}
          </Row>
          <Row k="源目录">
            {doc.源文件路径 ? (
              <Reveal
                路径={doc.源文件路径}
                title="在电脑上打开这个文件夹"
                className="break-all text-left text-xs text-muted-foreground hover:text-sky-600 hover:underline cursor-pointer"
              >
                📂 {doc.源文件路径}
              </Reveal>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </Row>
          {kps.length > 0 && (
            <Row k="考点">
              <span className="flex flex-wrap gap-1">
                {kps.map((k) => (
                  <Badge key={k} variant="secondary" className="text-[10px] font-normal">
                    {k}
                  </Badge>
                ))}
              </span>
            </Row>
          )}
        </CardContent>
      </Card>

      {/* 册级归属(doc_member):合刊列成员,成员标出处。题级引用是 collection_item,两回事 */}
      {成员.length > 0 && (
        <Card className="py-3">
          <CardHeader className="px-3 pb-1">
            <CardTitle className="text-sm">合刊成员 · {成员.length} 册</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pt-0">
            <div className="divide-y -my-1">
              {成员.map((m, i) => (
                <Link
                  key={m.id}
                  href={`/book/${m.id}`}
                  className="flex items-center gap-2 py-2 hover:bg-secondary/60 -mx-3 px-3 transition-colors"
                >
                  <span className="text-xs text-muted-foreground tabular-nums w-4 shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm flex-1 min-w-0 truncate">{m.名称}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {m.题数 > 0 ? `${m.题数} 题` : "未拆题"}
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {被收录.length > 0 && (
        <Card className="py-3">
          <CardContent className="px-3 text-sm">
            <span className="text-muted-foreground text-xs">被收录 </span>
            {被收录.map((m) => (
              <Link key={m.id} href={`/book/${m.id}`} className="text-sky-600 hover:underline mr-2">
                《{m.名称}》
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="material">
        <TabsList className="w-full">
          <TabsTrigger value="material" className="flex-1">
            物料 {materials.length}
          </TabsTrigger>
          <TabsTrigger value="asset" className="flex-1">
            产物 {assets.length}
          </TabsTrigger>
          <TabsTrigger value="question" className="flex-1">
            题目 {doc.题数}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="material" className="space-y-2 mt-2">
          {!materials.length && <Empty>还没有发帖物料</Empty>}
          {materials.map((m) => (
            <Card key={m.id} className="py-3">
              <CardHeader className="px-3 pb-1">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Badge variant={m.账号 === "A" ? "default" : "secondary"} className="text-[10px]">
                    {m.账号} 号
                  </Badge>
                  {m.is_active === 1 ? (
                    <span className="text-[11px] text-emerald-600">在用</span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">停用</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 space-y-1.5">
                {m.标题 && <p className="text-sm font-medium">{m.标题}</p>}
                {m.正文 && (
                  <pre className="text-xs whitespace-pre-wrap font-sans text-muted-foreground max-h-48 overflow-y-auto">
                    {m.正文}
                  </pre>
                )}
                {parseList(m.话题词).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {parseList(m.话题词).map((t) => (
                      <Badge key={t} variant="outline" className="text-[10px] font-normal">
                        #{t}
                      </Badge>
                    ))}
                  </div>
                )}
                {m.商品描述 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">商品上架描述</summary>
                    <p className="mt-1 whitespace-pre-wrap">{m.商品描述}</p>
                  </details>
                )}
                {m.网盘分享语 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">网盘分享语</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-sans">{m.网盘分享语}</pre>
                  </details>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="asset" className="space-y-2 mt-2">
          {!assets.length && <Empty>还没有产物文件</Empty>}
          {pdfs.length > 0 && (
            <AssetGroup title="成品 PDF" rows={pdfs} />
          )}
          {imgs.length > 0 && (
            <AssetGroup title={`图片 ${imgs.length} 张`} rows={imgs} collapsed />
          )}
        </TabsContent>

        <TabsContent value="question" className="space-y-2 mt-2">
          {!questions.length && <Empty>题目还没入库</Empty>}
          {questions.length > 0 && (
            <Card className="py-3">
              <CardContent className="px-3 space-y-1">
                {questions.map((q) => (
                  <div key={`${q.section}-${q.题型}`} className="flex justify-between text-sm">
                    <span>
                      {q.题型 || "未分类"}
                      <span className="text-muted-foreground text-xs ml-1">{q.section}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">{q.c}</span>
                  </div>
                ))}
                <Link
                  href={`/questions?doc=${doc.id}`}
                  className="block pt-2 text-sm text-sky-600 hover:underline"
                >
                  到题目库看这册的题 →
                </Link>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-14 text-xs pt-0.5">{k}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground py-6 text-center">{children}</p>;
}

function AssetGroup({
  title,
  rows,
  collapsed,
}: {
  title: string;
  rows: { id: number; 类型: string; 路径: string }[];
  collapsed?: boolean;
}) {
  const body = (
    <div className="space-y-0.5">
      {rows.map((a) => (
        <div key={a.id} className="flex gap-2 text-xs items-start group">
          <Badge variant="outline" className="text-[10px] shrink-0 font-normal">
            {a.类型}
          </Badge>
          <Reveal
            路径={a.路径}
            className="break-all text-left text-muted-foreground hover:text-sky-600 hover:underline flex-1 cursor-pointer"
          >
            {a.路径}
          </Reveal>
          <Reveal
            路径={a.路径}
            mode="open"
            className="shrink-0 text-[11px] text-muted-foreground hover:text-sky-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            打开
          </Reveal>
        </div>
      ))}
    </div>
  );
  return (
    <Card className="py-3">
      <CardContent className="px-3">
        {collapsed ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">{title}</summary>
            <div className="mt-2">{body}</div>
          </details>
        ) : (
          <>
            <p className="text-sm font-medium mb-2">{title}</p>
            {body}
          </>
        )}
      </CardContent>
    </Card>
  );
}
