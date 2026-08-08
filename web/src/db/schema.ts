/**
 * 资料产线控制台 · SQLite schema(PRD-023 v2-M1)
 *
 * 9 张表 + 1 张 FTS5 虚表,0 触发器。
 * 列名用中文(与设计稿附二一致),TS 侧用 ASCII 键方便写代码。
 * 状态字段只存 3 个:task.状态 / doc.人工态 / question.实算——其余一律现算。
 */
import { sql } from "drizzle-orm";
import {
  blob,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 六类资料 */
export const DOC_TYPES = [
  "打卡",
  "专项",
  "试卷",
  "讲义",
  "练习册",
  "课本",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** 人工态(现算态之外唯一的人工开关) */
export const DOC_MANUAL_STATES = ["在售", "停售"] as const;

/** 实算三态 + 弃用 */
export const CALC_STATES = ["待算", "绿", "红", "弃用"] as const;

/** 题目所在小节 */
export const SECTIONS = ["oral", "vert", "step", "app"] as const;

/** 任务状态 */
export const TASK_STATES = ["排队", "进行中", "完成", "作废"] as const;

// ------------------------------------------------------------------ doc

/** 一份资料(打卡的一个版本 = 一行) */
export const doc = sqliteTable(
  "doc",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("名称").notNull(),
    type: text("类型").notNull(),
    group: text("组名"),
    version: text("版本名"),
    subject: text("科目"),
    grade: text("年级"),
    /** JSON string[] */
    kps: text("考点"),
    /** 单册 | 合刊 */
    form: text("册型").default("单册"),
    /** 在售 | 停售 | NULL(=在产,现算) */
    manualState: text("人工态"),
    layoutKey: text("layout_key"),
    /** JSON,天数与每天题量规格 */
    daySpec: text("day_spec"),
    srcPath: text("源文件路径"),
    panUrl: text("网盘链接"),
    panPwd: text("提取码"),
    onlineBookId: text("线上book_id"),
    note: text("备注"),
  },
  (t) => [
    // 幂等导入靠它:名称 + 版本名 唯一
    uniqueIndex("doc_name_version_uq").on(t.name, t.version),
    index("doc_type_idx").on(t.type),
  ],
);

// ------------------------------------------------------------------ question

/** 一道题(题目身份 = 库 id,文件只是投影) */
export const question = sqliteTable(
  "question",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    docId: integer("doc_id").references(() => doc.id),
    /** 位置三元组 */
    day: integer("day"),
    section: text("section"),
    seq: integer("seq"),
    stem: text("stem").notNull(),
    answer: text("answer"),
    /** JSON string[] */
    steps: text("steps"),
    /** JSON string[] */
    kps: text("考点"),
    qtype: text("题型"),
    difficulty: text("难度"),
    source: text("来源"),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
    /** 归一化题面 sha1,查重用 */
    hashL1: text("hash_L1"),
    /** 待算 | 绿 | 红 | 弃用 */
    calc: text("实算").default("待算"),
    /** float32 小端、已 L2 归一化 */
    vector: blob("向量"),
    motherId: integer("mother_id"),
    varLevel: text("var_level"),
    generatorId: integer("generator_id"),
    /** 出题随机种子 —— 同 seed 重跑必须逐字一致,可复现的命根子 */
    seed: integer("seed"),
    /** 出题入参 JSON(数域/题型开关等),配合 seed 才能真复现 */
    params: text("params"),
  },
  (t) => [
    // 幂等导入靠它。非打卡题位置三元组全 NULL,SQLite 视 NULL 互不相等,不会误撞。
    uniqueIndex("question_pos_uq").on(t.docId, t.day, t.section, t.seq),
    index("question_doc_idx").on(t.docId),
    index("question_hash_idx").on(t.hashL1),
    index("question_type_idx").on(t.qtype),
  ],
);

// ------------------------------------------------------------------ collection_item

/** 合刊选题:合刊 doc 引用别册的题,不复制题 */
export const collectionItem = sqliteTable(
  "collection_item",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    docId: integer("合刊doc_id")
      .notNull()
      .references(() => doc.id),
    questionId: integer("question_id")
      .notNull()
      .references(() => question.id),
    day: integer("day"),
    section: text("section"),
    seq: integer("seq"),
  },
  (t) => [
    uniqueIndex("collection_item_uq").on(t.docId, t.questionId),
    index("collection_item_doc_idx").on(t.docId),
  ],
);

// ------------------------------------------------------------------ doc_member

/**
 * 册级归属:一本合刊由哪几册组成。
 *
 * 🔴 口径(2026-08-08 定,别再混):
 *   - `doc_member`  = **册级**归属,给人读、给导航用。合刊 ←→ 成员册的名分关系,
 *     成员册的题一道没入库也能登记(科学测量合刊就是这种:五天的题还没拆到题级)。
 *   - `collection_item` = **题级**引用,给渲染用。合刊真要排版出卷时,以它为准逐题取。
 *   两者互补不冲突:册级说"这本由哪几册合成",题级说"这一页印哪几道题";
 *   有题级数据时渲染以 collection_item 为准,没有也不影响册级导航成立。
 */
export const docMember = sqliteTable(
  "doc_member",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    collectionId: integer("合刊doc_id")
      .notNull()
      .references(() => doc.id),
    memberId: integer("成员doc_id")
      .notNull()
      .references(() => doc.id),
    order: integer("排序").default(0),
  },
  (t) => [
    uniqueIndex("doc_member_uq").on(t.collectionId, t.memberId),
    index("doc_member_collection_idx").on(t.collectionId),
    index("doc_member_member_idx").on(t.memberId),
  ],
);

// ------------------------------------------------------------------ material

/** 发帖物料:一册 × 一个账号 × 一版文案 */
export const material = sqliteTable(
  "material",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    docId: integer("doc_id")
      .notNull()
      .references(() => doc.id),
    /** A | B */
    account: text("账号").notNull(),
    isActive: integer("is_active").default(1),
    title: text("标题"),
    body: text("正文"),
    /** JSON string[] */
    topics: text("话题词"),
    styleSeed: text("风格种子"),
    /** 发过即烧,防同质化复用 */
    burned: integer("burned").default(0),
    goodsDesc: text("商品描述"),
    panShare: text("网盘分享语"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("material_doc_idx").on(t.docId)],
);

// ------------------------------------------------------------------ asset

/** 产物文件:图 / PDF / 封面 */
export const asset = sqliteTable(
  "asset",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    docId: integer("doc_id")
      .notNull()
      .references(() => doc.id),
    /**
     * 图A | 图B | 页图 | 题目卷 | 答案卷 | 合订卷 | 封面
     * 合订卷 = 题目与解析装订在同一个 PDF 里(专项老件常见),它一份顶两份;
     * 页图   = 成品逐页图(_交付/xx-图片/),不分 A/B 号水印。
     */
    type: text("类型").notNull(),
    path: text("路径").notNull(),
    order: integer("配图顺序"),
    renderedAt: text("rendered_at"),
  },
  (t) => [
    uniqueIndex("asset_uq").on(t.docId, t.type, t.path),
    index("asset_doc_idx").on(t.docId),
  ],
);

// ------------------------------------------------------------------ task

/** 收件台任务(脏活交 agent) */
export const task = sqliteTable(
  "task",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("标题").notNull(),
    detail: text("详情"),
    /** JSON string[] */
    srcPaths: text("素材路径"),
    /** agent | 直出 | 回收 */
    type: text("类型").default("agent"),
    /** 排队 | 进行中 | 完成 | 作废 */
    state: text("状态").default("排队"),
    order: integer("排序").default(0),
    docId: integer("关联doc_id").references(() => doc.id),
    /** 铁律:派 agent 一律 opus,绝不 fable */
    model: text("model").default("opus"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("task_state_idx").on(t.state)],
);

// ------------------------------------------------------------------ generator

/** 出题通式:打卡题可批量复现的根据 */
export const generator = sqliteTable(
  "generator",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 出题函数名。没它登记完定位不到具体函数,通式就是一句空话 */
    genKey: text("gen_key").notNull(),
    name: text("名称").notNull(),
    coverKps: text("覆盖考点"),
    scriptPath: text("脚本路径"),
    /** 支持的变式档位,如 "1-3" */
    lvSupport: text("lv_支持"),
    /** 样例题面,登记时一眼认出这通式出什么 */
    sampleStem: text("样例题面"),
    note: text("备注"),
  },
  (t) => [uniqueIndex("generator_key_uq").on(t.genKey)],
);

// ------------------------------------------------------------------ publish_log

/** 发布流水:限流/删帖回溯用 */
export const publishLog = sqliteTable(
  "publish_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    materialId: integer("material_id")
      .notNull()
      .references(() => material.id),
    date: text("日期"),
    /** 正常 | 限流 | 删帖 */
    result: text("结果"),
    note: text("备注"),
  },
  (t) => [index("publish_log_material_idx").on(t.materialId)],
);

/**
 * FTS5 虚表(drizzle 表达不了,由 scripts/migrate.ts 建):
 *   CREATE VIRTUAL TABLE question_fts USING fts5(stem, tokenize='unicode61');
 * rowid = question.id;列内容 = 应用层分好词的题面(见 src/db/fts.ts)。
 * 0 触发器 —— 写入方负责同步。
 */
export const FTS_TABLE = "question_fts";
export const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(stem, tokenize='unicode61');`;
