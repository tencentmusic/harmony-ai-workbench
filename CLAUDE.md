改代码、部署、SSH、合分支前必须先读[开发规范的 Git 协作与部署章节](docs/engineering/development.md#git-协作与部署)并遵守。项目规则与说明见 [`AGENTS.md`](AGENTS.md)。

用户能感知的能力/修复，收工时必须更新 [`config/changelog.json`](config/changelog.json) 与 `package.json` 的 `version`（见 `.cursor/rules/changelog.mdc`），并跑 `npm run check:changelog`。
