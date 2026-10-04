# SQLite 自托管运行说明

SQLite 运行模式由本机 Node.js 服务提供，默认只绑定 `127.0.0.1:4318`。数据库位于 `data/vita-log.sqlite`，备份位于 `backups/`；两者已被 `.gitignore` 排除。服务只保存完整版本化 `HealthSnapshot` JSON，不建立第二套业务表模型。

启动：

```bash
npm run sqlite:server
```

服务启动前会构建静态资源。浏览器通过同一健康数据仓库契约访问 `GET /api/snapshot` 和带 `expectedVersion` 的 `PUT /api/snapshot`。服务不可用或版本冲突会显示错误，不回退写入 `localStorage`。页面在 SQLite 模式提供浏览器快照迁移、SQLite 手动备份、已有 JSON/CSV 导入导出和恢复入口。

首次打开 SQLite 模式时，点击“进入编辑”设置本人账号和至少 10 字符密码。服务只保存 `scrypt` 加盐摘要；会话通过 HttpOnly、SameSite cookie 保存，30 分钟到期，锁定立即撤销。读取允许本机访问，写入、迁移、备份和恢复需要编辑会话。

迁移会先读取浏览器本地快照并显示记录数量，确认后调用 `/api/migrate`。SQLite 已有数据时拒绝迁移，必须使用现有导入流程明确替换或合并。迁移完成后 SQLite 是日常事实来源，浏览器快照保留为迁移前副本，不双写、不删除。

每次写入前会保留当前恢复快照；每日第一次写入前自动备份，自动备份最多保留 30 份。服务端使用 SQLite `VACUUM INTO` 生成一致备份，写入失败会停止本次操作并返回稳定错误码。恢复先返回备份摘要，确认后再次备份当前数据再替换。

命令行备份/恢复：

```bash
npm run sqlite -- backup
npm run sqlite -- list
npm run sqlite -- restore <backup-file> --confirm
```

健康数据仍是敏感信息。首期不做应用层加密，依赖本机文件权限；建议使用磁盘加密并限制 `data/`、`backups/` 目录权限。
