/**
 * 资料库读侧:列表 / 分组 / 册详情体检(按类型分档)。
 *
 * 🔴 地基第 2 条:状态算出来,不存两份。
 *    库里只有 doc.人工态(在售/停售)一个人工开关,泳道与体检一律现算——
 *    存了就会过期,过期就是洞。
 *
 * 🔴 地基第 3 条:体检提醒,不拦路。灯写在脸上,不锁任何操作。
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
  /** 在用物料的账号,逗号串(如 "A,B") —— 体检算物料齐要它,免得每行再查一次库 */
  物料账号: string | null;
  图数: number;
  题卷数: number;
  答卷数: number;
  合订数: number;
  产物数: number;
  成员数: number;
};

const DOC_SELECT = `
  d.id, d.名称, d.类型, d.组名, d.版本名, d.科目, d.年级, d.考点, d.册型,
  d.人工态, d.day_spec, d.源文件路径, d.网盘链接, d.提取码, d.线上book_id,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id) AS 题数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '绿') AS 绿数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '红') AS 红数,
  (SELECT COUNT(*) FROM material m WHERE m.doc_id = d.id AND m.is_active = 1) AS 物料数,
  (SELECT group_concat(DISTINCT m.账号) FROM material m WHERE m.doc_id = d.id AND m.is_active = 1) AS 物料账号,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 IN ('图A','图B')) AS 图数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '题目卷') AS 题卷数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '答案卷') AS 答卷数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '合订卷') AS 合订数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id) AS 产物数,
  (SELECT COUNT(*) FROM doc_member dm WHERE dm.合刊doc_id = d.id) AS 成员数`;

export type LibraryFilter = {
  类型?: string;
  科目?: string;
  年级?: string;
  状态?: string;
};

// ------------------------------------------------------------------ 体检(分档)

/**
 * 体检三态:
 *   绿 = 过了;缺 = 还差这一项(黄灯,提醒不拦路);免 = 这类资料本来就不查这项,不参与判定。
 */
export type CheckState = "绿" | "缺" | "免";
export type Check = { 名: string; 态: CheckState; 说明: string };


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

// ---- 单项体检(各档按需拼装)

/** 题目齐:有 day_spec 就按规格核对题数,没有就退化成"入没入库"。 */
function chk题目齐(d: DocRow): Check {
  const spec = parseDaySpec(d.day_spec);
  const 应有 = spec ? spec.天数 * Object.values(spec.每天 || {}).reduce((a, b) => a + b, 0) : null;
  if (应有) {
    return {
      名: "题目齐",
      态: d.题数 >= 应有 ? "绿" : "缺",
      说明: `${d.题数} / ${应有} 题(${spec!.天数} 天规格)`,
    };
  }
  return {
    名: "题目齐",
    态: d.题数 > 0 ? "绿" : "缺",
    说明: d.题数 > 0 ? `${d.题数} 题(无 day_spec,按题数判)` : "题目未入库",
  };
}

/**
 * 实算绿。
 * `无题时` 决定这类资料"题还没入库"算什么:
 *   打卡 = 缺(题就是商品,没题等于没做完);专项 = 免(题级回收是随使用的事,不该拖着它变红)。
 */
function chk实算(d: DocRow, 无题时: CheckState): Check {
  const 待算 = d.题数 - d.绿数 - d.红数;
  if (d.题数 === 0) {
    return { 名: "实算绿", 态: 无题时, 说明: 无题时 === "免" ? "题未拆到题级,不判" : "无题可算" };
  }
  return {
    名: "实算绿",
    态: d.红数 === 0 && 待算 === 0 ? "绿" : "缺",
    说明: `绿 ${d.绿数} / 红 ${d.红数} / 待算 ${待算}`,
  };
}

function chk物料齐(账号: Set<string>): Check {
  return {
    名: "物料齐",
    态: 账号.has("A") && 账号.has("B") ? "绿" : "缺",
    说明: 账号.size
      ? `在用 ${[...账号].sort().join("/")} 号${账号.size < 2 ? "(缺一号)" : ""}`
      : "没有在用物料",
  };
}

function chk网盘挂(d: DocRow): Check {
  return {
    名: "网盘挂",
    态: d.网盘链接 ? "绿" : "缺",
    说明: d.网盘链接 ? `已挂${d.提取码 ? ` · 码 ${d.提取码}` : ""}` : "没有网盘链接",
  };
}

/**
 * 产物在:题目卷 + 答案卷 成对,或一份题解合订的卷。
 * 只有逐页图没有卷的(如把五册打包卖的合集,自己不出卷)也算产出 —— 交付图在就是交付过。
 */
function chk产物在(d: DocRow): Check {
  const 成对 = d.题卷数 > 0 && d.答卷数 > 0;
  const 合订 = d.合订数 > 0;
  const 页图 = d.产物数 - d.题卷数 - d.答卷数 - d.合订数;
  if (成对) return { 名: "产物在", 态: "绿", 说明: `题目卷 ${d.题卷数} / 答案卷 ${d.答卷数}` };
  if (合订) return { 名: "产物在", 态: "绿", 说明: `合订卷 ${d.合订数} 份` };
  if (页图 > 0) return { 名: "产物在", 态: "绿", 说明: `${页图} 张成品图(无独立卷)` };
  return { 名: "产物在", 态: "缺", 说明: `题目卷 ${d.题卷数} / 答案卷 ${d.答卷数}` };
}

/** 源文件在:Word/原件路径登记了没有(母题池三类靠它找回原稿)。 */
function chk源文件在(d: DocRow): Check {
  return {
    名: "源文件在",
    态: d.源文件路径 ? "绿" : "缺",
    说明: d.源文件路径 ? "已登记路径" : "没登记源文件路径",
  };
}

/** 产物在(宽口径):母题池三类只要有任意产物文件就算,不强求成对。 */
function chk有产物(d: DocRow): Check {
  return {
    名: "产物在",
    态: d.产物数 > 0 ? "绿" : "缺",
    说明: d.产物数 > 0 ? `${d.产物数} 个文件` : "没挂产物文件",
  };
}

/** 档案在:课本只查这一项。 */
function chk档案在(d: DocRow): Check {
  const ok = Boolean(d.源文件路径) || d.产物数 > 0;
  return {
    名: "档案在",
    态: ok ? "绿" : "缺",
    说明: ok ? `已挂档${d.产物数 ? ` · ${d.产物数} 个文件` : ""}` : "没有路径也没有文件",
  };
}

/**
 * 🔴 体检按类型分档(PRD-023 分型处理规程 §7)。
 *
 * 一刀切是上一版最大的洞:专项/试卷根本没有小红书物料和网盘,
 * 拿打卡那四项去量它们,永远红、永远卡在"在产"泳道——已经产完的册子也显示没做完。
 *
 *   打卡(可售商品)        题目齐 / 实算绿 / 物料齐(A+B) / 网盘挂
 *   专项 · 合卷           产物在 / 实算(有题才判,没拆题=免)  —— 不查物料、不查网盘
 *   试卷 · 讲义 · 练习册   源文件在 / 产物在 / 实算=免        —— 规程红线:不逐题实算
 *   课本                  档案在                              —— 规程红线:绝不判"题量>0"
 */
export function checksOf(d: DocRow): Check[] {
  switch (d.类型) {
    case "打卡": {
      const accounts = new Set((d.物料账号 || "").split(",").filter(Boolean));
      return [chk题目齐(d), chk实算(d, "缺"), chk物料齐(accounts), chk网盘挂(d)];
    }
    case "专项":
      // 合卷 = 类型专项 + 册型合刊,同档(规程 §1:题级回收随使用,不拿它压红灯)
      return [chk产物在(d), chk实算(d, "免")];
    case "试卷":
    case "讲义":
    case "练习册":
      // 规程红线③:试卷/讲义不逐题实算,否则永远做不完 —— 实算只做提示,不参与判定
      return [chk源文件在(d), chk有产物(d), { ...chk实算(d, "免"), 态: "免" as CheckState }];
    case "课本":
      // 规程红线①:课本挂档不拆题,零 question 行是正常态
      return [chk档案在(d)];
    default:
      return [chk有产物(d)];
  }
}

/**
 * 现算泳道态。
 * 人工态优先(在售/停售是人拍的板);其余按"这一档的体检过没过"推:
 * 全绿(免的不算)= 可发布,否则 = 在产。
 */
export function laneOf(d: DocRow, checks?: Check[]): "在售" | "停售" | "可发布" | "在产" {
  if (d.人工态 === "在售") return "在售";
  if (d.人工态 === "停售") return "停售";
  const cs = checks ?? checksOf(d);
  const 待判 = cs.filter((c) => c.态 !== "免");
  return 待判.length > 0 && 待判.every((c) => c.态 === "绿") ? "可发布" : "在产";
}

// ------------------------------------------------------------------ 列表

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

/** 有组名的按组折叠(打卡多版本 / 同主题多版本卷);其余每份自成一组。 */
export function groupDocs(rows: DocRow[]): { key: string; docs: DocRow[] }[] {
  const map = new Map<string, DocRow[]>();
  for (const r of rows) {
    const key = r.组名 || r.名称;
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

export type MemberLink = {
  id: number;
  名称: string;
  版本名: string | null;
  类型: string;
  题数: number;
};

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
  /** 本册是合刊时:它由哪几册组成(册级,doc_member) */
  成员: MemberLink[];
  /** 本册被哪几本合刊收录(册级,doc_member 反查) */
  被收录: MemberLink[];
};

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

  const MEMBER_COLS = `x.id, x.名称, x.版本名, x.类型,
      (SELECT COUNT(*) FROM question q WHERE q.doc_id = x.id) AS 题数`;
  const 成员 = d
    .prepare(
      `SELECT ${MEMBER_COLS} FROM doc_member m JOIN doc x ON x.id = m.成员doc_id
       WHERE m.合刊doc_id = ? ORDER BY m.排序, x.名称`,
    )
    .all(id) as MemberLink[];
  const 被收录 = d
    .prepare(
      `SELECT ${MEMBER_COLS} FROM doc_member m JOIN doc x ON x.id = m.合刊doc_id
       WHERE m.成员doc_id = ? ORDER BY x.名称`,
    )
    .all(id) as MemberLink[];

  // ---- 体检:按类型分档,每次打开现算,不读任何存下来的状态
  const checks = checksOf(doc);

  return {
    doc,
    lane: laneOf(doc, checks),
    checks,
    materials,
    assets,
    questions,
    天数: parseDaySpec(doc.day_spec)?.天数 ?? null,
    成员,
    被收录,
  };
}
