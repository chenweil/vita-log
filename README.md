# Vita Log · 个人健康记录

> 前身：轻盈计划 · 减脂健身追踪台

单用户、本地优先的个人健康记录 Web 应用：记录饮食、运动、体重、习惯，再加以分析和展示。

第一阶段目标：摆脱 Workbuddy 托管限制，做成可独立部署的静态单页应用，浏览器本地数据为事实来源，支持历史数据一次性导入与完整备份恢复。

## 功能

- 体重 / 体脂 / 腰围 / 臀围（自动算腰臀比）/ 步数录入
- 训练与习惯打卡
- 饮食记录：热量、蛋白质、脂肪、碳水、钠、备注
- 派生计算：BMI、BMR、TDEE、宏量营养目标
- 趋势图、日历、今日待办、最近记录
- 数据导入 / 导出 / 备份（JSON 完整备份 + CSV 分类交换）
- 离线可用，刷新不丢失
- 本人可编辑、分享出去他人只读

## 技术路线

前端 + 可替换存储适配器：

```text
页面 UI / 业务计算
        ↓
统一数据访问接口（健康数据仓库）
        ↓
本地存储适配器 / SQLite 自托管适配器 / 云端适配器（未来）
```

- 第一版：独立静态单页 + 浏览器本地存储 + CSV/JSON 导入导出
- 腾讯云文档只做一次性历史数据导入来源，不接 API、不做持续同步
- SQLite 自托管适配器已提供（本机 Node.js 服务 + 版本化快照仓库）
- 云端适配器方向已定为 Cloudflare Pages + Pages Functions + D1，不再提 Supabase；D1 为唯一在线事实来源，本机 SQLite 只做离线备份/恢复副本，不双写。详见 [ADR-0002](docs/adr/0002-cloudflare-realtime-public-access.md)

已入库的设计依据：

- [`docs/adr/0001-sqlite-local-persistence.md`](docs/adr/0001-sqlite-local-persistence.md)：SQLite 持久化层
- [`docs/adr/0002-cloudflare-realtime-public-access.md`](docs/adr/0002-cloudflare-realtime-public-access.md)：云端实时访问与写入授权
- [`.scratch/independent-web-v1/spec.md`](.scratch/independent-web-v1/spec.md) 及 `issues/`：第一阶段 spec 与票据

需求基线与第一版设计文稿（`轻盈计划独立部署_初期需求.md`、`轻盈计划独立部署_设计文稿.md`）只在本机保留，不随公开仓库发布。

## 仓库结构

```text
.
├── index.html                # 静态入口；双击打开只显示启动说明，不加载 TypeScript
├── src/                      # 前端：领域模型、UI、存储适配器（localStorage / SQLite）
├── server/                   # 自托管 Node.js SQLite 服务与 API
├── tests/                    # Vitest 单元与集成测试
├── scripts/                  # 发布校验（verify-release）与构建后处理
├── docs/                     # ADR、发布验收 runbook、SQLite 部署说明、Agent 约定
├── .scratch/                 # 本地 spec 与 issue 票据（路线图的事实来源）
├── .github/workflows/        # CI
└── package.json / tsconfig.json / vite.config.ts / vitest.config.ts
```

本机还保留以下参考与基线文件，但它们被 `.gitignore` 排除，不随公开仓库发布：

- `qingying_workspace.html`：旧 Workbuddy 版本（参考实现，不再作为生产入口）
- `轻盈计划减脂健身追踪台.html`：较新的本地化版本（行为与视觉参考）
- `轻盈计划独立部署_初期需求.md`、`轻盈计划独立部署_设计文稿.md`：需求基线与第一版设计

## 快速开始

独立版使用 TypeScript 和 Vite。浏览器不能通过 `file://` 直接执行 TypeScript 模块，请在项目目录启动本地服务：

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

构建结果位于 `dist/`，可部署到任意静态托管（Cloudflare Pages / Vercel / NAS / 个人服务器）。生产环境建议使用 HTTPS，以保证浏览器存储与离线能力正常。直接双击源目录的 `index.html` 会显示启动说明，不会尝试加载 TypeScript。

发布前检查：

```bash
npm run verify:release
```

该检查会验证生产入口、静态资源、临时静态服务器访问和废弃 Workbuddy 全局入口。真实托管、历史数据对账和旧页面下线按 [`docs/release-verification.md`](docs/release-verification.md) 的外部验收清单执行。

## 数据与迁移

- JSON：完整备份与恢复格式（含设置、全部记录、稳定 ID、时间戳、版本号）
- CSV：面向人工检查和腾讯云文档历史数据迁移的交换格式，每类数据独立固定列
- 导入流程：解析 → 校验 → 预览（接受/拒绝/冲突数）→ 本人确认后一次性提交；失败时原数据不变，破坏性操作前自动留恢复点

## 权限模型

只有两种能力，注意强度不同：

1. **本人模式**：本地数据可增删改查、导入导出。本地验证只是防误触的界面锁，不是服务端认证。
2. **只读发布模式**：本人主动生成只读快照对外分享，无任何写入入口。这是真正的"他人只读"边界。

切勿把静态页面里的密码框当作高强度安全认证。真要保护健康数据，未来需后端认证 + 服务端权限。

## 路线图

计划与票据在 `.scratch/independent-web-v1/`，架构决定在 `docs/adr/`。

### 第一阶段：独立静态版（功能已交付，待目标环境取证）

- [x] 需求基线 + 第一版设计
- [x] 独立静态单页（去 Workbuddy 依赖）+ 本地存储适配器与统一数据仓库接口
- [x] 本人编辑权限与体重围度追踪
- [x] 步数、训练习惯与行动日历
- [x] 饮食记录与营养目标
- [x] CSV/JSON 导入导出 + 恢复点 + 腾讯云文档历史数据一次性迁移
- [x] 只读发布快照分享
- [x] SQLite 自托管持久化层（本机 Node.js 服务 + 版本化快照仓库，见 [ADR-0001](docs/adr/0001-sqlite-local-persistence.md) 与 [`docs/sqlite-self-hosted.md`](docs/sqlite-self-hosted.md)）

真实历史数据已迁移并对账：体重 11 条、围度 3 条、饮食 116 条，三类文件零错误；迁移后生成的完整 JSON 备份已用 `importJsonPreview` 回读验证（`accepted=130`、零错误）。对账明细见 [票据 07](.scratch/independent-web-v1/issues/07-release-migration-verification.md)。

### 待完成

- [ ] **目标环境发布验收**（[票据 07](.scratch/independent-web-v1/issues/07-release-migration-verification.md)）：部署到真实静态托管、真实浏览器桌面与移动流程验证、旧 Workbuddy 页面确认下线。仓库内可复跑的发布门禁（`npm run verify:release`）已经就位，缺的是目标 URL 和真实浏览器证据——见 [`docs/release-verification.md`](docs/release-verification.md) 的外部验收清单。
- [ ] **Cloudflare 实时公开读取与服务端编辑授权**（[票据 06.1](.scratch/independent-web-v1/issues/06.1-realtime-public-read-server-auth.md)）：访客读取服务端最新数据，本人凭密码登录后才能编辑。方案已定，见 [ADR-0002](docs/adr/0002-cloudflare-realtime-public-access.md)——Cloudflare Pages + Pages Functions + D1，D1 为唯一在线事实来源，本机 SQLite 退为离线备份/恢复副本。票据 06 的静态只读快照继续保留，但只作为非实时分享。

## 隐私

健康数据敏感。本仓库只含产品代码与文档，不含真实个人健康数据。迁移验证请用脱敏样例，真实数据只存本地和个人备份，不进 git。
