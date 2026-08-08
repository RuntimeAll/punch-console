/**
 * 存量导入(轻):只搬现成的结构化数据,不做任何深度处理。
 *
 *   pnpm import:all
 *
 * 三路来源:
 *   a. 打卡元数据 = <册>/产线卡.json(v1 铺的 25 张)  -> doc + asset
 *   b. 物料       = web/.data/materials.json(先跑 scripts/parse_materials.py) -> material
 *   c. 题目种子   = 三升四每日一练/_源/days_*.json    -> question(+FTS)
 *
 * 幂等:doc 按(名称,版本名)upsert;asset/material 是文件投影,按 doc 先删后插;
 *      question 按(doc_id,day,section,seq)upsert —— 保住 id 与已算好的向量。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { db, rawDb } from "../src/db/client";
import { rebuildFts } from "../src/db/fts";
import { DB_PATH, PUNCH_ROOT } from "../src/db/paths";
import { asset, doc, material, question } from "../src/db/schema";

const WEB = path.resolve(__dirname, "..");
const MATERIALS_JSON = path.join(WEB, ".data", "materials.json");
const SEED_BOOK = "三升四每日一练";

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

/** upsert 一行 doc,返回 id。 */
function upsertDoc(row: typeof doc.$inferInsert): number {
  const res = db
    .insert(doc)
    .values(row)
    .onConflictDoUpdate({
      target: [doc.name, doc.version],
      set: {
        type: row.type,
        group: row.group,
        subject: row.subject,
        grade: row.grade,
        kps: row.kps,
        form: row.form,
        manualState: row.manualState,
        daySpec: row.daySpec,
        srcPath: row.srcPath,
        panUrl: row.panUrl,
        panPwd: row.panPwd,
        onlineBookId: row.onlineBookId,
      },
    })
    .returning({ id: doc.id })
    .all();
  return res[0].id;
}

function importCards() {
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
    const versions = (card.版本 || []).filter((v) => v && typeof v === "object");
    for (const v of versions.length ? versions : [{ key: "正册" } as CardVersion]) {
      const vkey = v.key || "正册";
      const kps = card.绑定?.值 || [];
      const docId = upsertDoc({
        name,
        type: "打卡",
        group: name,
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

      // asset 是文件投影,重跑先清后建
      db.delete(asset).where(eq(asset.docId, docId)).run();
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

      if (rows.length) {
        // 同册同类型同路径可能被上面两条来源撞上,去个重
        const seen = new Set<string>();
        const uniq = rows.filter((r) => {
          const k = `${r.type}|${r.path}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        db.insert(asset).values(uniq).run();
        assets += uniq.length;
      }
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

// ------------------------------------------------------------------ main

function counts() {
  const d = rawDb();
  const names = [
    "doc",
    "question",
    "collection_item",
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
}

function main() {
  console.log(`[import] 库 = ${DB_PATH}`);
  console.log(`[import] 打卡根 = ${PUNCH_ROOT}`);
  importCards();
  importMaterials();
  importSeedQuestions();
  const n = rebuildFts(rawDb());
  console.log(`[fts] 重建索引 ${n} 题`);
  counts();
}

main();
