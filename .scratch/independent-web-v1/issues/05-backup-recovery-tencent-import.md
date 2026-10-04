# 05: 备份、恢复与腾讯历史数据一次性导入

**What to build:** 让本人可以导出完整 JSON 备份和各类 CSV，预览并导入腾讯云文档导出的历史数据；导入、清空和替换操作具有校验、冲突提示、恢复点和失败保护。

**Blocked by:** 04: 饮食记录与营养目标

**Status:** resolved

- [x] JSON 备份可以完整保存并恢复设置和全部记录。
- [x] 体重、围度、打卡、步数和饮食分别支持固定格式 CSV 导入或导出。
- [x] 导入经过解析、校验、预览和确认四个阶段。
- [x] 错误行、重复记录和冲突记录显示明确数量和原因。
- [x] 导入失败不会改变当前数据。
- [x] 替换或清空前会生成恢复快照，并可以主动恢复。
- [x] 腾讯云文档只作为文件数据来源，不调用 API、MCP 或持续同步。
- [x] 重复执行同一导入不会重复创建体重、围度、步数和打卡记录。

## Comments

### 2026-10-05 — Closed after implementation verification

实现提交：`3efa374 feat: add backup recovery and csv transfer`；后续 `5a60850 fix: map diet csv nutrient columns` 修正饮食 CSV 营养列映射。

**自动化覆盖（`npm test`，9 个测试文件 / 37 项测试全通过）**

- JSON 完整备份往返 —— `tests/data-transfer.test.ts`：「round-trips the complete snapshot through JSON」
- 各类记录固定列 CSV 导出 —— `tests/data-transfer.test.ts`：「exports fixed CSV columns for every supported record kind」
- 导入四阶段（解析→校验→预览→确认）、错误与重复冲突计数、失败不改动当前快照 —— `tests/data-transfer.test.ts`：「previews CSV errors and duplicate conflicts without changing the source snapshot」「rejects a header-only CSV with a clear error」
- 导入失败不改数据 —— `tests/domain.test.ts`：「reports invalid JSON as an import validation result without mutating data」
- 写入失败保留原快照 —— `tests/storage.test.ts`：「keeps the accepted snapshot when a later commit cannot be written」

**代码证据**

- 四阶段 UI：`src/app.ts` 中 `renderTransferPreview` 展示接受 / 重复 / 冲突计数与错误明细，确认后由 `commit-transfer` 单次提交。
- 恢复点：`LocalStorageHealthRepository.commit` 在写入前把当前快照存入 `RECOVERY_KEY`；`restoreRecovery` 需显式确认后读取恢复快照。
- 清空：`data-action="clear-all"` 经 `canEdit()` 后调用 `clearAllRecords`。
- 幂等：`src/data-transfer.ts` 按「同日同值 → 重复跳过、同日异值 → 冲突并保留当前数据」判定体重 / 围度 / 步数，打卡按「同日 + 同类型 + 同项目」判定。
- 腾讯云文档仅作文件来源：`src/` 内无腾讯 API / MCP 调用，导入入口为本地 `<input type="file">`。

**未覆盖（勾选依据为代码阅读，非自动化验证）**

- 「替换或清空前会生成恢复快照，并可以主动恢复」：`loadRecovery` **无任何测试覆盖**（`tests/storage.test.ts` 中无 recovery 相关断言），**commit → recovery → restore 的完整链路未走通**。
- 「重复执行同一导入不会重复创建记录」：幂等判定逻辑已实现，`previews CSV errors and duplicate conflicts` 用例覆盖了重复计数，但**未验证「连续两次导入同一文件」这一实际场景**。

**范围说明**：#06 只读发布、#07 真实部署与历史数据验收不属于本次关闭范围。
