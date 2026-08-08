/**
 * 全量算向量:转调 python sidecar(embed/.venv + embed.py --all)。
 *   pnpm embed:all          只补没算过的
 *   pnpm embed:all -- --force  全部重算
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { DB_PATH, EMBED_PY, EMBED_SCRIPT } from "../src/db/paths";

function main() {
  if (!fs.existsSync(EMBED_PY)) {
    console.error(`[embed] 没有 venv: ${EMBED_PY}`);
    console.error(`[embed] 先建:cd embed && uv venv .venv && uv pip install -i https://pypi.tuna.tsinghua.edu.cn/simple sentence-transformers modelscope`);
    process.exit(1);
  }
  const extra = process.argv.slice(2);
  const r = spawnSync(EMBED_PY, [EMBED_SCRIPT, "--all", ...extra], {
    stdio: "inherit",
    env: { ...process.env, PUNCH_DB: DB_PATH },
  });
  process.exit(r.status ?? 1);
}

main();
