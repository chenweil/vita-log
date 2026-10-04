# 03: 步数、训练习惯与行动日历

**What to build:** 让本人可以记录每日步数、训练和习惯打卡；首页显示今日待办，日历展示完成状态，步数趋势随本地数据更新。

**Blocked by:** 02: 本人编辑权限与体重围度追踪

**Status:** resolved

- [x] 本人可以新增、编辑和删除每日步数记录。
- [x] 本人可以按日期完成、取消和补打训练与习惯。
- [x] 今日待办包含体重、训练、习惯和步数目标。
- [x] 日历详情可以查看并修改对应打卡。
- [x] 步数趋势、7 日移动平均和目标线使用本地快照数据。
- [x] 只读模式下所有步数和打卡修改入口不可用。
- [x] 刷新页面后步数、打卡、待办和日历状态保持一致。

## Comments

### 2026-10-05 — Closed after implementation verification

实现提交：`36c26b3 feat: add activity tracking and calendar actions`。

**自动化覆盖（`npm test`，9 个测试文件 / 37 项测试全通过）**

- 步数记录新增 / 编辑 / 删除，且每日唯一 —— `tests/activity-editor.test.ts`：「creates, updates and deletes one step record per day」
- 打卡完成与补建 —— `tests/activity-editor.test.ts`：「toggles a check-in and creates a missing check-in」

**代码证据**

- 只读门控：`renderActivityEditor` 在 `!editing` 时返回锁定卡片，`src/app.ts` 中步数与打卡写入均经 `canEdit()`。
- 步数趋势与目标线：`renderStepChart` 使用快照数据绘制折线、`target-line` 目标线与 7 日移动平均（近 7 点滑动平均，`Math.min(7, index + 1)` 处理不足区间）。

**未覆盖（勾选依据为代码阅读，非自动化验证）**

- 「今日待办包含体重、训练、习惯和步数目标」：`renderTodayList` 已按四类渲染，`tests/` 中**无任何针对今日待办的断言**。
- 「日历展示完成状态 / 日历详情可查看并修改打卡」：`renderCalendar` 与 `renderCalendarDetail` 已实现（日历详情按 `editing` 在按钮与只读 `<span>` 间切换），`tests/` 中**无日历渲染断言**。
- 「步数趋势、7 日移动平均和目标线」：**无测试**。
- 「刷新页面后步数、打卡、待办和日历状态保持一致」：无对应测试；持久化仅在 `tests/storage.test.ts` 层面覆盖，未贯通到视图。

**范围说明**：#06 只读发布、#07 真实部署与历史数据验收不属于本次关闭范围。
