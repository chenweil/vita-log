# Cloudflare 部署与切换验收（#06.1-06）

此文是执行流程，不是部署成功记录。目标环境结果记录在 [验收表](../.scratch/independent-web-v1/evidence/06.1-06-cloudflare.md)。`pending`、本地测试和本人向导确认都不能冒充远端验证。

## 本人执行入口

在仓库根目录运行：

```sh
bash .scratch/independent-web-v1/wizards/06.1-06-cloudflare.sh
```

向导共 11 阶段，启动时先确认顺序；每次远端操作前核对账号、环境、项目和 D1。向导展示远端命令，**由本人在另一个终端执行**，不自动创建云资源、变更 Secret、迁移、恢复、发布、安装定时任务或解除访问隔离。中途否认确认或出错即停止；重跑先核对实际状态，已迁入健康数据不能重放首次导入。

| 阶段 | 本人取得/执行 | 落点 |
| --- | --- | --- |
| 1 账号与工具 | Account ID、Workers 套餐的实际 CPU 额度；安装/选择 Wrangler 并核对登录账号 | 本地配置；套餐证据 |
| 2 Pages | 真实项目、生产分支、另一个预览分支；暂停抢先发布的自动生产部署 | 本地配置 |
| 3 两个 D1 | Preview / Production 各自名称和 ID，不能共用数据库 | 本地配置、D1 绑定 |
| 4 访问隔离 | 本人 Access 与运维 Service Auth；封闭全部入口 | Cloudflare；隔离验收 |
| 5 Secret | 各环境的本人用户名、受限凭据文件，生成不同盐的密码摘要 | 用户名进入本地配置；摘要仅在私有文件及 Cloudflare Secret |
| 6 schema | 基础 schema 和全部增量迁移 | 明确环境的远端 D1 |
| 7 预览 | Cloudflare 构建、预览发布、合成来源迁移；成功登录与平台 CPU | Preview D1；私有备份；脱敏指标 |
| 8 预览验收 | 平台限流、安全、审计、恢复及故障演练 | 验收表及私有证据 |
| 9 生产迁移 | 停止本机写入；隔离下发布、预览、确认迁移、回读和备份 | Production D1；离线 JSON/SQLite |
| 10 生产运维 | 恢复演练、撤销历史会话；每日任务安装并真实运行 | 本人机器与 D1；验收表 |
| 11 公网切换 | 全部前置通过后开放自定义域名，再验证真实桌面/移动流程 | 生产域名；生产验收 |

生成的 `local/cutover.env`、`local/wrangler.json` 位于 ignored 的 `.scratch/independent-web-v1/local/`，目录 0700、文件 0600。不读取该配置为 shell 程序；所有值经输入检查。已有不同配置不会自动覆盖。没有真实值时不生成假数据库配置。安装的 Wrangler 需支持 Pages 配置，参阅 [官方配置要求](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。

## 访问隔离、域名与平台限流

第一次健康数据迁入前，先保护生产根域名 `<project>.pages.dev`、所有 `<hash>.<project>.pages.dev`/分支别名、自定义域名和旧部署。逐个在未登录浏览器验证首页和 `/api/snapshot` 不返回健康数据；同一个项目的历史部署仍可能直接访问。预览只放合成数据，不绑定生产 D1。

Pages 的默认预览 Access 策略只覆盖预览，不覆盖根 `pages.dev` 和自定义域名。根域名按 [Pages Access 已知问题说明](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain) 配置；自定义域名也需单独策略。[预览说明](https://developers.cloudflare.com/pages/configuration/preview-deployments/)解释了旧 hash 地址与分支别名的区别。仅不改 DNS、只保护首页、`noindex` 或缓存规则都不构成隔离。

选择一个能够处理完整 API 请求的 HTTPS origin。运维 CLI 遇到 Access 登录页、重定向、HTML 或异常响应会停止，不自动绕开保护。为 CLI 创建 Service Token，并在相应 Access Application 配置 **Service Auth** 策略；在私有凭据 JSON 加入成对的 `accessClientId`、`accessClientSecret`。它们只通过同源请求头发送，不落 Cookie jar，不转发到其他域名；浏览器本人的 Access 身份与应用本人会话是两层授权。

在自定义域名所属 Cloudflare zone 配置平台规则，并取得规则命中证据：

| 路径/方法 | 平台目标 | 验证 |
| --- | --- | --- |
| `POST /api/login` | 按来源 IP 限制登录请求；应用内另按账号限制失败尝试 | 多连接/新会话不能绕过平台预算；记录规则 ID 和安全事件 |
| `PUT /api/snapshot`、`POST /api/migrate`、`POST /api/restore` | 写预算；不把备份流量混入 | 新应用会话仍受 IP 预算约束 |
| `GET /api/backup`（含前端 JSON/CSV 导出） | 独立导出预算 | 导出限流后合法保存仍可用；窗口结束恢复 |

应用内部预算见 `functions/_lib/rate-limit.ts`：10 次失败登录、120 次写入、30 次导出，每分钟。平台规则的实际阈值、计数窗口和动作取决于目标套餐，配置后写入验收记录；不得宣称仅单 isolate 内计数已完成跨 isolate 限流。参考 [创建 zone 限流规则](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)与[规则可用性](https://developers.cloudflare.com/waf/rate-limiting-rules/)。若套餐无法提供所需覆盖，停止切换，明确记录升级或替代方案决定。

Zone 的规则不意味着 `pages.dev` 也受相同规则保护。公开时只开放已受平台规则保护的自定义域名，预览、生产 `pages.dev` 与旧 hash 入口继续隔离，核验不能通过别名直接绕过规则。若平台规则用 challenge 或非 JSON 响应，客户端仍必须拒绝写入，且给出可理解的不可用/限流反馈；平台故障并不保证携带应用的 `database-unavailable` JSON。

## 构建、绑定与 Secret

Wrangler 配置中的绑定名必须为 `VITA_LOG_DB`。顶层配置使用预览 D1，`env.preview`、`env.production` 显式绑定各自 D1 和用户名；所有远端 D1 命令显式带 `--env`、`--config`、`--remote`。配置只含用户名、Account ID、数据库名/ID 等部署元数据，不包含密码摘要和令牌。`pages_build_output_dir`、`migrations_dir` 使用仓库绝对路径；仓库移动后需重建并核对配置。

本人分别在 Pages 的 Preview / Production 环境设置：

- `VITA_LOG_OWNER_USERNAME`：与对应凭据 JSON 的 username 完全一致。
- `VITA_LOG_OWNER_CREDENTIAL`：Secret 类型，内容是本机生成的 `pbkdf2-sha256$…` 串。向导从受限文件读密码，通过既有实现生成摘要，保存在仓库之外的 0600 文件，供本人复制到控制台；不输出摘要。

已有配置必须先保留和逐项对照，Wrangler 文件发布后成为这些配置项的事实来源，不能混用两个不同的绑定。修改 Secret/绑定后重新部署。已有会话不会仅因换密码自动失效，轮换时由本人清空正确环境的 `owner_session`。

首次 schema 创建使用 `functions/schema.sql`，已有数据库不重建；随后执行 `functions/migrations/` 的全部迁移。先在预览验证 `0002` 保留旧审计行和 ID，再应用生产。下列命令的配置路径来自向导，执行前核对实际 ID：

```sh
wrangler d1 execute VITA_LOG_DB --config "$CF_CONFIG_PATH" --env preview --remote --file functions/schema.sql
wrangler d1 migrations apply VITA_LOG_DB --config "$CF_CONFIG_PATH" --env preview --remote
# 生产时明确改为 --env production，先核对配置的生产 ID。
npm run build:cloudflare
node scripts/verify-release.mjs
```

构建输出 `dist/index.html` 必须包含 `<meta name="vita-log-storage" content="d1">`。从仓库根目录使用 Wrangler 发布，才会一起编译 `functions/`；控制台拖拽 `dist/` 不能替代。普通 `npm run build` 和现有 GitHub Pages workflow 是静态模式，不能拿来发布此实时服务。[Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)说明了 Functions 的上传方式。

## 本机 SQLite 一次性迁移

Node >=22.5。准备仓库之外的 0700 目录，预览/生产各自的 0600 凭据 JSON：`username`、`password`，可选成对的 `accessClientId`、`accessClientSecret`。不要在聊天里提交这些文件。原 SQLite 保留，迁移不读取或复制其中的 auth 表，不双写。

预览演练的来源必须是合成数据。可在私有目录用现有 store 创建一份新库；以下路径由本人填写，不覆盖已有文件：

```sh
VITA_PREVIEW_SQLITE=/绝对/受限目录/preview-source.sqlite node --import tsx --input-type=module <<'JS'
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEmptySnapshot } from './src/domain.ts';
import { SqliteStore } from './server/store.ts';
const file = process.env.VITA_PREVIEW_SQLITE;
if (!file || existsSync(file)) throw new Error('指定一份尚不存在的合成来源库');
const snapshot = createEmptySnapshot();
snapshot.settings.name = 'Deployment smoke fixture';
const store = new SqliteStore({ database: file, backups: dirname(file) });
try { store.commit(snapshot, 0); } finally { store.close(); }
JS
```

生产确认前停止本机写入。先只预览（占位路径全部替换为真实值）：

```sh
npm run d1:cutover -- \
  --origin https://实际域名 \
  --credentials /受限目录/production-credentials.json \
  --sqlite /已有本机/vita-log.sqlite \
  --directory /受限目录/health
```

工具只读打开已存在的 SQLite；未知 schema、缺文件、尚无快照都会拒绝，不创建空来源。本人核对类型数量、日期范围、营养汇总和关键设置。预览包含健康摘要，**只供本人看，不复制进公开验收表或 CI 日志**。在线预览响应也必须与本机摘要一致。

确认后在同一条命令追加 `--confirm --source-sha256 <刚看到的摘要>`。工具会重新读取来源并比对摘要、确认 D1 为空、同步保存完整 JSON/SQLite 安全副本，才发 `POST /api/migrate`（`expectedVersion=0`）。落盘失败不发迁移；空库竞争仍由服务器 SQL 守卫处理。

成功导入后，工具通过本人备份接口再次读取完整在线快照，对账版本、服务端时间与全部业务内容，再同步保存在线 JSON/SQLite。只有返回 `reconciled: true` 且两个备份对均落盘才视为流程完整；在 `finally` 确认注销。服务器会赋予新的 `updatedAt`，其余规范化字段必须保持完全一致。

工具不自动解开公网隔离。导入可能已经提交，而后续回读、落盘、响应或注销失败；此时退出失败，**不意味着导入已回滚**。继续保持隔离，重新读取在线版本与完整数据、补备份并确认注销；不能清库重试或盲目重放。首次迁移不会覆盖非空 D1，后续恢复使用 [备份恢复指南](d1-backup-recovery.md)。

## 目标环境验收矩阵

按每一项记录环境、UTC 时间、部署 ID/commit、实际操作、预期、观察结果和脱敏证据位置。预览用合成库；生产破坏性演练需要维护窗口、当前副本和本人明确确认。

| 项 | 方法与通过标准 |
| --- | --- |
| 绑定/产物 | 控制台核对 preview/production UUID；前端 d1 标记；`/api/*` 实际执行 Function，无 HTML 回退 |
| CPU 与 KDF 上限 | 100,000 次 PBKDF2 的成功登录；分别记录墙钟耗时和平台 CPU、套餐额度/余量。仅本机耗时不通过；不能静默降低迭代数。另需留证：迭代数超过平台上限 100000 的凭据在真实环境登录失败时，文案指向 Secret 缺陷而不是「稍后重试」，且升级套餐不使其通过 |
| 公开读取 | 隔离阶段未授权外部不可读；切换后匿名 GET 200 且 no-store，只有公开投影，无凭据/会话/版本等内部字段 |
| 访客写入/初始化 | 未授权 PUT snapshot、POST migrate/restore、GET backup/audit/owner-snapshot 拒绝；setup/reset 不产生账号，GET 写路由不写库。比较版本确认未变 |
| 本人编辑 | 本人登录、读取 owner 快照、保存版本加一；独立访客刷新读到变化；两客户端旧版本保存/恢复 409，数据未被旧输入覆盖 |
| 注销/过期 | 旧 Cookie 在注销后再次请求 401；另开一次会话，等待绝对 30 分钟到期后再次请求 401。不把 Cookie/令牌保存到证据 |
| CSRF/CORS | 有本人会话但 Origin 错误/缺失时写入拒绝；跨域不能读授权响应；版本与内容未变 |
| 平台限流 | 规则 ID、路径/动作/窗口及安全事件可对照；多连接/新会话/别名不能绕过；导出预算与写预算分离，窗口到期恢复 |
| 迁移与备份 | empty 预览、来源完整安全副本、确认后的逐字段/时间/版本对账、在线完整副本；原 SQLite 保留，重复迁移拒绝 |
| 审计事务 | 原生 D1 batch 中 save/migrate/restore 实际变更与 success 对齐；冲突不推进版本；审计仅 time/operation/result/version |
| 审计故障 | 预览合成 D1 中暂停审计表可写性后保存 503，健康快照/版本不变；恢复 schema 后成功。只在私有维护环境故障注入 |
| unknown/not-initialized | 空 health_state 的合法请求对应 not-initialized；unknown 需元数据缺失而未确认提交的故障注入。原生 D1 无法注入时如实标 pending，不能以本地替身当平台证据 |
| 旧审计迁移 | 独立演练库先应用基础+0001、插入合成旧行，应用0002；ID 和旧结果原样保留，新增结果可写 |
| 分类/分页/保留 | 合成库写入/导出分别超过 10,000/1,000 条后，追加触发各自清理；分类游标读完所有保留行，导出不能挤掉写历史。此操作消耗平台额度，先核对套餐 |
| 备份拒绝/恢复前副本 | 匿名/伪造/注销/过期会话无法导出；确认恢复前 JSON/SQLite 均同步落盘；不可写目录/损坏文件阻止请求，当前版本不变 |
| 故障 fail-closed | 私有预览中明确取消 D1 绑定或使用不可用绑定并部署，GET/写请求报不可用；浏览器无缓存、本机 SQLite 或空看板回退。修复绑定并重部署后重验 |
| 平台恢复 | 先留 bookmark/离线副本，确认目标后 Time Travel；清除恢复出的会话、重验迁移/schema/完整数据，再重登录；不通过保持维护状态 |
| 定时备份 | 替换 plist 路径，权限正确；实际任务退出成功，产生新 JSON/SQLite，导出时间可核对。记录调度任务与最近成功时间，不记录健康内容 |
| 真实浏览器 | 预览与生产分别在桌面、移动浏览器验证读、登、存、锁、刷新、故障提示；浏览器版本和结果有记录 |
| 回滚/旧入口 | 保留前一部署与域名配置，验证立即重新封闭的路径；Pages 回滚与 D1 恢复分开；旧 Workbuddy/静态入口状态逐项记录 |

缺少目标环境、无法证明 CPU 余量、限流不覆盖、故障只能在本地模拟，或任何必需项仍 pending 时，停止切换。目标故障演练的操作日志可能包含健康内容或令牌，只保留在本人受限目录；仓库只写非敏感结论，不上传 HAR、Cookie、payload、原始 SQL 导出或密码材料。

## 恢复、定时备份与最后切换

完整步骤见 [D1 备份恢复指南](d1-backup-recovery.md)和 [Time Travel 官方说明](https://developers.cloudflare.com/d1/reference/time-travel/)。整库恢复会同时回退版本、审计、会话，必须停止编辑/公开流量、先保留离线副本与当前 bookmark，恢复后清除 `owner_session` 并核验 schema 和健康数据。CLI 恢复失败先检查在线状态，不盲目重放。`keepsRecoveryPoint` 仍为 false，不能开启“恢复上一次快照”。

每日模板 `ops/d1-backup.launchd.plist.example` 由本人复制至自己的 LaunchAgents，替换 Node/仓库/凭据/备份/日志路径与生产 origin。受限目录预建 0600 日志，先手工备份、再安装任务、再实际触发并核对新文件；不要让 agent 在没有真实路径和授权时安装。休眠/断网漏跑、凭据轮换、Access 令牌到期需要本人监测最近导出时间。

预览、生产维护窗口验收及离线备份全部通过后，本人确认公开范围，解除**生产自定义域名**的隔离。预览与 pages.dev/旧 hash 入口继续封闭。切换后立即验证匿名刷新见最新保存、本人登存锁、会话到期、移动流程及限流规则。任一失败重新封闭访问，不自动回退空数据。

回滚分两层：发布失败可恢复之前已验证的 Pages deployment，但这不会回退 D1；数据恢复必须在维护窗口执行备份/Time Travel，并重验 schema、数据和会话。不要回滚到缺少审计的代码后继续编辑当前库。没有可验证旧部署时，回滚措施就是继续隔离并修复，不猜测 deployment ID。

每项目标验收通过并经复核后，才更新 #06.1-06 的复选框和状态，并联动关闭 #06.1-05 的平台恢复/定时备份项。向导运行结束、构建成功或本地测试通过不自动关闭票据。
