# D1 完整备份、恢复与最小审计

本流程用于 #06.1-05。D1 是唯一在线事实来源，JSON 和 SQLite 是本人持有的离线恢复材料，不双写、不在线镜像。`loadRecovery()` 的单步回退仍不可用，`keepsRecoveryPoint` 保持 false。

## 部署顺序

1. 沿用现有 `functions/schema.sql` 创建基础表。已存在的数据库不删除、不重建。
2. 在真实 Wrangler 配置的 D1 绑定中设置 `migrations_dir = "functions/migrations"`，使用 `wrangler d1 migrations apply <数据库名> --remote` 应用全部增量迁移：`0001_backup_audit.sql` 创建审计表，`0002_audit_results.sql` 保留旧记录和 ID 并扩展审计结果约束。迁移和新代码必须一起准备，先在预览环境核验。
3. 使用 `npm run build:cloudflare` 构建并部署。先应用迁移再发布代码；缺少审计表时备份与写入返回不可用，不跳过审计。
4. 完成离线备份和恢复演练后，才按 #06.1-06 放开公网。

上述 Cloudflare 配置、迁移执行、生产备份及切换均属于本人执行的部署步骤，本轮没有执行。配置值必须来自目标环境，不能用示例数据库名或 ID 冒充。

## 接口和授权

- `GET /api/backup`：本人会话下的完整健康快照、在线版本和导出时间。没有密码、会话表或审计内容。响应 `no-store`；无会话返回 401，存储/审计失败返回 503。备份与 CSV/JSON 导出共用独立预算：每个会话、每个 IP 每分钟最多 30 次，超过时返回 429 和 `Retry-After`，不占用保存预算；跨 isolate 的限流仍由 #06.1-06 配置平台规则。
- `POST /api/restore`：本人会话、同源校验、写入限流及 `expectedVersion` 守卫。复用版本化保存，只更新既存在线行，不承担空库首次迁移。恢复成功使版本加一，不能用文件中的旧版本重置在线版本。
- `GET /api/audit`：本人会话下的审计分页，默认只读写入审计。`kind=backup` 查看导出，`kind=all` 合并查看；每页最多 100 条，非空 `nextCursor` 用作下一页的 `before`，直到返回 null。事件仍只返回时间、操作类型、结果和版本，不暴露事件 ID。
- 在线完整 JSON/CSV 导出重新通过备份接口授权，不使用锁定前留在页面里的 owner 快照。纯静态查看与导出能力保持原样。

保存、恢复和迁移的审计在健康变更之后、同一个 D1 `batch()` 事务内执行。[SQLite 的 `changes()`](https://www.sqlite.org/lang_corefunc.html#changes)给出最近一次写语句的实际变更数，审计还核对行版本、载荷和时间，只把已证明的写入记为 `success`，不把写前的准入条件当结果。无法确认的保存记 `unknown` 和被请求的预期版本；空库记 `not-initialized`，不冒充数据库故障。HTTP 返回元数据缺失时 API 仍返回 503，但若事务已证明数据落库，成功审计可以成立：客户端未确认不等于数据库没有提交。新增结果仅用于审计，不扩展公共 API 错误码。

审计写入失败会回滚健康变更，版本冲突记录的是被拒绝的预期版本。审计表不存健康内容、账号、IP、密码或令牌。数据库失败时事务回滚，不能在同一个不可用数据库里保证保存失败审计；生产请求失败证据由 #06.1-06 的平台运行日志取证，不能声称每个故障都有持久审计行。`0002` 保留既有记录原样，不根据无法重建的过去状态改写历史结果。

保留规则：写入类（save/migrate/restore）保留最近 **10,000** 条，导出类（backup，包括 CSV/JSON）保留最近 **1,000** 条。每次审计追加在同一事务内按 ID 清理超额的旧元数据；导出不能挤占写入保留量。这是数量上限，不是保留天数；需要长期留存时，本人应在清理前通过分页读取归档。`LIMIT 100` 仅是分页大小，不再隐藏所有更早的保留记录。清理不触及健康快照、离线文件、凭据或会话。

审计中的 `backup/success` 表示服务端已准备完整导出，不表示客户端已落盘。离线文件是否落盘成功，以运维命令的结果为准。

## 本机受限备份

在仓库之外准备权限 0700 的真实目录；凭据 JSON 是权限 0600 的真实文件，只包含 `username` 和 `password`。不要提交凭据、健康数据或备份。密码不出现在命令参数和日志里，Cookie 只留在进程内存中，命令结束会向服务端注销。

部署隔离阶段的 Cloudflare Access 服务身份可在同一受限文件追加成对的 `accessClientId`、`accessClientSecret`；本机会话客户端仅向相同 HTTPS origin 发送这些请求头，拒绝跨域和重定向。Access 身份不能替代应用本人会话。配置流程见 [Cloudflare 切换指南](cloudflare-cutover.md)。

```sh
npm run d1:backup -- backup \
  --origin https://vita.example \
  --credentials /private-backups/credentials.json \
  --directory /private-backups/health
```

每次生成不同文件名的完整 `.backup.json` 与 `.sqlite` 副本，权限均为 0600；两个文件及目录写入完成并同步后才报告成功。JSON 包含 SHA-256 校验值，SQLite 与现有 `SqliteStore` 兼容，但 auth 表为空：它是离线恢复副本，不是已配置管理员的自建服务运行库。不会自动删除旧备份。

将这一条 **backup** 命令交给本人电脑的定时任务，例如每日一次。macOS 模板为 `ops/d1-backup.launchd.plist.example`，默认每日 03:00；本人需替换全部占位路径和 origin，在受限目录预建权限 0600 的日志文件，验证命令成功后再安装模板。定时任务使用实际 Node 路径、仓库绝对路径，并将结果日志放在受限目录。电脑休眠、断网、凭据轮换或会话服务失败时可能漏跑，应检查最近文件的导出时间并补跑。定时任务、实际目录、备份保留策略以及一次真实恢复演练的证据由 #06.1-06 配置和验收，本轮没有安装定时任务。

## JSON 恢复流程

先用本工具生成的 JSON 预览。没有 `--confirm` 不写在线健康数据，只读取当前版本、校验目标文件并显示目标记录数；本人还需核对文件来源与内容。

```sh
npm run d1:backup -- restore \
  --origin https://vita.example \
  --credentials /private-backups/credentials.json \
  --directory /private-backups/health \
  --file /private-backups/health/<文件名>.backup.json
```

确认后，在同一命令追加 `--expected-version <预览版本> --confirm`。工具依次校验目标 JSON 的格式和校验值，读取当前在线快照并检查预览版本，**将当前在线数据写为新的 JSON/SQLite 安全副本**，最后调用恢复接口。任何落盘失败都会阻止恢复请求；其间其他客户端保存导致版本改变时，服务端返回 409，安全副本保留，需重新预览。成功后恢复对象来自目标文件，在线版本依然递增。

受限目录在本人电脑上，服务端无法确认本机文件系统已经同步。因此“恢复前落盘”的保证由上述运维流程提供；直接调用恢复 API 的已授权本人必须自行先保存安全副本。API 仍逐请求校验会话、同源与版本，不把客户端关于安全副本的声明当授权依据。

请求中断、返回无法识别或命令报错时，可能存在“已写入但客户端尚未确认”的状态。先重新读取在线版本和数据，再决定是否重试，不能盲目重放旧版本。注销失败也会令命令退出失败；先确认操作结果，再锁定会话。

## 平台恢复（Time Travel）

Time Travel 是整库的时间点恢复，通过 Cloudflare 管理权限执行，不能把 Cloudflare 管理 Token 交给 Pages Function 或浏览器。平台恢复可能同时回退版本、审计和会话表，因此不是应用的“恢复上一次快照”。[Cloudflare 官方说明](https://developers.cloudflare.com/d1/reference/time-travel/)说明其恢复会原地覆盖数据库并中断在途查询，当前保留窗口取决于套餐（Free 7 天，Paid 30 天）。

本人在 #06.1-06 的运维演练中执行：

1. 停止公网和编辑流量，确认目标数据库、时间点与套餐保留窗口。
2. 在线服务可读时先生成完整 JSON/SQLite 副本；服务不可读时确认已存在的离线副本，记录当前 Time Travel bookmark，保留平台回退路径。
3. 执行 `wrangler d1 time-travel info <数据库名>` 记录恢复前 bookmark，再用 `wrangler d1 time-travel restore <数据库名> --bookmark=<目标bookmark>` 恢复；由本人确认覆盖。
4. 恢复后清除 `owner_session`，避免历史会话被重新激活；检查审计迁移是否仍存在，必要时重新应用迁移。
5. 对账完整快照、类型数量、日期范围和关键设置，重新登录、验证匿名读取与写入版本冲突后再开放公网。旧编辑器必须重新登录并加载快照。
6. 对账不通过时继续维护状态，由本人使用恢复前 bookmark 回退并重新核验，不能发布未核实数据。

不得把 D1 完全不可用时的一次本地测试称为平台恢复成功。数据库迁移、Time Travel、定时任务及公网安全检查仍需目标环境证据。
