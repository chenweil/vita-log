# 08: SQLite 自托管持久化层

**What to build:** 在当前基于 `localStorage` 的页面需求稳定后，增加 SQLite 自托管持久化层和 Node.js 后端 API，让健康快照可以跨浏览器、跨设备保存，并保留 JSON/CSV 备份与本地恢复能力。

**Blocked by:** 01–05：独立静态页面、本人编辑、活动记录、饮食记录、备份与导入能力

**Status:** needs-triage

- [ ] 明确 SQLite 文件、备份文件和服务器持久化数据卷的位置。
- [ ] 定义 Node.js API 的读取、写入、备份和恢复契约。
- [ ] 让现有 TypeScript 前端通过同一健康数据仓库契约选择 SQLite 适配器。
- [ ] 支持将当前 `localStorage` 快照一次性迁移到 SQLite。
- [ ] 保留 JSON/CSV 导出作为人工备份和恢复路径。
- [ ] 明确本人编辑认证、只读访问和后端授权规则。
- [ ] 定义 SQLite 文件备份、恢复和写入失败时的恢复证据。
- [ ] 不在本票据中实现 Supabase；SQLite 适配器稳定后再单独设计 Supabase 适配器。

## Notes

当前阶段继续完善静态页面和本地数据交互。SQLite 不是本阶段的实现内容，而是下一阶段的持久化边界决策。
