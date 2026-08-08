/**
 * FTS5 关键词轴 —— 应用层分词 + 手工同步(0 触发器)。
 *
 * 为什么要自己分词:SQLite 内置 unicode61 把一整串汉字当成一个 token,
 * 「三位数乘两位数」只会索引成一个词,搜「乘法」永远命中不了。
 * 所以入库前把中文切成 bigram(相邻两字),英数原样保留,空格拼接后交给 FTS5。
 * 查询端用同一把切法,口径才对得上。
 */
import type Database from "better-sqlite3";

import { FTS_TABLE } from "./schema";

const CJK = /[㐀-䶿一-鿿぀-ヿ豈-﫿]/;
const ALNUM = /[0-9A-Za-z]/;

/** 把一段题面切成 FTS 能用的 token 序列。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const s = (text || "").normalize("NFKC");
  let buf = "";
  const flushAlnum = () => {
    if (buf) {
      out.push(buf.toLowerCase());
      buf = "";
    }
  };
  const cjkRun: string[] = [];
  const flushCjk = () => {
    if (!cjkRun.length) return;
    if (cjkRun.length === 1) {
      out.push(cjkRun[0]);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        out.push(cjkRun[i] + cjkRun[i + 1]);
      }
    }
    cjkRun.length = 0;
  };

  for (const ch of s) {
    if (CJK.test(ch)) {
      flushAlnum();
      cjkRun.push(ch);
    } else if (ALNUM.test(ch)) {
      flushCjk();
      buf += ch;
    } else {
      flushAlnum();
      flushCjk();
    }
  }
  flushAlnum();
  flushCjk();
  return out;
}

/** 入库用:分好词的一行文本。 */
export function toFtsText(text: string): string {
  return tokenize(text).join(" ");
}

/**
 * 查询用:拼 FTS5 MATCH 表达式。
 * 短查询(<=3 token)用 AND 求准;长查询用 OR 求全,靠 bm25 排序拉回精度。
 */
export function toMatchExpr(q: string): string | null {
  const toks = Array.from(new Set(tokenize(q)));
  if (!toks.length) return null;
  const quoted = toks.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(quoted.length <= 3 ? " AND " : " OR ");
}

/** 建 FTS5 虚表(幂等)。 */
export function ensureFts(d: Database.Database): void {
  d.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(stem, tokenize='unicode61');`,
  );
}

/** 单题同步(先删后插,rowid = question.id)。 */
export function syncFtsRow(
  d: Database.Database,
  questionId: number,
  stem: string,
): void {
  d.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(questionId);
  d.prepare(`INSERT INTO ${FTS_TABLE}(rowid, stem) VALUES (?, ?)`).run(
    questionId,
    toFtsText(stem),
  );
}

/** 全量重建(导入收尾调一次最省心)。 */
export function rebuildFts(d: Database.Database): number {
  ensureFts(d);
  d.exec(`DELETE FROM ${FTS_TABLE};`);
  const rows = d
    .prepare(`SELECT id, stem FROM question`)
    .all() as { id: number; stem: string }[];
  const ins = d.prepare(
    `INSERT INTO ${FTS_TABLE}(rowid, stem) VALUES (?, ?)`,
  );
  const tx = d.transaction((list: { id: number; stem: string }[]) => {
    for (const r of list) ins.run(r.id, toFtsText(r.stem || ""));
  });
  tx(rows);
  return rows.length;
}
