# 02: 本人编辑权限与体重围度追踪

**What to build:** 建立本人编辑能力和统一写入保护，让本人可以在本地验证后新增、修改、删除体重、体脂、腰围和臀围记录，并看到 BMI、腰臀比和体重/围度趋势变化。

**Blocked by:** 01: 独立静态应用与本地快照存储

**Status:** resolved

- [x] 页面默认处于只读状态，本地验证可以开启编辑会话，并在会话到期后恢复只读。
- [x] 所有写操作统一经过编辑能力检查，而不是只依赖控件的 disabled 样式。
- [x] 本人可以新增、编辑和删除体重、体脂、腰围和臀围记录。
- [x] 每日体重和围度记录遵守唯一性规则，冲突会被明确提示。
- [x] 删除和替换操作需要显式确认。
- [x] 保存成功后刷新页面仍能看到正确数据。
- [x] BMI 和腰臀比从原始输入计算，不能因冗余派生字段产生漂移。

## Comments

### 2026-10-05 — Closed after implementation verification

实现提交：`f4a02c7 feat: add owner body record editing`；后续 `c20e8db feat: add editable personal profile and linked health calculations` 扩充了本人档案编辑与联动计算范围。

**自动化覆盖（`npm test`，9 个测试文件 / 37 项测试全通过）**

- 写操作统一经过编辑能力检查 —— `tests/app.test.ts`：「requires owner access before allowing a body record to be saved」
- 会话到期恢复只读、显式锁定 —— `tests/auth.test.ts`：「restores a valid session and returns to read-only after expiry」「locks an active session explicitly」
- 新增 / 编辑 / 删除体重与围度 —— `tests/record-editor.test.ts`：「saves one weight and one measurement from the body record input」「updates an existing record without creating a duplicate」「deletes weight and measurement records through explicit operations」
- 体脂需配体重、成对记录编辑不误伤对方备注 —— `tests/record-editor.test.ts`：「does not silently discard body-fat input without a weight」「preserves the other record note when editing a paired record」
- 替换需显式确认 —— `tests/app.test.ts`：「requires confirmation before replacing an existing body record」
- 派生值由原始输入计算 —— `tests/domain.test.ts`：「calculates independent body metrics from known inputs」「normalizes a persisted snapshot without trusting derived or unknown fields」

**代码证据**

- 单一门控：`src/app.ts` 中 `canEdit()` 同时要求非 readerMode 且会话已解锁，写路径不依赖控件 `disabled`。
- 围度唯一性：`saveBodyRecords` 对同日期体重与围度分别返回「该日期已有……记录，请直接编辑那条记录」。

**未覆盖（勾选依据为代码阅读，非自动化验证）**

- 「每日体重和围度记录遵守唯一性规则」：唯一性分支存在于 `src/record-editor.ts`，但测试只断言了体重重复拒绝，**围度重复无对应用例**。
- 「保存成功后刷新页面仍能看到正确数据」：`tests/storage.test.ts` 的持久化用例以新建 repository 实例模拟读取，**非真实页面刷新**。

**范围说明**：#06 只读发布、#07 真实部署与历史数据验收不属于本次关闭范围。
