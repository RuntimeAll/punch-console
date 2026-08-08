/**
 * 建库:跑 drizzle 迁移(8 张表)+ 建 FTS5 虚表。幂等,重跑安全。
 *   pnpm db:migrate
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { db, rawDb } from "../src/db/client";
import { ensureFts } from "../src/db/fts";
import { DB_PATH } from "../src/db/paths";

function main() {
  console.log(`[migrate] 库 = ${DB_PATH}`);
  migrate(db, { migrationsFolder: "./drizzle" });
  ensureFts(rawDb());
  const tables = rawDb()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
    )
    .all() as { name: string }[];
  console.log(`[migrate] 完成,表 ${tables.length} 张:`);
  for (const t of tables) console.log(`  - ${t.name}`);
}

main();
