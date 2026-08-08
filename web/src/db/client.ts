import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { DB_PATH } from "./paths";
import * as schema from "./schema";

/**
 * 单例连接。dev 下 Next 会热重载模块,挂在 globalThis 上防止句柄泄漏。
 * (不加 server-only:导入脚本 tsx 也复用这一层。)
 */
const g = globalThis as unknown as {
  __punchSqlite?: Database.Database;
};

export function rawDb(): Database.Database {
  if (!g.__punchSqlite) {
    const d = new Database(DB_PATH);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    g.__punchSqlite = d;
  }
  return g.__punchSqlite;
}

export const db = drizzle(rawDb(), { schema });
export { schema };
