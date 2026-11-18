import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./load-env-file.mjs";
import { resolvePrismaSqlitePath } from "./resolve-prisma-sqlite-path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fileEnv = loadEnvFile(path.join(root, ".env.production"));
const runtimeEnv = { ...fileEnv, ...process.env };
const databaseUrl = runtimeEnv.DEPLOY_DATABASE_URL ?? runtimeEnv.DATABASE_URL ?? "file:./data.prod.db";
const resolvedSqlitePath = resolvePrismaSqlitePath(databaseUrl, root);

const dbPush = spawnSync("npx", ["prisma", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
  input: "n\n",
  encoding: "utf8",
  cwd: root,
  shell: process.platform === "win32",
  env: {
    ...runtimeEnv,
    DATABASE_URL: databaseUrl,
  },
});
if (dbPush.error) {
  console.error(dbPush.error);
  process.exit(1);
}
if (dbPush.stdout) process.stdout.write(dbPush.stdout);
if (dbPush.stderr) process.stderr.write(dbPush.stderr);
const output = `${dbPush.stdout ?? ""}\n${dbPush.stderr ?? ""}`;
if (/There might be data loss|You are about to drop|Do you want to ignore the warning/i.test(output)) {
  if (resolvedSqlitePath && fs.existsSync(resolvedSqlitePath)) {
    const backupPath = `${resolvedSqlitePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(resolvedSqlitePath, backupPath);
    console.error(`[db:push:prod] 已拒绝 Prisma 数据丢失确认；生产库备份到 ${backupPath}`);
  } else {
    console.error("[db:push:prod] 已拒绝 Prisma 数据丢失确认。");
  }
  process.exit(1);
}
if (dbPush.status !== 0) process.exit(dbPush.status ?? 1);

const gen = spawnSync("npx", ["prisma", "generate", "--schema", "prisma/schema.prisma"], {
  cwd: root,
  shell: process.platform === "win32",
  env: runtimeEnv,
  stdio: "inherit",
});
if (gen.error) {
  console.error(gen.error);
  process.exit(1);
}
if (gen.status !== 0) process.exit(gen.status ?? 1);
