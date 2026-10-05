import { ReadOnlyEditorAuth, type EditorAuth } from './auth';
import { deleteStep, saveStep, toggleCheckin } from './activity-editor';
import { deleteDiet, saveDiet } from './diet-editor';
import { exportCsv, exportJson, importCsvPreview, importJsonPreview, type CsvKind, type TransferPreview } from './data-transfer';
import { calculateBmi, calculateWhr, latestByDate, type DietRecord, type HealthSnapshot, type WeightRecord } from './domain';
import { deleteMeasurement, deleteWeight, saveBodyRecords, type BodyRecordTarget } from './record-editor';
import { LocalStorageHealthRepository, StorageError, type HealthDataRepository, type LoadStatus } from './storage';
import { createPublication, serializePublication } from './publication';

type StorageViewState = LoadStatus | 'saving' | 'saved' | 'error';

interface BodyFormState {
  target: BodyRecordTarget | null;
  date: string;
  weightKg: string;
  bodyfatPercent: string;
  waistCm: string;
  hipCm: string;
  note: string;
  error: string;
}

interface StepFormState {
  targetId: string | null;
  date: string;
  steps: string;
  note: string;
  error: string;
}

interface DietFormState {
  targetId: string | null;
  date: string;
  meal: string;
  food: string;
  calorie: string;
  protein: string;
  fat: string;
  carb: string;
  sodium: string;
  note: string;
  error: string;
  aiText: string;
}

type SaveErrorTarget = 'body' | 'step' | 'diet' | 'transfer';

export interface AppMountOptions {
  mode?: 'owner' | 'reader';
  publishedAt?: string;
}

const emptyForm = (): BodyFormState => ({ target: null, date: localDate(new Date()), weightKg: '', bodyfatPercent: '', waistCm: '', hipCm: '', note: '', error: '' });
const emptyStepForm = (): StepFormState => ({ targetId: null, date: localDate(new Date()), steps: '', note: '', error: '' });
const emptyDietForm = (): DietFormState => ({ targetId: null, date: localDate(new Date()), meal: '早餐', food: '', calorie: '', protein: '', fat: '', carb: '', sodium: '', note: '', error: '', aiText: '' });
const DIET_PROMPT = '请根据我提供的餐食照片或商品包装，识别食物和份量，只返回 JSON：{"food":"...","calorie":0,"protein":0,"fat":0,"carb":0,"sodium":0,"note":"估算依据"}。数值使用 kcal、g、mg。';

export function mountApp(container: HTMLElement, repository: HealthDataRepository, auth: EditorAuth = new ReadOnlyEditorAuth(), options: AppMountOptions = {}): () => void {
  const readerMode = options.mode === 'reader';
  const canEdit = (): boolean => !readerMode && auth.isUnlocked();
  let snapshot: HealthSnapshot | null = null;
  let storageState: StorageViewState = 'saving';
  let storageMessage = '正在读取本地数据…';
  let editing = canEdit();
  let authOpen = false;
  let formState = emptyForm();
  let stepForm = emptyStepForm();
  let dietForm = emptyDietForm();
  let selectedDate = localDate(new Date());
  let recoveryAvailable = false;
  let persistedSnapshot = false;
  let transferKind: CsvKind = 'weight';
  let transferPreview: TransferPreview | null = null;
  let transferMessage = '';
  let publicationMessage = '';

  const render = (): void => {
    if (!snapshot) {
      container.innerHTML = storageState === 'saving' ? renderLoading() : renderStorageError(storageMessage);
      bindReload(container, load);
      return;
    }
    editing = canEdit();
    container.innerHTML = renderDashboard(snapshot, storageState, storageMessage, editing, formState, stepForm, dietForm, selectedDate, authOpen, readerMode, options.publishedAt);
    if (auth instanceof ReadOnlyEditorAuth) {
      container.querySelectorAll('[data-action="auth-toggle"]').forEach(control => control.remove());
    }
    bindEvents();
    bindDataManager();
  };

  const load = async (): Promise<void> => {
    storageState = 'saving';
    storageMessage = '正在读取本地数据…';
    render();
    try {
      const result = await repository.load();
      snapshot = result.snapshot;
      persistedSnapshot = result.status === 'loaded';
      if (result.status === 'new') {
        storageState = 'saved';
        storageMessage = '本地存储已准备就绪';
      } else {
        storageState = 'loaded';
        storageMessage = '已从本地快照加载';
      }
      void repository.loadRecovery().then(() => { recoveryAvailable = true; if (snapshot) render(); }).catch(() => { recoveryAvailable = false; });
    } catch (error) {
      snapshot = null;
      storageState = 'error';
      storageMessage = error instanceof StorageError ? error.message : '本地数据读取失败';
    }
    render();
  };

  const saveSnapshot = async (next: HealthSnapshot, errorTarget: SaveErrorTarget = 'body'): Promise<boolean> => {
    if (!canEdit()) {
      editing = false;
      setSaveError(errorTarget, '编辑会话已失效，请重新验证');
      render();
      return false;
    }
    try {
      await repository.commit(next);
      snapshot = next;
      recoveryAvailable = recoveryAvailable || persistedSnapshot;
      persistedSnapshot = true;
      storageState = 'saved';
      storageMessage = '已保存本地快照';
      return true;
    } catch (error) {
      const saveError = error instanceof StorageError ? error.message : '本地数据保存失败';
      setSaveError(errorTarget, saveError);
      storageState = 'error';
      storageMessage = saveError;
      return false;
    }
  };

  const setSaveError = (target: SaveErrorTarget, message: string): void => {
    if (target === 'step') stepForm.error = message;
    else if (target === 'diet') dietForm.error = message;
    else if (target === 'transfer') transferMessage = message;
    else formState.error = message;
  };

  const submitBodyForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const numberOrUndefined = (key: string): number | undefined => {
      const value = String(data.get(key) ?? '').trim();
      return value === '' ? undefined : Number(value);
    };
    formState = {
      ...formState,
      date: String(data.get('date') ?? ''),
      weightKg: String(data.get('weightKg') ?? ''),
      bodyfatPercent: String(data.get('bodyfatPercent') ?? ''),
      waistCm: String(data.get('waistCm') ?? ''),
      hipCm: String(data.get('hipCm') ?? ''),
      note: String(data.get('note') ?? ''),
      error: '',
    };
    const result = saveBodyRecords(snapshot, {
      date: String(data.get('date') ?? ''),
      weightKg: numberOrUndefined('weightKg'),
      bodyfatPercent: numberOrUndefined('bodyfatPercent'),
      waistCm: numberOrUndefined('waistCm'),
      hipCm: numberOrUndefined('hipCm'),
      note: String(data.get('note') ?? ''),
    }, formState.target, new Date().toISOString());
    if (!result.ok) { formState.error = result.error; render(); return; }
    if (formState.target && !window.confirm('确定保存对这条记录的修改吗？')) { render(); return; }
    if (await saveSnapshot(result.snapshot)) formState = emptyForm();
    render();
  };

  const handleRecordAction = async (action: string, id: string): Promise<void> => {
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    if (action === 'edit-weight') {
      const record = snapshot.weights.find((item) => item.id === id);
      if (!record) return;
      const measurement = snapshot.measurements.find((item) => item.date === record.date);
      formState = { target: { kind: 'weight', weightId: record.id, measurementId: measurement?.id }, date: record.date, weightKg: String(record.weightKg), bodyfatPercent: record.bodyfatPercent == null ? '' : String(record.bodyfatPercent), waistCm: measurement ? String(measurement.waistCm) : '', hipCm: measurement ? String(measurement.hipCm) : '', note: record.note, error: '' };
      render();
      return;
    }
    if (action === 'edit-measurement') {
      const record = snapshot.measurements.find((item) => item.id === id);
      if (!record) return;
      const weight = snapshot.weights.find((item) => item.date === record.date);
      formState = { target: { kind: 'measurement', weightId: weight?.id, measurementId: record.id }, date: record.date, weightKg: weight ? String(weight.weightKg) : '', bodyfatPercent: weight?.bodyfatPercent == null ? '' : String(weight.bodyfatPercent), waistCm: String(record.waistCm), hipCm: String(record.hipCm), note: record.note, error: '' };
      render();
      return;
    }
    if (action === 'delete-weight' || action === 'delete-measurement') {
      if (!window.confirm(action === 'delete-weight' ? '确定删除这条体重记录吗？' : '确定删除这条围度记录吗？')) return;
      const next = action === 'delete-weight' ? deleteWeight(snapshot, id, new Date().toISOString()) : deleteMeasurement(snapshot, id, new Date().toISOString());
      if (await saveSnapshot(next)) render();
    }
  };

  const submitStepForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    stepForm = { ...stepForm, date: String(data.get('date') ?? ''), steps: String(data.get('steps') ?? ''), note: String(data.get('note') ?? ''), error: '' };
    const result = saveStep(snapshot, { date: stepForm.date, steps: Number(stepForm.steps), note: stepForm.note }, stepForm.targetId, new Date().toISOString());
    if (!result.ok) { stepForm.error = result.error; render(); return; }
    if (await saveSnapshot(result.snapshot, 'step')) stepForm = emptyStepForm();
    render();
  };

  const handleActivityAction = async (action: string, element: HTMLElement): Promise<void> => {
    if (action === 'calendar-day') {
      selectedDate = element.dataset.date ?? selectedDate;
      render();
      return;
    }
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    const date = element.dataset.date ?? selectedDate;
    const type = element.dataset.type as 'train' | 'habit' | undefined;
    if (action === 'toggle-checkin' && type) {
      if (await saveSnapshot(toggleCheckin(snapshot, date, type, element.dataset.item ?? '', new Date().toISOString()), 'step')) render();
      return;
    }
    const id = element.dataset.id ?? '';
    if (action === 'edit-step') {
      const record = snapshot.steps.find((item) => item.id === id);
      if (!record) return;
      stepForm = { targetId: record.id, date: record.date, steps: String(record.steps), note: record.note, error: '' };
      render();
      return;
    }
    if (action === 'delete-step') {
      if (!window.confirm('确定删除这条步数记录吗？')) return;
      if (await saveSnapshot(deleteStep(snapshot, id, new Date().toISOString()), 'step')) render();
    }
  };

  const submitDietForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    dietForm = { ...dietForm, date: String(data.get('date') ?? ''), meal: String(data.get('meal') ?? ''), aiText: String(data.get('aiText') ?? ''), error: '' };
    if (!dietForm.aiText.trim() && data.get('food')) {
      dietForm = { ...dietForm, food: String(data.get('food') ?? ''), calorie: String(data.get('calorie') ?? ''), protein: String(data.get('protein') ?? ''), fat: String(data.get('fat') ?? ''), carb: String(data.get('carb') ?? ''), sodium: String(data.get('sodium') ?? ''), note: String(data.get('note') ?? '') };
    }
    let parsed: Record<string, unknown>;
    try {
      if (!dietForm.aiText.trim() && dietForm.food) throw new Error('legacy');
      const raw: unknown = JSON.parse(dietForm.aiText.trim());
      parsed = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    } catch {
      if (dietForm.food && dietForm.calorie) { /* 兼容旧版结构化输入 */ } else {
      dietForm.error = '请粘贴 AI 返回的 JSON 数据，再保存。';
      render();
      return;
      }
    }
    const text = (key: string): string => String(parsed?.[key] ?? '').trim();
    if (dietForm.aiText.trim()) dietForm = { ...dietForm, meal: text('meal') || dietForm.meal, food: text('food'), calorie: text('calorie'), protein: text('protein'), fat: text('fat'), carb: text('carb'), sodium: text('sodium'), note: text('note') };
    const number = (value: string): number => value.trim() === '' ? Number.NaN : Number(value);
    const result = saveDiet(snapshot, { date: dietForm.date, meal: dietForm.meal, food: dietForm.food, calorie: number(dietForm.calorie), protein: number(dietForm.protein), fat: number(dietForm.fat), carb: number(dietForm.carb), sodium: number(dietForm.sodium), note: dietForm.note }, dietForm.targetId, new Date().toISOString());
    if (!result.ok) { dietForm.error = result.error; render(); return; }
    if (dietForm.targetId && !window.confirm('确定保存对这条饮食记录的修改吗？')) { render(); return; }
    if (await saveSnapshot(result.snapshot, 'diet')) dietForm = emptyDietForm();
    render();
  };

  const submitSettingsForm = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const number = (key: string): number => Number(data.get(key));
    const settings = { ...snapshot.settings, name: String(data.get('name') ?? '').trim(), gender: String(data.get('gender') ?? 'male') as HealthSnapshot['settings']['gender'], age: number('age'), heightCm: number('heightCm'), startWeightKg: number('startWeightKg'), targetWeightKg: number('targetWeightKg'), activityFactor: number('activityFactor'), calorieTarget: number('calorieTarget'), proteinTarget: number('proteinTarget'), fatTarget: number('fatTarget'), carbTarget: number('carbTarget'), sodiumTarget: number('sodiumTarget') };
    if (Object.values(settings).some((value) => typeof value === 'number' && !Number.isFinite(value))) return;
    if (await saveSnapshot({ ...snapshot, settings }, 'transfer')) render();
  };

  const handleDietAction = async (action: string, id: string): Promise<void> => {
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    if (action === 'edit-diet') {
      const record = snapshot.diets.find((item) => item.id === id);
      if (!record) return;
      dietForm = { targetId: record.id, date: record.date, meal: record.meal, food: record.food, calorie: String(record.calorie), protein: String(record.protein), fat: String(record.fat), carb: String(record.carb), sodium: String(record.sodium), note: record.note, error: '', aiText: JSON.stringify({ food: record.food, calorie: record.calorie, protein: record.protein, fat: record.fat, carb: record.carb, sodium: record.sodium, note: record.note }, null, 2) };
      render();
      return;
    }
    if (action === 'delete-diet') {
      if (!window.confirm('确定删除这条饮食记录吗？')) return;
      if (await saveSnapshot(deleteDiet(snapshot, id, new Date().toISOString()), 'diet')) render();
    }
  };

  const renderDataManager = (): void => {
    const main = container.querySelector('main.page');
    if (!main || main.querySelector('.data-manager-section')) return;
    if (readerMode) {
      const published = options.publishedAt ? formatPublicationDate(options.publishedAt) : '未知时间';
      main.insertAdjacentHTML('beforeend', `<section class="editor-section data-manager-section"><div class="section-heading"><div><p class="eyebrow">PUBLICATION · 发布</p><h2>只读分享</h2></div><span class="saved-note">公开快照</span></div><article class="card data-manager-card publication-card"><p>这是本人主动发布的只读快照，数据发布时间：<strong>${escapeHtml(published)}</strong>。</p><p class="muted">页面不会实时同步，也没有新增、编辑、删除、导入、清空或设置变更入口。访问者的操作不会写回本人的本地数据。</p></article></section>`);
      return;
    }
    const sqlite = repository as HealthDataRepository & { migrate?: (snapshot: HealthSnapshot) => Promise<void>; backup?: () => Promise<string>; restore?: (name: string) => Promise<void> };
    const sqliteActions = sqlite.migrate && editing ? '<button class="text-button" data-action="migrate-sqlite" type="button">迁移浏览器快照到 SQLite</button><button class="text-button" data-action="backup-sqlite" type="button">备份 SQLite 数据库</button><button class="text-button" data-action="restore-sqlite" type="button">恢复 SQLite 备份</button>' : '';
    main.insertAdjacentHTML('beforeend', `<section class="editor-section data-manager-section"><div class="section-heading"><div><p class="eyebrow">DATA · 数据</p><h2>备份与导入</h2></div><span class="saved-note">JSON 完整备份 · CSV 分类交换</span></div><article class="card data-manager-card"><div class="transfer-actions"><button class="text-button" data-action="export-json" type="button">导出完整 JSON</button><button class="text-button" data-action="export-csv" data-kind="weight" type="button">导出体重 CSV</button><button class="text-button" data-action="export-csv" data-kind="measurement" type="button">导出围度 CSV</button><button class="text-button" data-action="export-csv" data-kind="checkin" type="button">导出打卡 CSV</button><button class="text-button" data-action="export-csv" data-kind="step" type="button">导出步数 CSV</button><button class="text-button" data-action="export-csv" data-kind="diet" type="button">导出饮食 CSV</button>${sqliteActions}${editing ? '<button class="primary-button" data-action="publish" type="button">生成只读发布快照</button>' : ''}</div>${editing ? `<p class="muted">发布只会生成一个下载文件，不会自动公开本地变化。将文件部署为 <code>vita-log-publication.json</code>，再以 <code>?publication=vita-log-publication.json</code> 打开分享页面。</p>` : '<p class="muted">进入本人编辑模式后可以导入备份、历史 CSV 或生成只读发布快照。</p>'}${publicationMessage ? `<p class="saved-note" role="status">${escapeHtml(publicationMessage)}</p>` : ''}${editing ? `<div class="import-controls"><label>导入类型<select id="transferKind"><option value="weight" ${transferKind === 'weight' ? 'selected' : ''}>体重</option><option value="measurement" ${transferKind === 'measurement' ? 'selected' : ''}>围度</option><option value="checkin" ${transferKind === 'checkin' ? 'selected' : ''}>打卡</option><option value="step" ${transferKind === 'step' ? 'selected' : ''}>步数</option><option value="diet" ${transferKind === 'diet' ? 'selected' : ''}>饮食</option></select></label><label class="file-button">选择 JSON/CSV<input id="transferFile" type="file" accept=".json,.csv,application/json,text/csv"></label></div><button class="text-button danger-text" data-action="clear-all" type="button">清空全部记录</button>` : ''}${transferMessage ? `<p class="form-error" role="alert">${escapeHtml(transferMessage)}</p>` : ''}${transferPreview ? renderTransferPreview(transferPreview) : ''}<div class="recovery-row"><span>${recoveryAvailable ? '已有可恢复快照' : '暂无恢复快照'}</span>${editing ? `<button class="text-button" data-action="restore-recovery" type="button" ${recoveryAvailable ? '' : 'disabled'}>恢复上一次快照</button>` : ''}</div></article></section>`);
  };

  const bindDataManager = (): void => {
    renderDataManager();
    container.querySelectorAll<HTMLElement>('[data-action="export-json"]').forEach((button) => button.addEventListener('click', () => downloadText('vita-log-backup.json', exportJson(snapshot!), 'application/json')));
    container.querySelectorAll<HTMLElement>('[data-action="export-csv"]').forEach((button) => button.addEventListener('click', () => downloadText(`vita-log-${button.dataset.kind}.csv`, exportCsv(snapshot!, button.dataset.kind as CsvKind), 'text/csv;charset=utf-8')));
    container.querySelectorAll<HTMLElement>('[data-action="publish"]').forEach((button) => button.addEventListener('click', () => {
      if (!snapshot || !canEdit()) return;
      const publication = createPublication(snapshot);
      downloadText('vita-log-publication.json', serializePublication(publication), 'application/json');
      publicationMessage = `已生成 ${formatPublicationDate(publication.publishedAt)} 的只读快照；本地变化不会自动公开。`;
      render();
    }));
    container.querySelectorAll<HTMLElement>('[data-action="backup-sqlite"]').forEach((button) => button.addEventListener('click', () => { void backupSqlite(); }));
    container.querySelectorAll<HTMLElement>('[data-action="migrate-sqlite"]').forEach((button) => button.addEventListener('click', () => { void migrateToSqlite(); }));
    container.querySelectorAll<HTMLElement>('[data-action="restore-sqlite"]').forEach((button) => button.addEventListener('click', () => { void restoreSqlite(); }));
    container.querySelectorAll<HTMLSelectElement>('#transferKind').forEach((select) => select.addEventListener('change', () => { transferKind = select.value as CsvKind; }));
    container.querySelectorAll<HTMLInputElement>('#transferFile').forEach((input) => input.addEventListener('change', () => { const file = input.files?.[0]; if (file) void previewTransferFile(file); }));
    container.querySelectorAll<HTMLElement>('[data-action="cancel-transfer"]').forEach((button) => button.addEventListener('click', () => { transferPreview = null; transferMessage = ''; render(); }));
    container.querySelectorAll<HTMLElement>('[data-action="commit-transfer"]').forEach((button) => button.addEventListener('click', () => { void commitTransfer(); }));
    container.querySelectorAll<HTMLElement>('[data-action="restore-recovery"]').forEach((button) => button.addEventListener('click', () => { void restoreRecovery(); }));
    container.querySelectorAll<HTMLElement>('[data-action="clear-all"]').forEach((button) => button.addEventListener('click', () => { void clearAllRecords(); }));
  };

  const migrateToSqlite = async (): Promise<void> => {
    const sqlite = repository as HealthDataRepository & { migrate?: (snapshot: HealthSnapshot) => Promise<void>; previewMigration?: (snapshot: HealthSnapshot) => Promise<{ empty: boolean; summary: { total: number; firstDate: string | null; lastDate: string | null; counts: Record<string, number>; settings: { name: string; heightCm: number; targetWeightKg: number } } }> };
    if (!sqlite.migrate || !canEdit()) return;
    try {
      const local = await new LocalStorageHealthRepository(window.localStorage).load();
      const preview = sqlite.previewMigration ? await sqlite.previewMigration(local.snapshot) : { empty: true, summary: { total: 0, firstDate: null, lastDate: null, counts: {}, settings: { name: '', heightCm: 0, targetWeightKg: 0 } } };
      const count = preview.summary.total;
      const range = preview.summary.firstDate ? `${preview.summary.firstDate} 至 ${preview.summary.lastDate}` : '无记录日期';
      const breakdown = Object.entries(preview.summary.counts).map(([key, value]) => `${key} ${value}`).join('、');
      const settings = `${preview.summary.settings.name || '未设置昵称'} · ${preview.summary.settings.heightCm} cm · 目标 ${preview.summary.settings.targetWeightKg} kg`;
      if (!window.confirm(`迁移预览：浏览器快照 ${count} 条（${breakdown}；${range}；${settings}），SQLite ${preview.empty ? '为空，可迁移' : '已有数据，将拒绝自动迁移'}。确认迁移？`)) return;
      await sqlite.migrate(local.snapshot);
      snapshot = local.snapshot; persistedSnapshot = true; storageState = 'saved'; storageMessage = '已迁移到 SQLite'; transferMessage = '迁移完成；SQLite 现在是日常事实来源';
    } catch (error) { transferMessage = error instanceof StorageError ? error.message : 'SQLite 迁移失败，当前数据未改变'; }
    render();
  };

  const backupSqlite = async (): Promise<void> => {
    const sqlite = repository as HealthDataRepository & { backup?: () => Promise<string> };
    if (!sqlite.backup || !canEdit()) return;
    try { transferMessage = `SQLite 备份完成：${await sqlite.backup()}`; } catch (error) { transferMessage = error instanceof StorageError ? error.message : 'SQLite 备份失败'; }
    render();
  };

  const restoreSqlite = async (): Promise<void> => {
    const sqlite = repository as HealthDataRepository & { listBackups?: () => Promise<Array<{ name: string; createdAt: string; summary: { total: number; firstDate: string | null; lastDate: string | null; settings: { name: string; heightCm: number; targetWeightKg: number } } }>>; restore?: (name: string) => Promise<void> };
    if (!sqlite.listBackups || !sqlite.restore || !canEdit()) return;
    try {
      const backups = await sqlite.listBackups();
      if (!backups.length) { transferMessage = '当前没有可恢复的 SQLite 备份'; render(); return; }
      const choices = backups.map((backup, index) => `${index + 1}. ${backup.name} · 备份于 ${backup.createdAt} · ${backup.summary.total} 条 · ${backup.summary.firstDate ?? '无日期'} 至 ${backup.summary.lastDate ?? '无日期'} · ${backup.summary.settings.name || '未设置昵称'} · ${backup.summary.settings.heightCm} cm · 目标 ${backup.summary.settings.targetWeightKg} kg`).join('\n');
      const selected = window.prompt(`选择要恢复的备份编号：\n${choices}`, '1');
      const index = Number(selected) - 1;
      const backup = Number.isInteger(index) ? backups[index] : undefined;
      if (!backup || !window.confirm(`将先备份当前 SQLite，再恢复 ${backup.name}（${backup.summary.total} 条记录）。继续吗？`)) return;
      await sqlite.restore(backup.name);
      const loaded = await repository.load();
      snapshot = loaded.snapshot; storageState = 'saved'; storageMessage = '已恢复 SQLite 备份'; transferMessage = `已恢复：${backup.name}`;
    } catch (error) { transferMessage = error instanceof StorageError ? error.message : 'SQLite 恢复失败，当前数据未改变'; }
    render();
  };

  const previewTransferFile = async (file: File): Promise<void> => {
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    transferMessage = '';
    try {
      const text = await file.text();
      transferPreview = file.name.toLowerCase().endsWith('.json') ? importJsonPreview(text, snapshot) : importCsvPreview(snapshot, transferKind, text, new Date().toISOString());
    } catch { transferMessage = '读取导入文件失败'; }
    render();
  };

  const commitTransfer = async (): Promise<void> => {
    if (!snapshot || !transferPreview?.snapshot || !transferPreview.valid || !canEdit()) { transferMessage = '请先完成校验并进入编辑模式'; render(); return; }
    if (!window.confirm('导入确认：当前数据会在恢复点中保留，确认写入导入结果吗？')) return;
    if (await saveSnapshot(transferPreview.snapshot, 'transfer')) { transferMessage = `导入完成：${transferPreview.accepted} 条记录`; transferPreview = null; }
    render();
  };

  const restoreRecovery = async (): Promise<void> => {
    if (!canEdit()) { editing = false; render(); return; }
    if (!window.confirm('确定恢复上一次本地快照吗？当前数据会先保存在新的恢复点中。')) return;
    try {
      const recovered = await repository.loadRecovery();
      if (await saveSnapshot(recovered, 'transfer')) { transferMessage = '已恢复上一次本地快照'; }
    } catch (error) { transferMessage = error instanceof StorageError ? error.message : '恢复快照失败'; }
    render();
  };

  const clearAllRecords = async (): Promise<void> => {
    if (!snapshot || !canEdit()) { editing = false; render(); return; }
    if (!window.confirm('确定清空全部体重、围度、步数、打卡和饮食记录吗？当前数据会先保存到恢复点。')) return;
    const next: HealthSnapshot = { ...snapshot, updatedAt: new Date().toISOString(), weights: [], measurements: [], steps: [], checkins: [], diets: [] };
    if (await saveSnapshot(next, 'transfer')) transferMessage = '已清空全部记录，可从恢复点还原';
    render();
  };

  const bindEvents = (): void => {
    bindReload(container, load);
    container.querySelectorAll<HTMLElement>('[data-action="auth-toggle"]').forEach((button) => button.addEventListener('click', () => {
      if (canEdit()) { auth.lock(); editing = false; formState = emptyForm(); render(); }
      else { authOpen = true; render(); }
    }));
    container.querySelectorAll<HTMLElement>('[data-action="close-auth"]').forEach((button) => button.addEventListener('click', () => { authOpen = false; render(); }));
    container.querySelectorAll<HTMLFormElement>('#authForm').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const ok = await auth.unlock(String(data.get('username') ?? ''), String(data.get('password') ?? ''));
      if (ok) { authOpen = false; editing = true; formState.error = ''; }
      else formState.error = '账号或密码错误，未进入编辑模式';
      render();
    }));
    container.querySelectorAll<HTMLFormElement>('#bodyRecordForm').forEach((form) => form.addEventListener('submit', (event) => { void submitBodyForm(event); }));
    container.querySelectorAll<HTMLFormElement>('#stepForm').forEach((form) => form.addEventListener('submit', (event) => { void submitStepForm(event); }));
    container.querySelectorAll<HTMLFormElement>('#dietForm').forEach((form) => form.addEventListener('submit', (event) => { void submitDietForm(event); }));
    container.querySelectorAll<HTMLFormElement>('#settingsForm').forEach((form) => form.addEventListener('submit', (event) => { void submitSettingsForm(event); }));
    container.querySelectorAll<HTMLElement>('[data-action="reset-body-form"]').forEach((button) => button.addEventListener('click', () => { formState = emptyForm(); render(); }));
    container.querySelectorAll<HTMLElement>('[data-action="edit-weight"], [data-action="edit-measurement"], [data-action="delete-weight"], [data-action="delete-measurement"]').forEach((button) => button.addEventListener('click', () => { void handleRecordAction(button.dataset.action ?? '', button.dataset.id ?? ''); }));
    container.querySelectorAll<HTMLElement>('[data-action="calendar-day"], [data-action="toggle-checkin"], [data-action="edit-step"], [data-action="delete-step"]').forEach((button) => button.addEventListener('click', () => { void handleActivityAction(button.dataset.action ?? '', button); }));
    container.querySelectorAll<HTMLElement>('[data-action="reset-step-form"]').forEach((button) => button.addEventListener('click', () => { stepForm = emptyStepForm(); render(); }));
    container.querySelectorAll<HTMLElement>('[data-action="edit-diet"], [data-action="delete-diet"]').forEach((button) => button.addEventListener('click', () => { void handleDietAction(button.dataset.action ?? '', button.dataset.id ?? ''); }));
    container.querySelectorAll<HTMLElement>('[data-action="reset-diet-form"]').forEach((button) => button.addEventListener('click', () => { dietForm = emptyDietForm(); render(); }));
    container.querySelectorAll<HTMLElement>('[data-action="copy-diet-prompt"]').forEach((button) => button.addEventListener('click', () => { void navigator.clipboard?.writeText(DIET_PROMPT); button.textContent = '已复制'; window.setTimeout(() => { button.textContent = '复制提示词'; }, 1600); }));
    container.querySelectorAll<HTMLElement>('[data-action="show-diet-prompt"]').forEach((button) => button.addEventListener('click', () => window.alert(DIET_PROMPT)));
  };

  const expiryTimer = window.setInterval(() => {
    if (editing && !canEdit()) { editing = false; formState = emptyForm(); render(); }
  }, 1_000);

  void load();
  return () => window.clearInterval(expiryTimer);
}

function renderDashboard(snapshot: HealthSnapshot, state: StorageViewState, message: string, editing: boolean, formState: BodyFormState, stepForm: StepFormState, dietForm: DietFormState, selectedDate: string, authOpen: boolean, readerMode = false, publishedAt?: string): string {
  const latestWeight = latestByDate(snapshot.weights);
  const latestMeasurement = latestByDate(snapshot.measurements);
  const bmi = latestWeight ? calculateBmi(latestWeight.weightKg, snapshot.settings.heightCm) : null;
  const whr = latestMeasurement ? calculateWhr(latestMeasurement.waistCm, latestMeasurement.hipCm) : null;
  const today = localDate(new Date());
  const todaySteps = snapshot.steps.find((record) => record.date === today);
  const todayDiet = snapshot.diets.filter((record) => record.date === today);
  const goalProgress = latestWeight ? progressPercent(latestWeight.weightKg, snapshot.settings.startWeightKg, snapshot.settings.targetWeightKg) : 0;
  const greeting = snapshot.settings.name ? `${snapshot.settings.name}，今天也稳稳向前。` : '今天也稳稳向前。';
  const bodyStatus = renderBodyStatus(snapshot, whr, goalProgress, todayDiet);
  const topActions = readerMode ? '<span class="read-only-pill"><span class="status-dot"></span>只读 · 已发布</span><button class="icon-button" data-action="reload" aria-label="刷新发布快照" title="刷新发布快照">↻</button>' : `<span class="read-only-pill"><span class="status-dot"></span>${editing ? '本人编辑' : '只读 · 本地'}</span><button class="auth-button" data-action="auth-toggle" type="button">${editing ? '锁定' : '进入编辑'}</button><button class="icon-button" data-action="reload" aria-label="刷新本地数据" title="刷新本地数据">↻</button>`;
  const publicationBanner = readerMode ? `<section class="card publication-banner"><strong>只读发布快照</strong><span>数据发布时间：${escapeHtml(publishedAt ? formatPublicationDate(publishedAt) : '未知时间')} · 不是实时同步</span></section>` : '';
  return `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">轻</div><div><strong>轻盈计划</strong><span>个人健康记录</span></div></div><div class="top-actions">${topActions}</div></header><main class="page">${publicationBanner}<section class="hero-card"><div><p class="eyebrow">DAILY CHECK-IN · ${escapeHtml(today)}</p><h1>${escapeHtml(greeting)}</h1><p class="hero-copy">把今天的记录留给自己，趋势会替你记住坚持。</p></div><div class="hero-ring" aria-label="目标进度 ${Math.round(goalProgress)}%"><span>${Math.round(goalProgress)}<small>%</small></span><em>目标进度</em></div></section><section class="section-block"><div class="section-heading"><div><p class="eyebrow">OVERVIEW · 概览</p><h2>今天的身体状态</h2></div><span class="saved-note ${state === 'error' ? 'error' : ''}">${escapeHtml(message)}</span></div><div class="metric-grid">${metricCard('当前体重', latestWeight ? `${formatNumber(latestWeight.weightKg)} <small>kg</small>` : '--', latestWeight ? latestWeight.date : '还没有记录', 'primary')}${metricCard('BMI', bmi ? formatNumber(bmi, 1) : '--', bmi ? bmiLabel(bmi) : '记录体重后显示', 'accent')}${metricCard('今日步数', todaySteps ? formatInteger(todaySteps.steps) : '--', todaySteps ? `${todaySteps.steps >= 8000 ? '已达标' : '目标 8000 步'}` : '还没有记录', 'blue')}${metricCard('今日饮食', todayDiet.length ? `${formatInteger(sum(todayDiet, 'calorie'))} <small>kcal</small>` : '--', todayDiet.length ? `${todayDiet.length} 条记录` : '还没有记录', 'amber')}</div>${bodyStatus}</section>${renderEditor(snapshot, editing, formState, readerMode)}${renderDietEditor(snapshot, editing, dietForm, selectedDate, readerMode)}${renderActivityEditor(snapshot, editing, stepForm, readerMode)}<section class="two-column"><article class="card goal-card"><div class="card-heading"><div><p class="eyebrow">GOAL · 目标</p><h2>减脂进度</h2></div><span class="goal-number">${formatNumber(snapshot.settings.targetWeightKg)} <small>kg</small></span></div><div class="progress-track"><span style="width:${Math.min(100, Math.max(0, goalProgress))}%"></span></div><div class="goal-row"><span>起始体重 <b>${formatNumber(snapshot.settings.startWeightKg)} kg</b></span><span>目标体重 <b>${formatNumber(snapshot.settings.targetWeightKg)} kg</b></span></div><div class="detail-list"><div><span>最近围度</span><b>${latestMeasurement ? `${formatNumber(latestMeasurement.waistCm)} / ${formatNumber(latestMeasurement.hipCm)} cm` : '--'}</b></div><div><span>腰臀比 WHR</span><b>${whr ? formatNumber(whr, 2) : '--'}</b></div><div><span>目标体脂</span><b>${formatNumber(snapshot.settings.targetBodyfatPercent, 1)}%</b></div></div></article><article class="card today-card"><div class="card-heading"><div><p class="eyebrow">TODAY · 今日</p><h2>记录状态</h2></div><span class="status-label">${editing ? '本人编辑' : '只读预览'}</span></div>${renderTodayList(snapshot, today)}</article></section><section class="card chart-card"><div class="card-heading"><div><p class="eyebrow">TREND · 趋势</p><h2>体重趋势</h2></div><span class="chart-meta">${snapshot.weights.length ? `共 ${snapshot.weights.length} 条` : '等待第一条记录'}</span></div>${renderWeightChart(snapshot.weights)}</section><section class="card chart-card"><div class="card-heading"><div><p class="eyebrow">MEASURE · 围度</p><h2>腰围与臀围趋势</h2></div><span class="chart-meta">${snapshot.measurements.length ? `共 ${snapshot.measurements.length} 条` : '等待第一条记录'}</span></div>${renderMeasurementChart(snapshot.measurements)}</section><section class="card chart-card"><div class="card-heading"><div><p class="eyebrow">ACTIVITY · 步数</p><h2>步数趋势</h2></div><span class="chart-meta">目标 8000 步</span></div>${renderStepChart(snapshot.steps)}</section><section class="card calendar-card"><div class="card-heading"><div><p class="eyebrow">CALENDAR · 日历</p><h2>最近 7 天</h2></div><span class="chart-meta">体重 · 步数 · 饮食 · 打卡</span></div>${renderCalendar(snapshot, today, selectedDate)}${renderCalendarDetail(snapshot, selectedDate, editing)}</section><section class="two-column lower-grid">${renderSettingsCard(snapshot, editing)}<article class="card backup-card"><div class="card-heading"><div><p class="eyebrow">STORAGE · 存储</p><h2>${readerMode ? '发布数据' : '本地数据'}</h2></div><span class="status-check">✓</span></div><p>${readerMode ? '当前显示的是本人主动发布的只读快照。页面不会向本人的浏览器本地数据写入内容。' : '当前页面使用浏览器本地快照。第一版不会向腾讯云文档或 Workbuddy 发起请求。'}</p><div class="data-count">${snapshot.weights.length + snapshot.measurements.length + snapshot.steps.length + snapshot.checkins.length + snapshot.diets.length}<small> 条记录</small></div><p class="muted">${readerMode ? '数据可能晚于本人最新记录，请以发布时间为准。' : '请定期导出完整备份，避免浏览器数据成为唯一副本。'}</p></article></section></main><footer class="footer">轻盈计划 · 独立静态版 <span>${readerMode ? '只读发布 · 不是实时同步' : '数据只保存在当前浏览器'}</span></footer>${authOpen ? renderAuthModal(formState.error) : ''}</div>`;
}

function renderBodyStatus(snapshot: HealthSnapshot, whr: number | null, progress: number, todayDiet: DietRecord[]): string {
  const settings = snapshot.settings;
  const weight = latestByDate(snapshot.weights)?.weightKg ?? settings.startWeightKg;
  const bmr = Math.round(10 * weight + 6.25 * settings.heightCm - 5 * settings.age + (settings.gender === 'male' ? 5 : -161));
  const tdee = Math.round(bmr * settings.activityFactor);
  const calories = todayDiet.reduce((total, item) => total + item.calorie, 0);
  const protein = todayDiet.reduce((total, item) => total + item.protein, 0);
  const fat = todayDiet.reduce((total, item) => total + item.fat, 0);
  const carb = todayDiet.reduce((total, item) => total + item.carb, 0);
  return `<div class="body-status-details"><article class="card goal-card"><div class="card-heading"><div><p class="eyebrow">PROGRESS · 目标进度与代谢</p><h3>目标进度与代谢</h3></div><span class="goal-number">${Math.round(progress)}%</span></div><div class="progress-track"><span style="width:${Math.min(100, Math.max(0, progress))}%"></span></div><div class="goal-row"><span>当前 / 目标 <b>${formatNumber(weight)} / ${formatNumber(settings.targetWeightKg)} kg</b></span><span>还差 <b>${formatNumber(Math.max(0, weight - settings.targetWeightKg))} kg</b></span></div><div class="detail-list"><div><span>基础代谢 BMR</span><b>${formatInteger(bmr)} kcal</b></div><div><span>日常消耗 TDEE</span><b>${formatInteger(tdee)} kcal</b></div><div><span>腰臀比 WHR</span><b>${whr ? formatNumber(whr, 2) : '--'}</b></div></div></article><article class="card metabolism-card"><div class="card-heading"><div><p class="eyebrow">METABOLISM · 代谢与饮食目标</p><h3>代谢与饮食目标</h3></div><span class="chart-meta">今日 ${formatNumber(calories, 0)} / ${formatInteger(settings.calorieTarget)} kcal</span></div><div class="diet-macro-grid"><div><span>热量</span><b>${formatNumber(calories, 0)} / ${formatInteger(settings.calorieTarget)} kcal</b></div><div><span>蛋白质</span><b>${formatNumber(protein, 0)} / ${formatInteger(settings.proteinTarget)} g</b></div><div><span>脂肪</span><b>${formatNumber(fat, 0)} / ${formatInteger(settings.fatTarget)} g</b></div><div><span>碳水</span><b>${formatNumber(carb, 0)} / ${formatInteger(settings.carbTarget)} g</b></div><div><span>钠上限</span><b>&lt; ${formatInteger(settings.sodiumTarget)} mg</b></div></div></article></div>`;
}

function renderSettingsCard(snapshot: HealthSnapshot, editing: boolean): string {
  const s = snapshot.settings;
  if (!editing) return `<article class="card"><div class="card-heading"><div><p class="eyebrow">PROFILE · 设置</p><h2>当前计划</h2></div></div><div class="profile-grid"><div><span>身高</span><b>${formatNumber(s.heightCm)} cm</b></div><div><span>年龄</span><b>${s.age} 岁</b></div><div><span>热量目标</span><b>${formatInteger(s.calorieTarget)} kcal</b></div><div><span>蛋白质目标</span><b>${formatInteger(s.proteinTarget)} g</b></div></div><p class="muted">进入本人编辑模式后可以维护个人基础数据和每日目标。</p></article>`;
  return `<article class="card settings-card"><div class="card-heading"><div><p class="eyebrow">PROFILE · 个人基础数据</p><h2>设置</h2></div></div><p class="muted settings-linked-note">保存后会同步更新 BMI、目标进度、BMR/TDEE 和饮食目标进度。</p><form id="settingsForm" class="settings-form"><label>昵称<input name="name" value="${escapeHtml(s.name)}"></label><label>性别<select name="gender"><option value="male">男</option><option value="female" ${s.gender === 'female' ? 'selected' : ''}>女</option><option value="other" ${s.gender === 'other' ? 'selected' : ''}>其他</option></select></label><label>年龄<input name="age" type="number" value="${s.age}"></label><label>身高（cm）<input name="heightCm" type="number" value="${s.heightCm}"></label><label>起始体重（kg）<input name="startWeightKg" type="number" step="0.1" value="${s.startWeightKg}"></label><label>目标体重（kg）<input name="targetWeightKg" type="number" step="0.1" value="${s.targetWeightKg}"></label><label>活动水平<select name="activityFactor"><option value="1.2">久坐</option><option value="1.375" ${s.activityFactor === 1.375 ? 'selected' : ''}>轻度</option><option value="1.55" ${s.activityFactor === 1.55 ? 'selected' : ''}>中度</option><option value="1.725">高活动</option></select></label><label>每日摄入（kcal）<input name="calorieTarget" type="number" value="${s.calorieTarget}"></label><label>蛋白质（g）<input name="proteinTarget" type="number" value="${s.proteinTarget}"></label><label>脂肪（g）<input name="fatTarget" type="number" value="${s.fatTarget}"></label><label>碳水（g）<input name="carbTarget" type="number" value="${s.carbTarget}"></label><label>钠上限（mg/天）<input name="sodiumTarget" type="number" value="${s.sodiumTarget}"></label><button class="primary-button wide-field" type="submit">保存个人设置</button></form></article>`;
}

function renderEditor(snapshot: HealthSnapshot, editing: boolean, form: BodyFormState, readerMode = false): string {
  const locked = `<article class="card editor-card locked-editor"><div><p class="eyebrow">RECORD · 记录</p><h2>体重与围度</h2><p class="muted">${readerMode ? '这是只读发布页面，体重、体脂和围度记录不能修改。' : '当前为只读模式。验证本人身份后可以新增、修改和删除体重、体脂、腰围和臀围。'}</p></div>${readerMode ? '' : '<button class="primary-button" data-action="auth-toggle" type="button">进入编辑模式</button>'}</article>`;
  const formTitle = form.target ? '编辑身体记录' : '新增身体记录';
  const weights = [...snapshot.weights].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const measurements = [...snapshot.measurements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  return `<section class="editor-section"><div class="section-heading"><div><p class="eyebrow">RECORD · 记录</p><h2>体重与围度</h2></div><span class="saved-note">${form.target ? '正在编辑记录' : '体重、体脂、腰围和臀围'}</span></div>${editing ? `<article class="card editor-card"><div class="card-heading"><div><p class="eyebrow">${form.target ? 'EDIT · 编辑' : 'ADD · 新增'}</p><h2>${formTitle}</h2></div>${form.target ? '<button class="text-button" data-action="reset-body-form" type="button">取消编辑</button>' : ''}</div><form id="bodyRecordForm" class="body-record-form"><label>日期<input name="date" type="date" required value="${escapeHtml(form.date)}"></label><label>体重（kg）<input name="weightKg" type="number" min="20" max="400" step="0.1" placeholder="如 77.2" value="${escapeHtml(form.weightKg)}"></label><label>体脂率（%）<input name="bodyfatPercent" type="number" min="3" max="70" step="0.1" placeholder="选填" value="${escapeHtml(form.bodyfatPercent)}"></label><label>腰围（cm）<input name="waistCm" type="number" min="40" max="250" step="0.1" placeholder="选填" value="${escapeHtml(form.waistCm)}"></label><label>臀围（cm）<input name="hipCm" type="number" min="40" max="300" step="0.1" placeholder="选填" value="${escapeHtml(form.hipCm)}"></label><label class="wide-field">备注<input name="note" maxlength="80" placeholder="如 晨起空腹" value="${escapeHtml(form.note)}"></label><div class="form-actions wide-field"><button class="primary-button" type="submit">${form.target ? '保存修改' : '保存记录'}</button>${form.error ? `<span class="form-error" role="alert">${escapeHtml(form.error)}</span>` : ''}</div></form></article>${renderHistory(weights, measurements)}` : locked}</section>`;
}

function renderHistory(weights: WeightRecord[], measurements: HealthSnapshot['measurements']): string {
  return `<article class="card history-card"><div class="history-columns"><div><h3>最近体重</h3>${weights.length ? weights.map((record) => `<div class="history-row"><div><b>${record.date}</b><span>${formatNumber(record.weightKg)} kg${record.bodyfatPercent == null ? '' : ` · 体脂 ${formatNumber(record.bodyfatPercent)}%`}</span></div><div class="row-actions"><button class="text-button" data-action="edit-weight" data-id="${escapeHtml(record.id)}" type="button">编辑</button><button class="text-button danger-text" data-action="delete-weight" data-id="${escapeHtml(record.id)}" type="button">删除</button></div></div>`).join('') : '<p class="muted">还没有体重记录。</p>'}</div><div><h3>最近围度</h3>${measurements.length ? measurements.map((record) => `<div class="history-row"><div><b>${record.date}</b><span>腰 ${formatNumber(record.waistCm)} / 臀 ${formatNumber(record.hipCm)} cm · WHR ${formatNumber(calculateWhr(record.waistCm, record.hipCm) ?? 0, 2)}</span></div><div class="row-actions"><button class="text-button" data-action="edit-measurement" data-id="${escapeHtml(record.id)}" type="button">编辑</button><button class="text-button danger-text" data-action="delete-measurement" data-id="${escapeHtml(record.id)}" type="button">删除</button></div></div>`).join('') : '<p class="muted">还没有围度记录。</p>'}</div></div></article>`;
}

function renderActivityEditor(snapshot: HealthSnapshot, editing: boolean, form: StepFormState, readerMode = false): string {
  const today = localDate(new Date());
  const dayOfWeek = new Date(`${today}T12:00:00`).getDay();
  const trains = snapshot.settings.trainingPlan[String(dayOfWeek)] ?? [];
  const habits = snapshot.settings.habits;
  const steps = [...snapshot.steps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  if (!editing) return `<section class="editor-section"><div class="section-heading"><div><p class="eyebrow">ACTIVITY · 活动</p><h2>步数与打卡</h2></div></div><article class="card editor-card locked-editor"><div><p class="muted">${readerMode ? '这是只读发布页面，步数和训练习惯打卡不能修改。' : '当前为只读模式。进入本人编辑模式后可以记录步数和训练习惯打卡。'}</p></div>${readerMode ? '' : '<button class="primary-button" data-action="auth-toggle" type="button">进入编辑模式</button>'}</article></section>`;
  return `<section class="editor-section"><div class="section-heading"><div><p class="eyebrow">ACTIVITY · 活动</p><h2>步数与打卡</h2></div><span class="saved-note">${form.targetId ? '正在编辑步数' : '今日活动'}</span></div><div class="two-column activity-grid"><article class="card editor-card"><div class="card-heading"><div><p class="eyebrow">${form.targetId ? 'EDIT · 编辑' : 'ADD · 新增'}</p><h2>${form.targetId ? '编辑步数' : '记录步数'}</h2></div>${form.targetId ? '<button class="text-button" data-action="reset-step-form" type="button">取消编辑</button>' : ''}</div><form id="stepForm" class="body-record-form"><label>日期<input name="date" type="date" required value="${escapeHtml(form.date)}"></label><label>步数<input name="steps" type="number" min="0" max="200000" step="1" required placeholder="如 8500" value="${escapeHtml(form.steps)}"></label><label>备注<input name="note" maxlength="80" placeholder="如 公园散步" value="${escapeHtml(form.note)}"></label><div class="form-actions wide-field"><button class="primary-button" type="submit">${form.targetId ? '保存修改' : '保存步数'}</button>${form.error ? `<span class="form-error" role="alert">${escapeHtml(form.error)}</span>` : ''}</div></form><div class="history-list"><h3>最近步数</h3>${steps.length ? steps.map((record) => `<div class="history-row"><div><b>${record.date}</b><span>${formatInteger(record.steps)} 步${record.note ? ` · ${escapeHtml(record.note)}` : ''}</span></div><div class="row-actions"><button class="text-button" data-action="edit-step" data-id="${escapeHtml(record.id)}" type="button">编辑</button><button class="text-button danger-text" data-action="delete-step" data-id="${escapeHtml(record.id)}" type="button">删除</button></div></div>`).join('') : '<p class="muted">还没有步数记录。</p>'}</div></article><article class="card editor-card"><div class="card-heading"><div><p class="eyebrow">CHECK-IN · 打卡</p><h2>今日计划</h2></div></div><div class="checkin-group"><h3>训练</h3>${trains.length ? trains.map((item) => checkinButton(snapshot, today, 'train', item)).join('') : '<p class="muted">今天没有训练计划。</p>'}</div><div class="checkin-group"><h3>习惯</h3>${habits.map((item) => checkinButton(snapshot, today, 'habit', item)).join('')}</div></article></div></section>`;
}

function renderDietEditor(snapshot: HealthSnapshot, editing: boolean, form: DietFormState, selectedDate: string, readerMode = false): string {
  const todayDiets = snapshot.diets.filter((record) => record.date === selectedDate);
  const totals = todayDiets.reduce((sum, record) => ({ calorie: sum.calorie + record.calorie, protein: sum.protein + record.protein, fat: sum.fat + record.fat, carb: sum.carb + record.carb, sodium: sum.sodium + record.sodium }), { calorie: 0, protein: 0, fat: 0, carb: 0, sodium: 0 });
  const target = snapshot.settings;
  const mealOptions = ['早餐', '午餐', '晚餐', '加餐'];
  const recent = [...snapshot.diets].sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  if (!editing) return `<section class="editor-section"><div class="section-heading"><div><p class="eyebrow">DIET · 饮食</p><h2>每日饮食记录</h2></div></div><article class="card editor-card locked-editor"><div><p class="muted">${readerMode ? '这是只读发布页面，饮食和营养数据不能修改。' : '当前为只读模式。进入本人编辑模式后可以维护食物和营养数据。'}</p></div>${readerMode ? '' : '<button class="primary-button" data-action="auth-toggle" type="button">进入编辑模式</button>'}</article><article class="card diet-summary-card">${renderDietSummary(totals, target, selectedDate)}</article></section>`;
  return `<section class="editor-section"><div class="section-heading"><div><p class="eyebrow">DIET · 饮食</p><h2>每日饮食记录</h2></div><span class="saved-note">${form.targetId ? '正在编辑饮食记录' : `查看 ${selectedDate} 饮食`}</span></div><article class="card editor-card"><div class="card-heading"><div><p class="eyebrow">${form.targetId ? 'EDIT · 编辑' : 'ADD · 添加'}</p><h2>${form.targetId ? '编辑饮食记录' : '添加饮食记录'}</h2></div>${form.targetId ? '<button class="text-button" data-action="reset-diet-form" type="button">取消编辑</button>' : ''}</div><form id="dietForm" class="diet-form"><label>日期<input name="date" type="date" required value="${escapeHtml(form.date)}"></label><label>餐次<select name="meal">${mealOptions.map((meal) => `<option value="${meal}" ${meal === form.meal ? 'selected' : ''}>${meal}</option>`).join('')}</select></label><div class="prompt-actions wide-field"><button class="text-button" data-action="copy-diet-prompt" type="button">复制提示词</button><button class="prompt-help" data-action="show-diet-prompt" type="button" aria-label="查看提示词">!</button><span class="muted">复制后发给 AI，再把 JSON 结果粘贴到下方</span></div><label class="wide-field">粘贴 AI 返回的 JSON<textarea name="aiText" rows="8" placeholder="粘贴 AI 返回的 JSON">${escapeHtml(form.aiText)}</textarea></label><div class="legacy-diet-fields"><input name="food" value="${escapeHtml(form.food)}"><input name="calorie" value="${escapeHtml(form.calorie)}"><input name="protein" value="${escapeHtml(form.protein)}"><input name="fat" value="${escapeHtml(form.fat)}"><input name="carb" value="${escapeHtml(form.carb)}"><input name="sodium" value="${escapeHtml(form.sodium)}"><input name="note" value="${escapeHtml(form.note)}"></div><div class="form-actions wide-field"><button class="primary-button" type="submit">${form.targetId ? '保存修改' : '解析并保存'}</button>${form.error ? `<span class="form-error" role="alert">${escapeHtml(form.error)}</span>` : ''}</div></form></article><article class="card diet-summary-card">${renderDietSummary(totals, target, selectedDate)}</article><article class="card history-card"><div class="card-heading"><div><p class="eyebrow">RECENT · 最近饮食</p><h2>饮食明细</h2></div><span class="chart-meta">${snapshot.diets.length} 条</span></div>${recent.length ? recent.map((record) => `<div class="history-row diet-history-row"><div><b>${record.date} · ${escapeHtml(record.meal)} · ${escapeHtml(record.food)}</b><span>${formatNumber(record.calorie, 0)} kcal · P${formatNumber(record.protein, 0)} F${formatNumber(record.fat, 0)} C${formatNumber(record.carb, 0)} · Na${formatNumber(record.sodium, 0)}mg${record.note ? ` · ${escapeHtml(record.note)}` : ''}</span></div><div class="row-actions"><button class="text-button" data-action="edit-diet" data-id="${escapeHtml(record.id)}" type="button">编辑</button><button class="text-button danger-text" data-action="delete-diet" data-id="${escapeHtml(record.id)}" type="button">删除</button></div></div>`).join('') : '<p class="muted">还没有饮食记录。</p>'}</article></section>`;
}

function renderDietSummary(totals: { calorie: number; protein: number; fat: number; carb: number; sodium: number }, target: HealthSnapshot['settings'], date: string): string {
  return `<div class="card-heading"><div><p class="eyebrow">DIET · 汇总</p><h2>${escapeHtml(date)} 营养目标进度</h2></div><span class="chart-meta">${formatNumber(totals.calorie, 0)} / ${formatInteger(target.calorieTarget)} kcal</span></div><div class="diet-macro-grid"><div><span>热量</span><b>${formatNumber(totals.calorie, 0)} / ${formatInteger(target.calorieTarget)}</b><i><em style="width:${progressWidth(totals.calorie, target.calorieTarget)}%"></em></i></div><div><span>蛋白质</span><b>${formatNumber(totals.protein, 0)} / ${formatInteger(target.proteinTarget)} g</b><i><em style="width:${progressWidth(totals.protein, target.proteinTarget)}%"></em></i></div><div><span>脂肪</span><b>${formatNumber(totals.fat, 0)} / ${formatInteger(target.fatTarget)} g</b><i><em style="width:${progressWidth(totals.fat, target.fatTarget)}%"></em></i></div><div><span>碳水</span><b>${formatNumber(totals.carb, 0)} / ${formatInteger(target.carbTarget)} g</b><i><em style="width:${progressWidth(totals.carb, target.carbTarget)}%"></em></i></div><div><span>钠</span><b>${formatNumber(totals.sodium, 0)} / ${formatInteger(target.sodiumTarget)} mg</b><i><em style="width:${progressWidth(totals.sodium, target.sodiumTarget)}%"></em></i></div></div>`;
}

function progressWidth(value: number, target: number): number {
  return target > 0 ? Math.min(100, Math.max(0, (value / target) * 100)) : 0;
}

function checkinButton(snapshot: HealthSnapshot, date: string, type: 'train' | 'habit', item: string): string {
  const done = snapshot.checkins.some((record) => record.date === date && record.type === type && record.item === item && record.done);
  return `<button class="checkin-button ${done ? 'done' : ''}" data-action="toggle-checkin" data-date="${escapeHtml(date)}" data-type="${type}" data-item="${escapeHtml(item)}" type="button"><span>${done ? '✓' : '·'}</span>${escapeHtml(item)}</button>`;
}

function renderAuthModal(error: string): string {
  return `<div class="auth-modal" role="dialog" aria-modal="true"><form class="auth-dialog" id="authForm"><div class="card-heading"><div><p class="eyebrow">OWNER ACCESS · 本人验证</p><h2>进入编辑模式</h2></div><button class="text-button" data-action="close-auth" type="button">关闭</button></div><p class="muted">验证只在当前浏览器会话内生效，用于防止分享或共用设备时误修改数据。</p><label>账号<input name="username" type="text" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label>${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}<button class="primary-button" type="submit">验证并进入</button></form></div>`;
}

function renderTodayList(snapshot: HealthSnapshot, today: string): string {
  const weight = snapshot.weights.some((record) => record.date === today);
  const steps = snapshot.steps.find((record) => record.date === today);
  const dayOfWeek = new Date(`${today}T12:00:00`).getDay();
  const trainingItems = snapshot.settings.trainingPlan[String(dayOfWeek)] ?? [];
  const habitItems = snapshot.settings.habits;
  const trainingDone = trainingItems.filter((item) => snapshot.checkins.some((record) => record.date === today && record.type === 'train' && record.item === item && record.done)).length;
  const habitDone = habitItems.filter((item) => snapshot.checkins.some((record) => record.date === today && record.type === 'habit' && record.item === item && record.done)).length;
  const trainingComplete = trainingItems.length > 0 && trainingDone === trainingItems.length;
  const habitsComplete = habitItems.length > 0 && habitDone === habitItems.length;
  return `<ul class="today-list"><li><span class="check ${weight ? 'done' : ''}">${weight ? '✓' : '·'}</span><span>今日体重</span><b>${weight ? '已记录' : '待记录'}</b></li><li><span class="check ${steps && steps.steps >= 8000 ? 'done' : ''}">${steps && steps.steps >= 8000 ? '✓' : '·'}</span><span>步数目标</span><b>${steps ? formatInteger(steps.steps) : '待记录'}</b></li><li><span class="check ${trainingComplete ? 'done' : ''}">${trainingComplete ? '✓' : '·'}</span><span>今日训练</span><b>${trainingItems.length ? `${trainingDone}/${trainingItems.length}` : '无计划'}</b></li><li><span class="check ${habitsComplete ? 'done' : ''}">${habitsComplete ? '✓' : '·'}</span><span>今日习惯</span><b>${habitItems.length ? `${habitDone}/${habitItems.length}` : '无计划'}</b></li></ul>`;
}

function renderWeightChart(records: WeightRecord[]): string {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
  if (sorted.length < 2) return `<div class="empty-chart"><span>⌁</span><p>记录至少 2 条体重数据后，这里会出现趋势曲线。</p></div>`;
  const values = sorted.map((record) => record.weightKg);
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const width = 680;
  const height = 210;
  const points = sorted.map((record, index) => {
    const x = 26 + (index * (width - 52)) / (sorted.length - 1);
    const y = height - 26 - ((record.weightKg - min) / (max - min)) * (height - 52);
    return { x, y, record };
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const circles = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="4" /><text x="${point.x}" y="${point.y - 12}" text-anchor="middle">${formatNumber(point.record.weightKg)}</text>`).join('');
  const labels = points.map((point) => `<text class="axis-label" x="${point.x}" y="200" text-anchor="middle">${point.record.date.slice(5)}</text>`).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体重趋势折线图"><line class="grid-line" x1="26" y1="42" x2="654" y2="42" /><line class="grid-line" x1="26" y1="104" x2="654" y2="104" /><line class="grid-line" x1="26" y1="166" x2="654" y2="166" /><path class="trend-line" d="${path}" /><g class="trend-points">${circles}</g><g>${labels}</g></svg></div>`;
}

function renderMeasurementChart(records: HealthSnapshot['measurements']): string {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date)).slice(-12);
  if (sorted.length < 2) return `<div class="empty-chart"><span>⌁</span><p>记录至少 2 条围度数据后，这里会出现趋势曲线。</p></div>`;
  const values = sorted.flatMap((record) => [record.waistCm, record.hipCm]);
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const width = 680;
  const height = 210;
  const pointsFor = (key: 'waistCm' | 'hipCm') => sorted.map((record, index) => ({ x: 26 + (index * (width - 52)) / (sorted.length - 1), y: height - 26 - ((record[key] - min) / (max - min)) * (height - 52) }));
  const waist = pointsFor('waistCm');
  const hip = pointsFor('hipCm');
  const path = (points: Array<{ x: number; y: number }>) => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const labels = sorted.map((record, index) => `<text class="axis-label" x="${waist[index].x}" y="200" text-anchor="middle">${record.date.slice(5)}</text>`).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="腰围与臀围趋势折线图"><line class="grid-line" x1="26" y1="42" x2="654" y2="42" /><line class="grid-line" x1="26" y1="104" x2="654" y2="104" /><line class="grid-line" x1="26" y1="166" x2="654" y2="166" /><path class="trend-line measure-waist" d="${path(waist)}" /><path class="trend-line measure-hip" d="${path(hip)}" /><g>${labels}</g></svg></div><div class="legend"><span><i class="on"></i>腰围（cm）</span><span><i class="on amber"></i>臀围（cm）</span></div>`;
}

function renderStepChart(records: HealthSnapshot['steps']): string {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  if (sorted.length < 2) return `<div class="empty-chart"><span>⌁</span><p>记录至少 2 天步数后，这里会出现趋势曲线。</p></div>`;
  const width = 680;
  const height = 210;
  const max = Math.max(8000, ...sorted.map((record) => record.steps)) * 1.1;
  const points = sorted.map((record, index) => ({ x: 26 + (index * (width - 52)) / (sorted.length - 1), y: height - 26 - (record.steps / max) * (height - 52), record }));
  const average = sorted.map((_, index) => sorted.slice(Math.max(0, index - 6), index + 1).reduce((total, record) => total + record.steps, 0) / Math.min(7, index + 1));
  const averagePoints = average.map((value, index) => ({ x: points[index].x, y: height - 26 - (value / max) * (height - 52) }));
  const path = (items: Array<{ x: number; y: number }>) => items.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const labels = points.map((point) => `<text class="axis-label" x="${point.x}" y="200" text-anchor="middle">${point.record.date.slice(5)}</text>`).join('');
  const targetY = height - 26 - (8000 / max) * (height - 52);
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="步数趋势折线图"><line class="target-line" x1="26" y1="${targetY}" x2="654" y2="${targetY}" /><path class="trend-line step-line" d="${path(points)}" /><path class="trend-line step-average" d="${path(averagePoints)}" /><g>${labels}</g></svg></div><div class="legend"><span><i class="on blue"></i>步数</span><span><i class="on"></i>7 日平均</span><span><i class="target-dot"></i>目标 8000 步</span></div>`;
}

function renderCalendar(snapshot: HealthSnapshot, today: string, selectedDate: string): string {
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${today}T12:00:00`);
    date.setDate(date.getDate() - (6 - index));
    return localDate(date);
  });
  return `<div class="calendar-strip">${dates.map((date) => {
    const weight = snapshot.weights.some((record) => record.date === date);
    const steps = snapshot.steps.find((record) => record.date === date);
    const diet = snapshot.diets.some((record) => record.date === date);
    const checkin = snapshot.checkins.some((record) => record.date === date && record.done);
    const day = new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' }).replace('周', '');
    return `<button class="calendar-day ${date === today ? 'today' : ''} ${date === selectedDate ? 'selected' : ''}" data-action="calendar-day" data-date="${date}" type="button"><span>${day}</span><b>${date.slice(8)}</b><div class="dots"><i class="${weight ? 'on' : ''}" title="体重"></i><i class="${steps ? 'on blue' : ''}" title="步数"></i><i class="${diet ? 'on amber' : ''}" title="饮食"></i><i class="${checkin ? 'on green' : ''}" title="打卡"></i></div></button>`;
  }).join('')}</div><div class="legend"><span><i class="on"></i>体重</span><span><i class="on blue"></i>步数</span><span><i class="on amber"></i>饮食</span><span><i class="on green"></i>打卡</span></div>`;
}

function renderCalendarDetail(snapshot: HealthSnapshot, date: string, editing: boolean): string {
  const safeDate = escapeHtml(date);
  const weight = snapshot.weights.find((record) => record.date === date);
  const step = snapshot.steps.find((record) => record.date === date);
  const dietCount = snapshot.diets.filter((record) => record.date === date).length;
  const dietItems = snapshot.diets.filter((record) => record.date === date);
  const dietTotals = dietItems.reduce((sum, record) => ({ calorie: sum.calorie + record.calorie, protein: sum.protein + record.protein, fat: sum.fat + record.fat, carb: sum.carb + record.carb, sodium: sum.sodium + record.sodium }), { calorie: 0, protein: 0, fat: 0, carb: 0, sodium: 0 });
  const dayOfWeek = new Date(`${date}T12:00:00`).getDay();
  const trains = snapshot.settings.trainingPlan[String(dayOfWeek)] ?? [];
  const habits = snapshot.settings.habits;
  const checkins = [...trains.map((item) => ({ type: 'train' as const, item })), ...habits.map((item) => ({ type: 'habit' as const, item }))];
  return `<div class="calendar-detail"><div class="calendar-detail-head"><strong>${safeDate}</strong><span>${weight ? `体重 ${formatNumber(weight.weightKg)} kg` : '未记录体重'} · ${step ? `${formatInteger(step.steps)} 步` : '未记录步数'} · ${dietCount} 条饮食</span></div><div class="calendar-checkins">${checkins.length ? checkins.map(({ type, item }) => { const done = snapshot.checkins.some((record) => record.date === date && record.type === type && record.item === item && record.done); return editing ? `<button class="checkin-button ${done ? 'done' : ''}" data-action="toggle-checkin" data-date="${safeDate}" data-type="${type}" data-item="${escapeHtml(item)}" type="button"><span>${done ? '✓' : '·'}</span>${escapeHtml(item)}</button>` : `<span class="checkin-readonly ${done ? 'done' : ''}">${done ? '✓' : '·'} ${escapeHtml(item)}</span>`; }).join('') : '<span class="muted">当天没有预设训练或习惯。</span>'}</div>${dietItems.length ? `<div class="calendar-diet-list"><strong>饮食明细</strong>${dietItems.map((record) => `<span>${escapeHtml(record.meal)} · ${escapeHtml(record.food)} · ${formatNumber(record.calorie, 0)} kcal</span>`).join('')}</div><div class="calendar-diet-summary">${renderDietSummary(dietTotals, snapshot.settings, date)}</div>` : ''}</div>`;
}

function renderStorageError(message: string): string {
  return `<main class="fatal-state"><div class="fatal-icon">!</div><p class="eyebrow">LOCAL STORAGE · 本地存储</p><h1>本地数据暂时不可用</h1><p>${escapeHtml(message)}</p><p class="muted">页面没有把异常状态当成空数据。修复浏览器存储后可以重试。</p><button class="primary-button" data-action="reload">重新读取</button></main>`;
}

function renderLoading(): string {
  return '<main class="fatal-state"><div class="loading-mark" aria-hidden="true"></div><p class="eyebrow">LOCAL STORAGE · 本地存储</p><h1>正在打开轻盈计划</h1><p class="muted">正在读取当前浏览器中的健康数据…</p></main>';
}

function bindReload(container: HTMLElement, load: () => Promise<void>): void {
  container.querySelectorAll<HTMLElement>('[data-action="reload"]').forEach((button) => button.addEventListener('click', () => { void load(); }));
}

function metricCard(label: string, value: string, note: string, tone: string): string {
  return `<article class="metric-card ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}

function sum(records: DietRecord[], key: keyof Pick<DietRecord, 'calorie' | 'protein' | 'fat' | 'carb' | 'sodium'>): number {
  return records.reduce((total, record) => total + record[key], 0);
}

function progressPercent(current: number, start: number, target: number): number {
  if (start === target) return 100;
  return ((start - current) / (start - target)) * 100;
}

function bmiLabel(bmi: number): string {
  if (bmi < 18.5) return '偏低';
  if (bmi < 24) return '正常范围';
  if (bmi < 28) return '偏高';
  return '需要关注';
}

function formatNumber(value: number, digits = 1): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatPublicationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);
}

function renderTransferPreview(preview: TransferPreview): string {
  const messages = [...preview.errors, ...preview.details];
  return `<div class="transfer-preview"><div><b>导入预览</b><span>接受 ${preview.accepted} 条 · 重复 ${preview.duplicates} 条 · 冲突 ${preview.conflicts} 条</span></div>${messages.length ? `<ul class="transfer-errors">${messages.slice(0, 8).map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : '<p class="muted">校验通过。冲突记录默认保留当前数据。</p>'}<div class="transfer-preview-actions"><button class="text-button" data-action="cancel-transfer" type="button">取消</button><button class="primary-button" data-action="commit-transfer" type="button" ${preview.valid && preview.snapshot ? '' : 'disabled'}>确认导入</button></div></div>`;
}

function downloadText(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}
