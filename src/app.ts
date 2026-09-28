import {
  calculateBmi,
  calculateWhr,
  latestByDate,
  type DietRecord,
  type HealthSnapshot,
  type WeightRecord,
} from './domain';
import { StorageError, type HealthDataRepository, type LoadStatus } from './storage';

type StorageViewState = LoadStatus | 'saving' | 'saved' | 'error';

export function mountApp(container: HTMLElement, repository: HealthDataRepository): void {
  let snapshot: HealthSnapshot | null = null;
  let storageState: StorageViewState = 'saving';
  let storageMessage = '正在读取本地数据…';

  const render = (): void => {
    if (!snapshot) {
      container.innerHTML = storageState === 'saving' ? renderLoading() : renderStorageError(storageMessage);
      bindReload(container, load);
      return;
    }
    container.innerHTML = renderDashboard(snapshot, storageState, storageMessage);
    bindReload(container, load);
  };

  const load = async (): Promise<void> => {
    storageState = 'saving';
    storageMessage = '正在读取本地数据…';
    render();
    try {
      const result = await repository.load();
      snapshot = result.snapshot;
      if (result.status === 'new') {
        await repository.commit(snapshot);
        storageState = 'saved';
        storageMessage = '已建立本地数据快照';
      } else {
        storageState = 'loaded';
        storageMessage = '已从本地快照加载';
      }
    } catch (error) {
      snapshot = null;
      storageState = 'error';
      storageMessage = error instanceof StorageError ? error.message : '本地数据读取失败';
    }
    render();
  };

  void load();
}

function renderDashboard(snapshot: HealthSnapshot, state: StorageViewState, message: string): string {
  const latestWeight = latestByDate(snapshot.weights);
  const latestMeasurement = latestByDate(snapshot.measurements);
  const bmi = latestWeight ? calculateBmi(latestWeight.weightKg, snapshot.settings.heightCm) : null;
  const whr = latestMeasurement ? calculateWhr(latestMeasurement.waistCm, latestMeasurement.hipCm) : null;
  const today = localDate(new Date());
  const todaySteps = snapshot.steps.find((record) => record.date === today);
  const todayDiet = snapshot.diets.filter((record) => record.date === today);
  const goalProgress = latestWeight ? progressPercent(latestWeight.weightKg, snapshot.settings.startWeightKg, snapshot.settings.targetWeightKg) : 0;
  const greeting = snapshot.settings.name ? `${snapshot.settings.name}，今天也稳稳向前。` : '今天也稳稳向前。';

  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><div class="brand-mark">轻</div><div><strong>轻盈计划</strong><span>个人健康记录</span></div></div>
        <div class="top-actions"><span class="read-only-pill"><span class="status-dot"></span>只读 · 本地</span><button class="icon-button" data-action="reload" aria-label="刷新本地数据" title="刷新本地数据">↻</button></div>
      </header>
      <main class="page">
        <section class="hero-card">
          <div><p class="eyebrow">DAILY CHECK-IN · ${escapeHtml(today)}</p><h1>${escapeHtml(greeting)}</h1><p class="hero-copy">把今天的记录留给自己，趋势会替你记住坚持。</p></div>
          <div class="hero-ring" aria-label="目标进度 ${Math.round(goalProgress)}%"><span>${Math.round(goalProgress)}<small>%</small></span><em>目标进度</em></div>
        </section>

        <section class="section-block"><div class="section-heading"><div><p class="eyebrow">OVERVIEW · 概览</p><h2>今天的身体状态</h2></div><span class="saved-note ${state === 'error' ? 'error' : ''}">${escapeHtml(message)}</span></div>
          <div class="metric-grid">
            ${metricCard('当前体重', latestWeight ? `${formatNumber(latestWeight.weightKg)} <small>kg</small>` : '--', latestWeight ? latestWeight.date : '还没有记录', 'primary')}
            ${metricCard('BMI', bmi ? formatNumber(bmi, 1) : '--', bmi ? bmiLabel(bmi) : '记录体重后显示', 'accent')}
            ${metricCard('今日步数', todaySteps ? formatInteger(todaySteps.steps) : '--', todaySteps ? `${todaySteps.steps >= 8000 ? '已达标' : '目标 8000 步'}` : '还没有记录', 'blue')}
            ${metricCard('今日饮食', todayDiet.length ? `${formatInteger(sum(todayDiet, 'calorie'))} <small>kcal</small>` : '--', todayDiet.length ? `${todayDiet.length} 条记录` : '还没有记录', 'amber')}
          </div>
        </section>

        <section class="two-column">
          <article class="card goal-card"><div class="card-heading"><div><p class="eyebrow">GOAL · 目标</p><h2>减脂进度</h2></div><span class="goal-number">${formatNumber(snapshot.settings.targetWeightKg)} <small>kg</small></span></div><div class="progress-track"><span style="width:${Math.min(100, Math.max(0, goalProgress))}%"></span></div><div class="goal-row"><span>起始体重 <b>${formatNumber(snapshot.settings.startWeightKg)} kg</b></span><span>目标体重 <b>${formatNumber(snapshot.settings.targetWeightKg)} kg</b></span></div><div class="detail-list"><div><span>最近围度</span><b>${latestMeasurement ? `${formatNumber(latestMeasurement.waistCm)} / ${formatNumber(latestMeasurement.hipCm)} cm` : '--'}</b></div><div><span>腰臀比 WHR</span><b>${whr ? formatNumber(whr, 2) : '--'}</b></div><div><span>目标体脂</span><b>${formatNumber(snapshot.settings.targetBodyfatPercent, 1)}%</b></div></div></article>
          <article class="card today-card"><div class="card-heading"><div><p class="eyebrow">TODAY · 今日</p><h2>记录状态</h2></div><span class="status-label">只读预览</span></div>${renderTodayList(snapshot, today)}</article>
        </section>

        <section class="card chart-card"><div class="card-heading"><div><p class="eyebrow">TREND · 趋势</p><h2>体重趋势</h2></div><span class="chart-meta">${snapshot.weights.length ? `共 ${snapshot.weights.length} 条` : '等待第一条记录'}</span></div>${renderWeightChart(snapshot.weights)}</section>

        <section class="card calendar-card"><div class="card-heading"><div><p class="eyebrow">CALENDAR · 日历</p><h2>最近 7 天</h2></div><span class="chart-meta">体重 · 步数 · 饮食</span></div>${renderCalendar(snapshot, today)}</section>

        <section class="two-column lower-grid"><article class="card"><div class="card-heading"><div><p class="eyebrow">PROFILE · 设置</p><h2>当前计划</h2></div></div><div class="profile-grid"><div><span>身高</span><b>${formatNumber(snapshot.settings.heightCm)} cm</b></div><div><span>年龄</span><b>${snapshot.settings.age} 岁</b></div><div><span>热量目标</span><b>${formatInteger(snapshot.settings.calorieTarget)} kcal</b></div><div><span>蛋白质目标</span><b>${formatInteger(snapshot.settings.proteinTarget)} g</b></div></div><p class="muted">编辑功能将在本人模式中提供。</p></article><article class="card backup-card"><div class="card-heading"><div><p class="eyebrow">STORAGE · 存储</p><h2>本地数据</h2></div><span class="status-check">✓</span></div><p>当前页面使用浏览器本地快照。第一版不会向腾讯云文档或 Workbuddy 发起请求。</p><div class="data-count">${snapshot.weights.length + snapshot.measurements.length + snapshot.steps.length + snapshot.checkins.length + snapshot.diets.length}<small> 条记录</small></div><p class="muted">请定期导出完整备份，避免浏览器数据成为唯一副本。</p></article></section>
      </main>
      <footer class="footer">轻盈计划 · 独立静态版 <span>数据只保存在当前浏览器</span></footer>
    </div>`;
}

function renderTodayList(snapshot: HealthSnapshot, today: string): string {
  const weight = snapshot.weights.some((record) => record.date === today);
  const steps = snapshot.steps.find((record) => record.date === today);
  const training = snapshot.checkins.filter((record) => record.date === today && record.type === 'train');
  const habits = snapshot.checkins.filter((record) => record.date === today && record.type === 'habit');
  return `<ul class="today-list"><li><span class="check ${weight ? 'done' : ''}">${weight ? '✓' : '·'}</span><span>今日体重</span><b>${weight ? '已记录' : '待记录'}</b></li><li><span class="check ${steps && steps.steps >= 8000 ? 'done' : ''}">${steps && steps.steps >= 8000 ? '✓' : '·'}</span><span>步数目标</span><b>${steps ? formatInteger(steps.steps) : '待记录'}</b></li><li><span class="check ${training.some((record) => record.done) ? 'done' : ''}">${training.some((record) => record.done) ? '✓' : '·'}</span><span>今日训练</span><b>${training.some((record) => record.done) ? '已完成' : '待完成'}</b></li><li><span class="check ${habits.length > 0 && habits.every((record) => record.done) ? 'done' : ''}">${habits.length > 0 && habits.every((record) => record.done) ? '✓' : '·'}</span><span>今日习惯</span><b>${habits.length ? `${habits.filter((record) => record.done).length}/${habits.length}` : '待记录'}</b></li></ul>`;
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

function renderCalendar(snapshot: HealthSnapshot, today: string): string {
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
    return `<div class="calendar-day ${date === today ? 'today' : ''}"><span>${day}</span><b>${date.slice(8)}</b><div class="dots"><i class="${weight ? 'on' : ''}" title="体重"></i><i class="${steps ? 'on blue' : ''}" title="步数"></i><i class="${diet ? 'on amber' : ''}" title="饮食"></i><i class="${checkin ? 'on green' : ''}" title="打卡"></i></div></div>`;
  }).join('')}</div><div class="legend"><span><i class="on"></i>体重</span><span><i class="on blue"></i>步数</span><span><i class="on amber"></i>饮食</span><span><i class="on green"></i>打卡</span></div>`;
}

function renderStorageError(message: string): string {
  return `<main class="fatal-state"><div class="fatal-icon">!</div><p class="eyebrow">LOCAL STORAGE · 本地存储</p><h1>本地数据暂时不可用</h1><p>${escapeHtml(message)}</p><p class="muted">页面没有把异常状态当成空数据。修复浏览器存储后可以重试。</p><button class="primary-button" data-action="reload">重新读取</button></main>`;
}

function renderLoading(): string {
  return '<main class="fatal-state"><div class="loading-mark" aria-hidden="true"></div><p class="eyebrow">LOCAL STORAGE · 本地存储</p><h1>正在打开轻盈计划</h1><p class="muted">正在读取当前浏览器中的健康数据…</p></main>';
}

function bindReload(container: HTMLElement, load: () => Promise<void>): void {
  container.querySelectorAll<HTMLElement>('[data-action="reload"]').forEach((button) => {
    button.addEventListener('click', () => { void load(); });
  });
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);
}
