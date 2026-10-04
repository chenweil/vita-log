# 04: 饮食记录与营养目标

**What to build:** 让本人可以录入、修改和删除饮食记录，按日期和餐次查看食物，并看到热量、蛋白质、脂肪、碳水和钠的每日汇总及目标进度。

**Blocked by:** 03: 步数、训练习惯与行动日历

**Status:** resolved

- [x] 同一日期和餐次可以保存多条食物记录。
- [x] 重复食物不会因为日期、餐次和名称相同而被错误合并。
- [x] 饮食记录支持热量、蛋白质、脂肪、碳水、钠和备注。
- [x] 每日汇总、营养目标对比和进度显示正确。
- [x] 饮食记录出现在日历和最近记录中。
- [x] 只读模式下饮食新增、编辑和删除入口不可用。
- [x] 刷新页面后饮食记录和汇总保持一致。

## Comments

### 2026-10-05 — Closed after implementation verification

实现提交：`13ee96d feat: add diet tracking and nutrition summaries`；后续 `170dc48 feat: simplify AI-assisted diet entry` 扩充了 AI 辅助录入范围，`5a60850 fix: map diet csv nutrient columns` 修正了 CSV 营养列映射。

**自动化覆盖（`npm test`，9 个测试文件 / 37 项测试全通过）**

- 同日期同餐次可保存多条、重复食物不被合并 —— `tests/diet-editor.test.ts`：「allows multiple foods in the same meal and date」
- 按稳定 ID 更新与删除 —— `tests/diet-editor.test.ts`：「updates and deletes a food by stable id」
- 营养值与食物名校验 —— `tests/diet-editor.test.ts`：「rejects invalid food or nutrient values」
- 保存饮食记录并展示营养目标汇总 —— `tests/app.test.ts`：「saves a diet record and shows its nutrition target summary in owner mode」
- 持久化失败可见 —— `tests/app.test.ts`：「shows diet persistence errors in the diet form and global status」
- 营养列映射（含 CSV 往返后的列顺序）—— `tests/data-transfer.test.ts`：「imports the exported diet column order without rejecting valid nutrients」

**代码证据**

- 只读门控：`renderDietEditor` 在 `!editing` 时返回锁定卡片，写入经 `canEdit()`。
- 营养字段完整：`renderDietSummary` 渲染热量、蛋白质、脂肪、碳水、钠五项与目标对比及进度条；记录支持备注。

**未覆盖（勾选依据为代码阅读，非自动化验证）**

- 「每日汇总正确」：现有断言仅覆盖**单条记录**（200 kcal），**跨多条记录的累加汇总无用例**。
- 「饮食记录出现在日历和最近记录中」：`renderCalendar` / `renderCalendarDetail` 已包含当日饮食明细与汇总，`tests/` 中**无对应断言**。
- 「刷新页面后饮食记录和汇总保持一致」：无对应测试。

**范围说明**：#06 只读发布、#07 真实部署与历史数据验收不属于本次关闭范围。
