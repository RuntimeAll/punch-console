/**
 * GET /api/questions?q=&考点=&题型=&doc=&limit=
 *
 * 三路混合:FTS5 关键词 + 考点/题型/册过滤 + 向量语意排序融合。
 * 语意轴没就绪就自动只走 FTS,响应里 semantic.ready=false 并带原因,由调用方决定怎么标。
 */
import { NextResponse } from "next/server";

import { kpCoverage, searchQuestions } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const docRaw = sp.get("doc");
  const params = {
    q: sp.get("q") || undefined,
    kp: sp.get("考点") || sp.get("kp") || undefined,
    qtype: sp.get("题型") || sp.get("type") || undefined,
    docId: docRaw ? Number(docRaw) : undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  };

  try {
    const r = await searchQuestions(params);
    return NextResponse.json({
      ok: true,
      查询: params,
      命中: r.rows.length,
      总数: r.total,
      语意轴: {
        ready: r.semantic.ready,
        used: r.semantic.used,
        reason: r.semantic.reason,
        已算向量: r.semantic.vectored,
        题总数: r.semantic.total,
      },
      考点覆盖: sp.get("覆盖") === "1" ? kpCoverage(params) : undefined,
      rows: r.rows,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
