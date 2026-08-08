/**
 * 存量导入(轻):只搬现成的结构化数据,不做任何深度处理。
 *
 *   pnpm import:all
 *
 * 五路来源:
 *   a. 打卡元数据 = <册>/产线卡.json(v1 铺的 25 张)  -> doc + asset
 *   b. 物料       = web/.data/materials.json(先跑 scripts/parse_materials.py) -> material
 *   c. 题目种子   = 三升四每日一练/_源/days_*.json    -> question(+FTS)
 *   d. 专项       = 举一反三产物/专项卷/<专项名>/     -> doc(类型=专项) + asset
 *   e. 专项合刊   = 举一反三产物/合卷/(成对 PDF)      -> doc(类型=专项,册型=合刊) + asset
 *   f. 册级归属   = 合刊源码里写明的成员册            -> doc_member
 *
 * 幂等:doc 按(名称,版本名)upsert;asset/material 是文件投影,按 doc 先删后插;
 *      question 按(doc_id,day,section,seq)upsert —— 保住 id 与已算好的向量;
 *      doc_member 按(合刊,成员)upsert。重跑不翻倍、不动已有题与向量。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { db, rawDb } from "../src/db/client";
import { rebuildFts } from "../src/db/fts";
import { DB_PATH, PUNCH_ROOT } from "../src/db/paths";
import { asset, doc, docMember, material, question } from "../src/db/schema";

const WEB = path.resolve(__dirname, "..");
const MATERIALS_JSON = path.join(WEB, ".data", "materials.json");
const SEED_BOOK = "三升四每日一练";

/** 举一反三产物根 = 打卡根的上一级(专项卷/合卷都在它下面) */
const OUT_ROOT = path.dirname(PUNCH_ROOT);
const SPECIAL_ROOT = path.join(OUT_ROOT, "专项卷");
const COLLECTION_ROOT = path.join(OUT_ROOT, "合卷");

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// ------------------------------------------------------------------ 小工具

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 归一化:NFKC 统一全半角 + 去掉所有空白。查重口径。 */
export function normalizeStem(s: string): string {
  return (s || "").normalize("NFKC").replace(/\s+/g, "");
}

function hashL1(s: string): string {
  return createHash("sha1").update(normalizeStem(s), "utf8").digest("hex");
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

// ------------------------------------------------------------------ 产线卡类型

type CardVersion = {
  key?: string;
  book_id?: string;
  网盘?: { 链接?: string; 码?: string };
  物料文件?: string;
  图目录?: { A?: string; B?: string };
};
type Card = {
  name?: string;
  科目?: string;
  年级?: string;
  绑定?: { 类型?: string; 值?: string[] };
  状态?: string;
  版本?: CardVersion[];
};

// ------------------------------------------------------------------ a. 打卡元数据

function listBookDirs(): string[] {
  if (!fs.existsSync(PUNCH_ROOT)) return [];
  return fs
    .readdirSync(PUNCH_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name !== "网盘分发记录")
    .map((e) => path.join(PUNCH_ROOT, e.name))
    .sort();
}

/** 找该册该版本的成品 PDF,照 v1 的查找顺序。 */
function findPdfs(bookDir: string, versionKey: string): string[] {
  const prod = path.join(bookDir, "成品PDF");
  let files: string[] = [];
  if (fs.existsSync(prod)) {
    const sub = path.join(prod, versionKey);
    files = walkFiles(fs.existsSync(sub) ? sub : prod).filter(
      (f) => path.extname(f).toLowerCase() === ".pdf",
    );
  }
  if (!files.length) {
    files = walkFiles(bookDir)
      .filter((f) => path.dirname(f) === bookDir && path.extname(f).toLowerCase() === ".pdf");
    if (versionKey !== "正册" && files.some((f) => path.basename(f).includes(versionKey))) {
      files = files.filter((f) => path.basename(f).includes(versionKey));
    }
  }
  return files;
}

/**
 * upsert 一行 doc,返回 id。
 *
 * `保留人工列`:专项/合卷没有产线卡,人工态与网盘是人在界面上填的——
 * 重跑导入不许拿 null 把人填的东西冲掉(打卡那条线的产线卡才是这些列的事实源)。
 */
function upsertDoc(row: typeof doc.$inferInsert, 保留人工列 = false): number {
  const base = {
    type: row.type,
    group: row.group,
    subject: row.subject,
    grade: row.grade,
    kps: row.kps,
    form: row.form,
    daySpec: row.daySpec,
    srcPath: row.srcPath,
  };
  const set = 保留人工列
    ? base
    : {
        ...base,
        manualState: row.manualState,
        panUrl: row.panUrl,
        panPwd: row.panPwd,
        onlineBookId: row.onlineBookId,
      };
  const res = db
    .insert(doc)
    .values(row)
    .onConflictDoUpdate({ target: [doc.name, doc.version], set })
    .returning({ id: doc.id })
    .all();
  return res[0].id;
}

/** 整册重挂 asset(文件投影,先清后建);返回落了几行。 */
function replaceAssets(docId: number, rows: (typeof asset.$inferInsert)[]): number {
  db.delete(asset).where(eq(asset.docId, docId)).run();
  if (!rows.length) return 0;
  const seen = new Set<string>();
  const uniq = rows.filter((r) => {
    const k = `${r.type}|${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  db.insert(asset).values(uniq).run();
  return uniq.length;
}

// ------------------------------------------------------------------ 年级/角色识别

const CN_NUM = "一二三四五六七八九";

/**
 * 从册名(或总结.md 正文)推年级。推不出就 null —— 宁可空着,不瞎猜。
 * `严` = 只认「X年级上/下」「X上 ·」这种明写的(给正文用,躲开"以上""上题"这类误命中);
 * 宽口径只用在册名上(册名里的「五上」「七上」就是年级)。
 */
function inferGrade(text: string, 严 = false): string | null {
  const 册 = (n: string, ud: string) => `${n}年级${ud}册`;
  let m = text.match(new RegExp(`([${CN_NUM}])年级(上|下)`));
  if (m) return 册(m[1], m[2]);
  m = text.match(new RegExp(`([${CN_NUM}])(上|下)\\s*[·•]`));
  if (m) return 册(m[1], m[2]);
  if (!严) {
    m = text.match(new RegExp(`([${CN_NUM}])(上|下)`));
    if (m) return 册(m[1], m[2]);
  }
  m = text.match(new RegExp(`([${CN_NUM}])年级`));
  return m ? `${m[1]}年级` : null;
}

/** 读该册的 总结.md 找年级线索(册名推不出时的第二证据)。 */
function gradeFromSummary(dir: string): string | null {
  for (const f of ["总结.md", "大纲.md"]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      return inferGrade(fs.readFileSync(p, "utf-8").slice(0, 800), true);
    } catch {
      /* 读不了就当没有 */
    }
  }
  return null;
}

type Role = "题目卷" | "答案卷" | "合订卷";

/**
 * 从文件名拆出「册名 + 角色」。
 *   `七上有理数四专项（题目）`      -> 七上有理数四专项 / 题目卷
 *   `一元一次方程的应用（一）（答案）` -> 一元一次方程的应用（一） / 答案卷   (括号是懒匹配 + 锚在结尾,只吃最后一个)
 *   `五年级举一反三合集（题目+解析）` -> 五年级举一反三合集 / 合订卷        (题解装订在一份里)
 *   `乘法数字谜变式·题目图`         -> 原名 / 题目卷                      (老件没用括号,退到全名找角色词)
 */
function splitRole(stem: string): { base: string; role: Role } {
  const judge = (tag: string): Role | null => {
    const 有题 = /题目|学生练习/.test(tag);
    const 有答 = /解析|答案/.test(tag);
    if (有题 && 有答) return "合订卷";
    if (有答) return "答案卷";
    if (有题) return "题目卷";
    return null;
  };
  const m = stem.match(/^(.*?)[（(]([^（）()]+)[）)]$/);
  if (m) {
    const r = judge(m[2]);
    if (r) return { base: m[1].trim(), role: r };
  }
  return { base: stem, role: judge(stem) ?? "合订卷" };
}

/**
 * 打卡·同主题多版本归组(2026-08-08 问题4)。
 *
 * 实地证据:`打卡一B-长度测量-平行卷` / `打卡一C-长度测量-变式卷` 册名与内容都是**长度测量**,
 * 是打卡一的平行卷与变式卷 —— 同一主题的三个版本,不是"打卡一二三的合集"。
 * 真正把五天并起来的是 `科学测量合刊`(其 _源/build.py 的 DAYS 明写五个成员),走 doc_member。
 */
const 打卡归组: Record<string, { 组名: string; 版本名: string }> = {
  "打卡一-长度测量": { 组名: "打卡一·长度测量", 版本名: "原卷" },
  "打卡一B-长度测量-平行卷": { 组名: "打卡一·长度测量", 版本名: "平行卷" },
  "打卡一C-长度测量-变式卷": { 组名: "打卡一·长度测量", 版本名: "变式卷" },
};

/**
 * 老行版本名迁移:doc 的幂等键是(名称,版本名),把「正册」改成「平行卷」这类改名
 * 必须先就地 UPDATE,否则 upsert 撞不上老行会插出一条重复的。
 * 同名多行时不动(有歧义交给人),已迁过则跳过 —— 重跑安全。
 */
function 迁移归组版本名() {
  const d = rawDb();
  for (const [name, g] of Object.entries(打卡归组)) {
    const rows = d.prepare(`SELECT id, 版本名 FROM doc WHERE 名称 = ?`).all(name) as {
      id: number;
      版本名: string | null;
    }[];
    if (rows.length !== 1 || rows[0].版本名 === g.版本名) continue;
    d.prepare(`UPDATE doc SET 版本名 = ? WHERE id = ?`).run(g.版本名, rows[0].id);
    console.log(`[a] 版本名迁移 ${name}: ${rows[0].版本名} -> ${g.版本名}`);
  }
}

function importCards() {
  迁移归组版本名();
  const dirs = listBookDirs();
  let docs = 0;
  let assets = 0;
  let noCard = 0;

  for (const bdir of dirs) {
    const name = path.basename(bdir);
    const card = readJson<Card>(path.join(bdir, "产线卡.json"));
    if (!card) {
      noCard++;
      continue;
    }
    const 归组 = 打卡归组[name];
    const versions = (card.版本 || []).filter((v) => v && typeof v === "object");
    for (const v of versions.length ? versions : [{ key: "正册" } as CardVersion]) {
      const vkey = 归组?.版本名 || v.key || "正册";
      const kps = card.绑定?.值 || [];
      const docId = upsertDoc({
        name,
        type: "打卡",
        group: 归组?.组名 || name,
        version: vkey,
        subject: card.科目 || null,
        grade: card.年级 || null,
        kps: kps.length ? JSON.stringify(kps) : null,
        form: name.includes("合刊") ? "合刊" : "单册",
        // 只有「在售」是人工态;其余(在产/可发布)都是现算,不落库
        manualState: card.状态 === "在售" ? "在售" : card.状态 === "停售" ? "停售" : null,
        srcPath: bdir,
        panUrl: v.网盘?.链接 || null,
        panPwd: v.网盘?.码 || null,
        onlineBookId: v.book_id || null,
      });
      docs++;

      const rows: (typeof asset.$inferInsert)[] = [];

      for (const role of ["A", "B"] as const) {
        const rel = v.图目录?.[role];
        if (!rel) continue;
        const dir = path.join(bdir, rel);
        if (!fs.existsSync(dir)) continue;
        const imgs = walkFiles(dir).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()));
        imgs.forEach((f, i) => {
          rows.push({ docId, type: `图${role}`, path: f, order: i + 1 });
        });
      }

      for (const pdf of findPdfs(bdir, vkey)) {
        const base = path.basename(pdf);
        const type = /答案|解析/.test(base) ? "答案卷" : "题目卷";
        rows.push({ docId, type, path: pdf, order: null });
      }

      // asset 是文件投影,重跑先清后建(同册同类型同路径会被两条来源撞上,replaceAssets 里去重)
      assets += replaceAssets(docId, rows);
    }
  }
  console.log(`[a] 册目录 ${dirs.length} 个(无卡 ${noCard})-> doc ${docs} 行, asset ${assets} 行`);
}

// ------------------------------------------------------------------ b. 物料

type MatRow = {
  册名: string;
  版本: string;
  文件: string;
  分享语: string;
  网盘: { 链接: string; 码: string };
  book_id: string;
  商品描述: string;
  文案: Record<"A" | "B", { 标题: string; 正文: string; 话题: string[] }>;
};

function importMaterials() {
  const parsed = readJson<{
    rows: MatRow[];
    ok_books: number;
    skip_books: number;
    skipped: string[];
  }>(MATERIALS_JSON);
  if (!parsed) {
    console.log(`[b] 跳过:没有 ${MATERIALS_JSON}(先跑 python scripts/parse_materials.py)`);
    return;
  }

  let mats = 0;
  let missDoc = 0;
  for (const r of parsed.rows) {
    const hit = db
      .select({ id: doc.id })
      .from(doc)
      .where(sql`${doc.name} = ${r.册名} AND ${doc.version} = ${r.版本}`)
      .all();
    if (!hit.length) {
      missDoc++;
      continue;
    }
    const docId = hit[0].id;
    db.delete(material).where(eq(material.docId, docId)).run();

    const rows: (typeof material.$inferInsert)[] = [];
    for (const acc of ["A", "B"] as const) {
      const c = r.文案[acc];
      if (!c || (!c.标题?.trim() && !c.正文?.trim())) continue;
      rows.push({
        docId,
        account: acc,
        isActive: 1,
        title: c.标题 || null,
        body: c.正文 || null,
        topics: c.话题?.length ? JSON.stringify(c.话题) : null,
        goodsDesc: r.商品描述 || null,
        panShare: r.分享语 || null,
        burned: 0,
      });
    }
    if (rows.length) {
      db.insert(material).values(rows).run();
      mats += rows.length;
    }

    // 物料里抽到的网盘/book_id 可以回填 doc 上的空位(产线卡没填的册)
    db.run(sql`UPDATE doc SET
        网盘链接   = COALESCE(NULLIF(网盘链接,''),   ${r.网盘.链接 || null}),
        提取码     = COALESCE(NULLIF(提取码,''),     ${r.网盘.码 || null}),
        线上book_id = COALESCE(NULLIF(线上book_id,''), ${r.book_id || null})
      WHERE id = ${docId}`);
  }
  console.log(
    `[b] 物料册 成功 ${parsed.ok_books} / 跳过 ${parsed.skip_books} -> material ${mats} 行` +
      (missDoc ? ` (对不上 doc ${missDoc} 条)` : ""),
  );
}

// ------------------------------------------------------------------ c. 题目种子

type Day = {
  day: number;
  goals?: string[];
  app_title?: string;
  oral?: string[];
  vert?: string[];
  step?: string[];
  app?: string[];
};

const SECTION_TYPE: Record<string, string> = {
  oral: "口算",
  vert: "竖式",
  step: "脱式",
  app: "应用",
};

function importSeedQuestions() {
  const srcDir = path.join(PUNCH_ROOT, SEED_BOOK, "_源");
  const files: [string, string][] = [
    ["基础版", path.join(srcDir, "days_基础版.json")],
    ["提高版", path.join(srcDir, "days_提高版.json")],
  ];

  let total = 0;
  for (const [vkey, file] of files) {
    const days = readJson<Day[]>(file);
    if (!days) {
      console.log(`[c] 缺 ${file},跳过`);
      continue;
    }
    const hit = db
      .select({ id: doc.id })
      .from(doc)
      .where(sql`${doc.name} = ${SEED_BOOK} AND ${doc.version} = ${vkey}`)
      .all();
    if (!hit.length) {
      console.log(`[c] 找不到 doc ${SEED_BOOK}/${vkey},跳过`);
      continue;
    }
    const docId = hit[0].id;

    // day_spec + 册级考点(取自源里每天写明的 goals,不是我猜的)
    const perDay: Record<string, number> = {};
    const goals = new Set<string>();
    for (const d of days) {
      for (const s of ["oral", "vert", "step", "app"] as const) {
        perDay[s] = Math.max(perDay[s] || 0, (d[s] || []).length);
      }
      (d.goals || []).forEach((g) => goals.add(g));
    }
    db.update(doc)
      .set({
        daySpec: JSON.stringify({ 天数: days.length, 每天: perDay }),
        kps: goals.size ? JSON.stringify([...goals]) : null,
        layoutKey: "daily_v1",
      })
      .where(eq(doc.id, docId))
      .run();

    const rows: (typeof question.$inferInsert)[] = [];
    for (const d of days) {
      for (const s of ["oral", "vert", "step", "app"] as const) {
        const list = d[s] || [];
        list.forEach((stem, i) => {
          const text = String(stem || "").trim();
          if (!text) return;
          rows.push({
            docId,
            day: d.day,
            section: s,
            seq: i + 1,
            stem: text,
            qtype: SECTION_TYPE[s],
            // 只有应用题的考点是源里明写的(app_title),别的不瞎标
            kps: s === "app" && d.app_title ? JSON.stringify([d.app_title]) : null,
            source: "出题器反抽-2026-08",
            calc: "绿",
            hashL1: hashL1(text),
          });
        });
      }
    }

    const tx = rawDb().transaction(() => {
      for (const r of rows) {
        db.insert(question)
          .values(r)
          .onConflictDoUpdate({
            target: [question.docId, question.day, question.section, question.seq],
            set: {
              stem: r.stem,
              qtype: r.qtype,
              kps: r.kps,
              source: r.source,
              calc: r.calc,
              hashL1: r.hashL1,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })
          .run();
      }
    });
    tx();
    total += rows.length;
    console.log(`[c] ${SEED_BOOK}/${vkey}: ${days.length} 天 -> question ${rows.length} 行`);
  }
  return total;
}

// ------------------------------------------------------------------ d. 专项卷

/**
 * 科目一律「数学」:专项卷/合卷两个目录是**数学举一反三** skill 的产物根
 * (CLAUDE.md 与 skill 说明都写死了这条落盘规则),实地抽查 21 个专项的源码与总结
 * 也全是数学题源;科学线的产物落在 打卡/ 下面(见 打卡一-长度测量 等)。
 * 不是猜的,是这两个目录的定义。
 */
const 专项科目 = "数学";

/** 专项册里要挂的产物文件:PDF 全收;图只收册根(老件出图不出 PDF)与 _交付/。 */
function specialAssets(docId: number, dir: string): (typeof asset.$inferInsert)[] {
  const rows: (typeof asset.$inferInsert)[] = [];
  let 页图序 = 0;
  for (const full of walkFiles(dir)) {
    const rel = path.relative(dir, full).replace(/\\/g, "/");
    // _源 = 生成脚本与中间 HTML,figs = 配图素材,都不是交付产物
    if (rel.startsWith("_源/") || rel.startsWith("figs/") || rel.includes("/figs/")) continue;
    const ext = path.extname(full).toLowerCase();
    const stem = path.basename(full, path.extname(full));
    if (ext === ".pdf") {
      rows.push({ docId, type: splitRole(stem).role, path: full, order: null });
    } else if (IMG_EXT.has(ext)) {
      if (rel.startsWith("_交付/")) {
        rows.push({ docId, type: "页图", path: full, order: ++页图序 });
      } else if (!rel.includes("/")) {
        // 册根直接放的题目图/答案图 = 这册的成品(如 乘法数字谜)
        rows.push({ docId, type: splitRole(stem).role, path: full, order: null });
      }
    }
  }
  return rows;
}

function importSpecials() {
  if (!fs.existsSync(SPECIAL_ROOT)) {
    console.log(`[d] 跳过:没有 ${SPECIAL_ROOT}`);
    return;
  }
  const dirs = fs
    .readdirSync(SPECIAL_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => path.join(SPECIAL_ROOT, e.name))
    .sort();

  let docs = 0;
  let assets = 0;
  for (const dir of dirs) {
    const name = path.basename(dir);
    const docId = upsertDoc(
      {
        name,
        type: "专项",
        version: "正册",
        subject: 专项科目,
        // 册名推不出年级就翻这册的总结.md;两处都没有明写就留空,不瞎猜
        grade: inferGrade(name) || gradeFromSummary(dir),
        form: "单册",
        srcPath: dir,
      },
      true,
    );
    docs++;
    assets += replaceAssets(docId, specialAssets(docId, dir));
  }
  console.log(`[d] 专项卷 ${dirs.length} 个目录 -> doc ${docs} 行, asset ${assets} 行`);
}

// ------------------------------------------------------------------ e. 合卷(专项合刊)

/**
 * 合卷目录 = 把几个专项并成一册的成品。一册 = 一组同名 PDF(题目/解析成对,或题解合订一份)。
 * 按 类型=专项 + 册型=合刊 登记 —— 它是专项的合订形态,不是打卡。
 */
function importCollections() {
  if (!fs.existsSync(COLLECTION_ROOT)) {
    console.log(`[e] 跳过:没有 ${COLLECTION_ROOT}`);
    return;
  }
  const ents = fs.readdirSync(COLLECTION_ROOT, { withFileTypes: true });

  // ① 根目录成对 PDF:按去掉「（题目）/（解析）」后的册名归堆
  const byBook = new Map<string, { path: string; role: Role }[]>();
  for (const e of ents) {
    if (!e.isFile() || path.extname(e.name).toLowerCase() !== ".pdf") continue;
    const { base, role } = splitRole(path.basename(e.name, path.extname(e.name)));
    const list = byBook.get(base) || [];
    list.push({ path: path.join(COLLECTION_ROOT, e.name), role });
    byBook.set(base, list);
  }

  // ② `_交付-<册名>/` 也是一册(只出图不出 PDF 的合集,如 七上计算五件套合集)
  const 交付图: Map<string, string> = new Map();
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^_交付-(.+)$/);
    if (m) {
      交付图.set(m[1], path.join(COLLECTION_ROOT, e.name));
      if (!byBook.has(m[1])) byBook.set(m[1], []);
    }
  }

  // ③ `<册名>-图片/` 是某册的逐页图,挂到册名对得上的那册身上
  const 页图目录: [string, string][] = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const m = e.name.match(/^(.+?)-图片$/);
    if (m) 页图目录.push([m[1], path.join(COLLECTION_ROOT, e.name)]);
  }

  let docs = 0;
  let assets = 0;
  for (const [name, pdfs] of [...byBook.entries()].sort()) {
    const 交付 = 交付图.get(name);
    const docId = upsertDoc(
      {
        name,
        type: "专项",
        version: "正册",
        subject: 专项科目,
        grade: inferGrade(name),
        form: "合刊",
        srcPath: 交付 || COLLECTION_ROOT,
      },
      true,
    );
    docs++;

    const rows: (typeof asset.$inferInsert)[] = pdfs.map((p) => ({
      docId,
      type: p.role,
      path: p.path,
      order: null,
    }));
    let 序 = 0;
    const 图源: string[] = [];
    if (交付) 图源.push(交付);
    for (const [key, dir] of 页图目录) if (name.includes(key)) 图源.push(dir);
    for (const dir of 图源) {
      for (const f of walkFiles(dir)) {
        if (IMG_EXT.has(path.extname(f).toLowerCase())) {
          rows.push({ docId, type: "页图", path: f, order: ++序 });
        }
      }
    }
    assets += replaceAssets(docId, rows);
  }
  console.log(`[e] 合卷 -> doc ${docs} 行(册型=合刊), asset ${assets} 行`);
}

// ------------------------------------------------------------------ f. 册级归属 doc_member

/**
 * 🔴 doc_member = **册级**归属(这本合刊由哪几册组成),给人读、给导航用;
 *    collection_item = **题级**引用(这一页印哪几道题),给渲染用。
 *    两者互补不冲突:成员册一道题都还没入库时,册级关系照样成立(科学测量合刊就是这种);
 *    等题级数据齐了,排版取题以 collection_item 为准。
 */
function findDocByName(name: string): number | null {
  const rows = rawDb().prepare(`SELECT id FROM doc WHERE 名称 = ?`).all(name) as { id: number }[];
  return rows.length === 1 ? rows[0].id : null;
}

/** 册名模糊定位:目录里只写了「有理数混合运算」,库里叫「七上有理数混合运算打卡」。唯一命中才认。 */
function findPunchDocLike(key: string): number | null {
  const rows = rawDb()
    .prepare(`SELECT id FROM doc WHERE 类型 = '打卡' AND 名称 LIKE ?`)
    .all(`%${key}%`) as { id: number }[];
  return rows.length === 1 ? rows[0].id : null;
}

function upsertMembers(合刊名: string, 成员: { id: number; 名: string }[]): number {
  const 合刊id = findDocByName(合刊名);
  if (!合刊id) {
    console.log(`[f] 找不到合刊 doc「${合刊名}」,跳过`);
    return 0;
  }
  let n = 0;
  成员.forEach((m, i) => {
    db.insert(docMember)
      .values({ collectionId: 合刊id, memberId: m.id, order: i + 1 })
      .onConflictDoUpdate({
        target: [docMember.collectionId, docMember.memberId],
        set: { order: i + 1 },
      })
      .run();
    n++;
  });
  return n;
}

/** 科学测量合刊:成员写在 _源/build.py 的 DAYS 里,直接读源不硬编码。 */
function membersOfScienceCollection(): { id: number; 名: string }[] {
  const build = path.join(PUNCH_ROOT, "科学测量合刊", "_源", "build.py");
  if (!fs.existsSync(build)) return [];
  const src = fs.readFileSync(build, "utf-8");
  const block = src.match(/DAYS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  const out: { id: number; 名: string }[] = [];
  for (const m of block[1].matchAll(/\(\s*"[^"]*"\s*,\s*"([^"]+)"/g)) {
    const 名 = m[1];
    const id = findDocByName(名);
    if (id) out.push({ id, 名 });
    else console.log(`[f] 科学测量合刊成员「${名}」在库里找不到 doc`);
  }
  return out;
}

/** 七上计算合刊(一本通):成员与顺序写在 _源/toc.teacher.json 里。 */
function membersOfCalcCollection(): { id: number; 名: string }[] {
  const toc = path.join(PUNCH_ROOT, "七上计算合刊", "_源", "toc.teacher.json");
  const list = readJson<{ no: number; book: string }[]>(toc);
  if (!list) return [];
  const out: { id: number; 名: string }[] = [];
  for (const t of [...list].sort((a, b) => a.no - b.no)) {
    const id = findPunchDocLike(t.book);
    if (id) out.push({ id, 名: t.book });
    else console.log(`[f] 七上计算合刊成员「${t.book}」对不到唯一 doc,跳过`);
  }
  return out;
}

function importDocMembers() {
  let n = 0;
  n += upsertMembers("科学测量合刊", membersOfScienceCollection());
  n += upsertMembers("七上计算合刊", membersOfCalcCollection());
  console.log(`[f] 册级归属 doc_member -> ${n} 行`);
}

// ------------------------------------------------------------------ main

function counts() {
  const d = rawDb();
  const names = [
    "doc",
    "question",
    "collection_item",
    "doc_member",
    "material",
    "asset",
    "task",
    "generator",
    "publish_log",
    "question_fts",
  ];
  console.log("--- 各表行数 ---");
  for (const n of names) {
    const r = d.prepare(`SELECT COUNT(*) AS c FROM ${n}`).get() as { c: number };
    console.log(`  ${n.padEnd(16)} ${r.c}`);
  }
  console.log("--- doc 按类型 ---");
  for (const r of d
    .prepare(`SELECT 类型, COUNT(*) c FROM doc GROUP BY 类型 ORDER BY c DESC`)
    .all() as { 类型: string; c: number }[]) {
    console.log(`  ${r.类型.padEnd(16)} ${r.c}`);
  }
}

function main() {
  console.log(`[import] 库 = ${DB_PATH}`);
  console.log(`[import] 打卡根 = ${PUNCH_ROOT}`);
  importCards();
  importMaterials();
  importSeedQuestions();
  importSpecials();
  importCollections();
  importDocMembers();
  const n = rebuildFts(rawDb());
  console.log(`[fts] 重建索引 ${n} 题`);
  counts();
}

main();
