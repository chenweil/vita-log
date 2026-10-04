# 01: 独立静态应用与本地快照存储

**What to build:** 让轻盈计划成为不依赖 Workbuddy 的静态单页应用，使用版本化的浏览器本地健康数据快照加载现有仪表盘、设置展示、图表和日历，并在刷新后保留数据。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 页面不需要 `window.__SMART_PAGE__`、Workbuddy 注入脚本或 Workbuddy 数据库 ID 即可打开和运行。
- [x] 前端、领域模型、存储契约和导入校验使用 TypeScript，并通过 Node.js 工具链完成构建和验证。
- [x] 生产输出为静态资源；第一版不运行 Node.js 后端服务。
- [x] 页面通过统一的健康数据仓库读取和提交版本化快照，而不是由 UI 直接读写浏览器存储。
- [x] 快照包含 schema version、设置、体重、围度、步数、打卡和饮食记录集合。
- [x] 页面刷新后能够恢复已保存的数据和派生展示。
- [x] 存储损坏、不可用或写入失败时不会被当成空数据，界面会显示可操作的错误状态。
- [x] 桌面和移动浏览器均能打开本地读模式的核心页面。

## Comments

### 2026-10-05 — Closed after implementation verification

实现提交：`7102389 feat: build independent local snapshot app`。

**自动化覆盖（`npm test`，9 个测试文件 / 37 项测试全通过）**

- 快照形状与 schema version —— `tests/domain.test.ts`：「creates the versioned snapshot shape used by the local repository」
- 统一仓库契约、刷新后恢复数据 —— `tests/storage.test.ts`：「exposes the application-level health data repository contract」「commits a snapshot and loads the same data after a new repository is created」
- 损坏与写入失败不被当成空数据 —— `tests/storage.test.ts`：「rejects malformed persisted data instead of treating it as empty」「keeps the accepted snapshot when a later commit cannot be written」；`tests/domain.test.ts`：「rejects corrupted persisted fields instead of coercing them into valid data」
- 界面显示存储错误而非空仪表盘 —— `tests/app.test.ts`：「shows a storage error instead of rendering an empty dashboard」

**代码证据**

- 不依赖 Workbuddy：`src/` 内无 `window.__SMART_PAGE__`，唯一的 "Workbuddy" 出现在 `src/app.ts` 的说明文案（声明不向其发起请求）。
- UI 不直接读写浏览器存储：`localStorage` 在 `src/` 中仅出现于 `src/main.ts`，作为 `StorageLike` 注入 `LocalStorageHealthRepository`。
- 生产输出为静态资源：`npm run build` 产出 `dist/index.html` + `dist/assets/*`，`package.json` 无后端依赖。

**未覆盖（勾选依据为代码阅读，非自动化或手工验证）**

- 「桌面和移动浏览器均能打开本地读模式的核心页面」：`tests/index-entry.test.ts` 仅覆盖 `file://` 打开时的启动提示，未做真实浏览器、桌面与移动视口的验证。此项需人工验证后才算完整。

**范围说明**：#06 只读发布、#07 真实部署与历史数据验收不属于本次关闭范围。
