/** 库与外部资料根的路径口径(唯一出处,别处不许再硬编码)。 */

/** SQLite 唯一参照物。可用环境变量 PUNCH_DB 覆盖。 */
export const DB_PATH =
  process.env.PUNCH_DB || String.raw`D:\workplace\ai-bkb\举一反三产物\资料库.db`;

/** 打卡产物根(产线卡/物料/图/PDF 都在这下面)。 */
export const PUNCH_ROOT =
  process.env.PUNCH_ROOT || String.raw`D:\workplace\ai-bkb\举一反三产物\打卡`;

/** 语意轴 sidecar(python venv + embed.py)。 */
export const EMBED_PY =
  process.env.PUNCH_EMBED_PY ||
  String.raw`D:\workplace\ai-bkb\codeplace-O\punch-console\embed\.venv\Scripts\python.exe`;

export const EMBED_SCRIPT =
  process.env.PUNCH_EMBED_SCRIPT ||
  String.raw`D:\workplace\ai-bkb\codeplace-O\punch-console\embed\embed.py`;
