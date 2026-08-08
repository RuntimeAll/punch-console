/**
 * 资料库读侧:列表 / 分组 / 册详情四项体检。
 *
 * 🔴 地基第 2 条:状态算出来,不存两份。
 *    库里只有 doc.人工态(在售/停售)一个人工开关,泳道与体检一律现算——
 *    存了就会过期,过期就是洞。
 */
import { rawDb } from "@/db/client";

export type DocRow = {
  id: number;
  名称: string;
  类型: string;
  组名: string | null;
  版本名: string | null;
  科目: string | null;
  年级: string | null;
  考点: string | null;
  册型: string | null;
  人工态: string | null;
  day_spec: string | null;
  源文件路径: string | null;
  网盘链接: string | null;
  提取码: string | null;
  线上book_id: string | null;
  题数: number;
  绿数: number;
  红数: number;
  物料数: number;
  图数: number;
};

const DOC_SELECT = `
  d.id, d.名称, d.类型, d.组名, d.版本名, d.科目, d.年级, d.考点, d.册型,
  d.人工态, d.day_spec, d.源文件路径, d.网盘链接, d.提取码, d.线上book_id,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id) AS 题数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '绿') AS 绿数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '红') AS 红数,
  (SELECT COUNT(*) FROM material m WHERE m.doc_id = d.id AND m.is_active = 1) AS 物料数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 IN ('图A','图B')) AS 图数`;

export type LibraryFilter = {
  类型?: string;
  科目?: string;
  年级?: string;
  状态?: string;
};

/** 现算泳道态。人工态优先,其余按「够不够发」推。 */
export function laneOf(d: DocRow): "在售" | "停售" | "可发布" | "在产" {
  if (d.人工态 === "在售") return "在售";
  if (d.人工态 === "停售") return "停售";
  const 有题 = d.题数 > 0;
  const 有物料 = d.物料数 > 0;
  const 有网盘 = Boolean(d.网盘链接);
  return 有题 && 有物料 && 有网盘 ? "可发布" : "在产";
}

export function listDocs(f: LibraryFilter = {}): DocRow[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (f.类型) {
    clauses.push("d.类型 = ?");
    args.push(f.类型);
  }
  if (f.科目) {
    clauses.push("d.科目 = ?");
    args.push(f.科目);
  }
  if (f.年级) {
    clauses.push("d.年级 = ?");
    args.push(f.年级);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = rawDb()
    .prepare(`SELECT ${DOC_SELECT} FROM doc d ${where} ORDER BY d.类型, d.组名, d.名称, d.版本名`)
    .all(...args) as DocRow[];
  // 状态是现算的,只能在内存里筛
  return f.状态 ? rows.filter((r) => laneOf(r) === f.状态) : rows;
}

/** 打卡按组名折叠;其余类型每份自成一组。 */
export function groupDocs(rows: DocRow[]): { key: string; docs: DocRow[] }[] {
  const map = new Map<string, DocRow[]>();
  for (const r of rows) {
    const key = r.类型 === "打卡" ? r.组名 || r.名称 : r.名称;
    const list = map.get(key);
    if (list) list.push(r);
    else map.set(key, [r]);
  }
  return [...map.entries()].map(([key, docs]) => ({ key, docs }));
}

/** 筛选器可选值(只列库里真有的)。 */
export function libraryFacets() {
  const d = rawDb();
  const one = (col: string) =>
    (
      d
        .prepare(`SELECT ${col} AS v, COUNT(*) c FROM doc WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col} ORDER BY c DESC`)
        .all() as { v: string; c: number }[]
    ).filter((x) => x.v);
  return { 类型: one("类型"), 科目: one("科目"), 年级: one("年级") };
}

// ------------------------------------------------------------------ 册详情

export type Check = { 名: string; 绿: boolean; 说明: string };

export type DocDetail = {
  doc: DocRow;
  lane: ReturnType<typeof laneOf>;
  checks: Check[];
  materials: {
    id: number;
    账号: string;
    is_active: number;
    标题: string | null;
    正文: string | null;
    话题词: string | null;
    商品描述: string | null;
    网盘分享语: string | null;
  }[];
  assets: { id: number; 类型: string; 路径: string; 配图顺序: number | null }[];
  questions: { section: string | null; 题型: string | null; c: number }[];
  天数: number | null;
};

function parseDaySpec(s: string | null): { 天数: number; 每天: Record<string, number> } | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if (o && typeof o.天数 === "number") return o;
  } catch {
    /* 卡里手改坏了就当没有 */
  }
  return null;
}

export function docDetail(id: number): DocDetail | null {
  const d = rawDb();
  const doc = d.prepare(`SELECT ${DOC_SELECT} FROM doc d WHERE d.id = ?`).get(id) as
    | DocRow
    | undefined;
  if (!doc) return null;

  const materials = d
    .prepare(
      `SELECT id, 账号, is_active, 标题, 正文, 话题词, 商品描述, 网盘分享语
       FROM material WHERE doc_id = ? ORDER BY 账号`,
    )
    .all(id) as DocDetail["materials"];
  const assets = d
    .prepare(
      `SELECT id, 类型, 路径, 配图顺序 FROM asset WHERE doc_id = ? ORDER BY 类型, 配图顺序, 路径`,
    )
    .all(id) as DocDetail["assets"];
  const questions = d
    .prepare(
      `SELECT section, 题型, COUNT(*) c FROM question WHERE doc_id = ? GROUP BY section, 题型 ORDER BY c DESC`,
    )
    .all(id) as DocDetail["questions"];

  // ---- 四项体检(全部现算)
  const spec = parseDaySpec(doc.day_spec);
  const 应有 = spec
    ? spec.天数 * Object.values(spec.每天 || {}).reduce((a, b) => a + b, 0)
    : null;

  const 题目齐: Check = 应有
    ? {
        名: "题目齐",
        绿: doc.题数 >= 应有,
        说明: `${doc.题数} / ${应有} 题(${spec!.天数} 天规格)`,
      }
    : {
        名: "题目齐",
        绿: doc.题数 > 0,
        说明: doc.题数 > 0 ? `${doc.题数} 题(无 day_spec,按题数判)` : "题目未入库",
      };

  const 待算 = doc.题数 - doc.绿数 - doc.红数;
  const 实算绿: Check = {
    名: "实算绿",
    绿: doc.题数 > 0 && doc.红数 === 0 && 待算 === 0,
    说明:
      doc.题数 === 0
        ? "无题可算"
        : `绿 ${doc.绿数} / 红 ${doc.红数} / 待算 ${待算}`,
  };

  const accounts = new Set(materials.filter((m) => m.is_active === 1).map((m) => m.账号));
  const 物料齐: Check = {
    名: "物料齐",
    绿: accounts.has("A") && accounts.has("B"),
    说明: accounts.size
      ? `在用 ${[...accounts].sort().join("/")} 号${accounts.size < 2 ? "(缺一号)" : ""}`
      : "没有在用物料",
  };

  const 网盘挂: Check = {
    名: "网盘挂",
    绿: Boolean(doc.网盘链接),
    说明: doc.网盘链接 ? `已挂${doc.提取码 ? ` · 码 ${doc.提取码}` : ""}` : "没有网盘链接",
  };

  return {
    doc,
    lane: laneOf(doc),
    checks: [题目齐, 实算绿, 物料齐, 网盘挂],
    materials,
    assets,
    questions,
    天数: spec?.天数 ?? null,
  };
}
