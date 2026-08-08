/**
 * 三路混合检索:考点/题型/册 过滤 + FTS5 关键词 + 本地向量语意。
 *
 * 融合用 RRF(倒数排名融合):score = Σ 1/(k + rank)。
 * 好处是不用给 bm25 和余弦做量纲对齐 —— 两把尺子刻度不同,只比名次最稳。
 * 语意轴没就绪时自动只走 FTS,页面负责把「未就绪」写在脸上。
 */
import { rawDb } from "@/db/client";
import { toMatchExpr } from "@/db/fts";

import { bufToVec, cosine, embedQuery, probeSidecar } from "./embed";

const RRF_K = 60;
/** 语意轴单独召回的上限,再多也没意义 */
const VEC_TOP = 80;

export type SearchParams = {
  q?: string;
  kp?: string;
  qtype?: string;
  docId?: number;
  limit?: number;
};

export type QuestionRow = {
  id: number;
  doc_id: number | null;
  册名: string | null;
  版本名: string | null;
  day: number | null;
  section: string | null;
  seq: number | null;
  stem: string;
  题型: string | null;
  考点: string | null;
  实算: string | null;
  来源: string | null;
};

export type SemanticInfo = {
  /** venv+脚本在 且 库里有向量 */
  ready: boolean;
  /** 本次查询真的用上了语意轴 */
  used: boolean;
  reason?: string;
  vectored: number;
  total: number;
};

/** 语意轴就绪状态(页面标注用)。 */
export function semanticStatus(): SemanticInfo {
  const d = rawDb();
  const total = (d.prepare(`SELECT COUNT(*) c FROM question`).get() as { c: number }).c;
  const vectored = (
    d.prepare(`SELECT COUNT(*) c FROM question WHERE 向量 IS NOT NULL`).get() as { c: number }
  ).c;
  const probe = probeSidecar();
  if (!probe.ok) {
    return { ready: false, used: false, reason: probe.reason, vectored, total };
  }
  if (vectored === 0) {
    return { ready: false, used: false, reason: "题目还没算向量(pnpm embed:all)", vectored, total };
  }
  return { ready: true, used: false, vectored, total };
}

/** 过滤条件 -> 可自由拼接的子句数组(别拼成整句,后面要和 MATCH 混着用)。 */
function whereOf(p: SearchParams) {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (p.kp) {
    // 考点是 JSON 数组文本,带引号匹配才不会「乘法」命中「乘法分配律」以外的碎片
    clauses.push(`q.考点 LIKE ?`);
    args.push(`%"${p.kp}"%`);
  }
  if (p.qtype) {
    clauses.push(`q.题型 = ?`);
    args.push(p.qtype);
  }
  if (p.docId) {
    clauses.push(`q.doc_id = ?`);
    args.push(p.docId);
  }
  return { clauses, args };
}

/** 若干子句 -> WHERE 串(空则返回空串)。 */
function whereSql(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

const SELECT_COLS = `
  q.id, q.doc_id, d.名称 AS 册名, d.版本名, q.day, q.section, q.seq,
  q.stem, q.题型, q.考点, q.实算, q.来源`;

/** 主查询。 */
export async function searchQuestions(p: SearchParams): Promise<{
  rows: QuestionRow[];
  total: number;
  semantic: SemanticInfo;
}> {
  const d = rawDb();
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 500);
  const q = (p.q || "").trim();
  const w = whereOf(p);
  const sem = semanticStatus();

  // 过滤集总数(不含关键词)
  const filteredTotal = (
    d
      .prepare(`SELECT COUNT(*) c FROM question q ${whereSql(w.clauses)}`)
      .get(...w.args) as { c: number }
  ).c;

  // ---- 无关键词:纯过滤,按册/天/序排
  if (!q) {
    const rows = d
      .prepare(
        `SELECT ${SELECT_COLS} FROM question q LEFT JOIN doc d ON d.id = q.doc_id
         ${whereSql(w.clauses)}
         ORDER BY q.doc_id, q.day, q.section, q.seq LIMIT ?`,
      )
      .all(...w.args, limit) as QuestionRow[];
    return { rows, total: filteredTotal, semantic: sem };
  }

  // ---- 关键词轴(FTS5 + bm25)
  const match = toMatchExpr(q);
  const ftsIds: number[] = [];
  if (match) {
    try {
      const hits = d
        .prepare(
          `SELECT f.rowid AS id FROM question_fts f
             JOIN question q ON q.id = f.rowid
           ${whereSql(["question_fts MATCH ?", ...w.clauses])}
           ORDER BY bm25(question_fts) LIMIT ?`,
        )
        .all(match, ...w.args, limit * 4) as { id: number }[];
      for (const h of hits) ftsIds.push(h.id);
    } catch {
      // MATCH 表达式被奇怪输入搞炸时不整页崩,退化成只走语意轴
    }
  }

  // ---- 语意轴(向量余弦)
  const vecIds: number[] = [];
  let usedSemantic = false;
  if (sem.ready) {
    const qvec = await embedQuery(q);
    if (qvec) {
      const cands = d
        .prepare(
          `SELECT q.id AS id, q.向量 AS v FROM question q
           ${whereSql([...w.clauses, "q.向量 IS NOT NULL"])}`,
        )
        .all(...w.args) as { id: number; v: Buffer }[];
      const scored = cands
        .map((c) => ({ id: c.id, s: cosine(qvec, bufToVec(c.v)) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, VEC_TOP);
      for (const s of scored) vecIds.push(s.id);
      usedSemantic = scored.length > 0;
    }
  }

  // ---- RRF 融合
  const score = new Map<number, number>();
  ftsIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + i + 1)));
  vecIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + i + 1)));

  const ordered = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (!ordered.length) {
    return { rows: [], total: 0, semantic: { ...sem, used: usedSemantic } };
  }

  const ids = ordered.map(([id]) => id);
  const place = ids.map(() => "?").join(",");
  const found = d
    .prepare(
      `SELECT ${SELECT_COLS} FROM question q LEFT JOIN doc d ON d.id = q.doc_id
       WHERE q.id IN (${place})`,
    )
    .all(...ids) as QuestionRow[];

  const byId = new Map(found.map((r) => [r.id, r]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean) as QuestionRow[];
  return { rows, total: score.size, semantic: { ...sem, used: usedSemantic } };
}

/** 考点覆盖统计(标签轴的体检条)。 */
export function kpCoverage(p: SearchParams = {}): {
  items: { kp: string; count: number }[];
  untagged: number;
  tagged: number;
} {
  const d = rawDb();
  const w = whereOf({ ...p, kp: undefined });
  const items = d
    .prepare(
      `SELECT je.value AS kp, COUNT(*) AS count
       FROM question q, json_each(q.考点) je
       ${whereSql([...w.clauses, "q.考点 IS NOT NULL", "json_valid(q.考点)"])}
       GROUP BY je.value ORDER BY count DESC, kp`,
    )
    .all(...w.args) as { kp: string; count: number }[];
  const untagged = (
    d
      .prepare(
        `SELECT COUNT(*) c FROM question q ${whereSql([...w.clauses, "(q.考点 IS NULL OR q.考点 = '')"])}`,
      )
      .get(...w.args) as { c: number }
  ).c;
  const tagged = (
    d
      .prepare(
        `SELECT COUNT(*) c FROM question q ${whereSql([...w.clauses, "q.考点 IS NOT NULL", "q.考点 <> ''"])}`,
      )
      .get(...w.args) as { c: number }
  ).c;
  return { items, untagged, tagged };
}

/** 筛选器选项。 */
export function filterOptions() {
  const d = rawDb();
  const qtypes = d
    .prepare(`SELECT 题型 AS v, COUNT(*) c FROM question WHERE 题型 IS NOT NULL GROUP BY 题型 ORDER BY c DESC`)
    .all() as { v: string; c: number }[];
  const docs = d
    .prepare(
      `SELECT d.id, d.名称 AS name, d.版本名 AS version, COUNT(q.id) AS c
       FROM doc d JOIN question q ON q.doc_id = d.id
       GROUP BY d.id ORDER BY c DESC`,
    )
    .all() as { id: number; name: string; version: string | null; c: number }[];
  const kps = kpCoverage().items;
  return { qtypes, docs, kps };
}
