import { defineConfig } from "drizzle-kit";

const DB_PATH =
  process.env.PUNCH_DB || String.raw`D:\workplace\ai-bkb\举一反三产物\资料库.db`;

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: DB_PATH },
  verbose: true,
  strict: true,
});
