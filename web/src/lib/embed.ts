/**
 * 语意轴(RAG 题面轴)。
 *
 * Node 侧只干两件事:①把查询词交给 python sidecar 换成向量;②对库里几千条向量暴力算余弦。
 * 向量在 python 侧已 L2 归一化,所以余弦 = 点积,一次遍历几毫秒,不需要向量索引。
 *
 * sidecar 用「常驻子进程」而不是每次 spawn:torch + 模型冷加载十几秒,
 * 每查一次开一个新进程页面就没法用了。常驻着只付一次加载钱。
 *
 * 🔴 模型没下好 / venv 没建 / 子进程起不来 => 判定「语意轴未就绪」,
 *    检索自动降级为 FTS+过滤,页面把这事写在脸上,绝不阻塞交付。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

import { DB_PATH, EMBED_PY, EMBED_SCRIPT } from "@/db/paths";

/** 起子进程 + 首次载模型的宽限 */
const BOOT_TIMEOUT_MS = 180_000;
/** 单次查询的宽限 */
const QUERY_TIMEOUT_MS = 60_000;
/** 查询词 -> 向量 的进程内缓存条数 */
const CACHE_MAX = 500;

type Pending = {
  resolve: (v: Float32Array | null) => void;
  timer: NodeJS.Timeout;
};

type Sidecar = {
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
  pending: Map<number, Pending>;
  seq: number;
};

// dev 下 Next 会热重载模块,子进程与缓存挂 globalThis 防止越堆越多
const g = globalThis as unknown as {
  __punchEmbed?: Sidecar | null;
  __punchEmbedCache?: Map<string, Float32Array>;
};

function cache(): Map<string, Float32Array> {
  if (!g.__punchEmbedCache) g.__punchEmbedCache = new Map();
  return g.__punchEmbedCache;
}

export type Probe = { ok: boolean; reason?: string };

/** 只探文件在不在,不启动进程。 */
export function probeSidecar(): Probe {
  if (!fs.existsSync(EMBED_PY)) return { ok: false, reason: "embed/.venv 未建" };
  if (!fs.existsSync(EMBED_SCRIPT)) return { ok: false, reason: "embed/embed.py 缺失" };
  return { ok: true };
}

function startSidecar(): Sidecar | null {
  if (!probeSidecar().ok) return null;
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(EMBED_PY, [EMBED_SCRIPT, "--serve"], {
      env: { ...process.env, PUNCH_DB: DB_PATH, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }

  const pending = new Map<number, Pending>();
  const sc: Sidecar = { proc, pending, seq: 0, ready: Promise.resolve(false) };

  sc.ready = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), BOOT_TIMEOUT_MS);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let obj: { ok?: boolean; ready?: boolean; id?: number; vec?: number[] };
      try {
        obj = JSON.parse(line);
      } catch {
        return; // 非 JSON 噪声,忽略
      }
      if (obj.ready) {
        clearTimeout(t);
        resolve(Boolean(obj.ok));
        return;
      }
      if (typeof obj.id === "number") {
        const p = pending.get(obj.id);
        if (!p) return;
        pending.delete(obj.id);
        clearTimeout(p.timer);
        p.resolve(obj.ok && Array.isArray(obj.vec) ? Float32Array.from(obj.vec) : null);
      }
    });
    const die = () => {
      clearTimeout(t);
      resolve(false);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      pending.clear();
      if (g.__punchEmbed === sc) g.__punchEmbed = null; // 下次调用重开
    };
    proc.on("exit", die);
    proc.on("error", die);
  });

  proc.stderr.resume(); // tqdm 之类噪声,丢掉别撑爆缓冲
  proc.unref?.();
  return sc;
}

function sidecar(): Sidecar | null {
  if (g.__punchEmbed === undefined || g.__punchEmbed === null) {
    g.__punchEmbed = startSidecar();
  }
  return g.__punchEmbed;
}

/** 把一句话变成归一化向量;任何失败都返回 null(调用方降级)。 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const key = text.trim();
  if (!key) return null;
  const c = cache();
  const hit = c.get(key);
  if (hit) return hit;

  const sc = sidecar();
  if (!sc) return null;
  if (!(await sc.ready)) return null;

  const id = ++sc.seq;
  const vec = await new Promise<Float32Array | null>((resolve) => {
    const timer = setTimeout(() => {
      sc.pending.delete(id);
      resolve(null);
    }, QUERY_TIMEOUT_MS);
    sc.pending.set(id, { resolve, timer });
    try {
      sc.proc.stdin.write(`${JSON.stringify({ id, text: key })}\n`);
    } catch {
      clearTimeout(timer);
      sc.pending.delete(id);
      resolve(null);
    }
  });

  if (vec) {
    if (c.size >= CACHE_MAX) c.delete(c.keys().next().value as string);
    c.set(key, vec);
  }
  return vec;
}

/** BLOB(float32 小端)-> Float32Array。 */
export function bufToVec(buf: Buffer): Float32Array {
  // Buffer 可能没有 4 字节对齐,不对齐时只能拷一份
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** 两个已归一化向量的余弦 = 点积。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
