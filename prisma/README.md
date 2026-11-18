# Prisma / SQLite

表结构**只在此目录的 `schema.prisma` 维护**。

- 开发库：`DATABASE_URL=file:./data.db` → **`prisma/data.db`**
- 生产库：`DATABASE_URL=file:./data.prod.db` → **`prisma/data.prod.db`**

（Prisma 将 `file:` 相对路径相对本目录解析。）

变更后执行 `npm run db:push`。出现 drop 或 data loss 提示时取消，先把缺的表补进 `schema.prisma`。
