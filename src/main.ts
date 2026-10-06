import './styles.css';
import { mountApp } from './app';
import { ReadOnlyEditorAuth } from './auth';
import { parsePublication, PublishedHealthRepository } from './publication';
import { D1HealthRepository } from './d1-storage';
import { LocalStorageHealthRepository, type StorageLike } from './storage';
import { SqliteHealthRepository } from './sqlite-storage';
import { ServerEditorAuth } from './server-auth';

function browserStorage(): StorageLike {
  try {
    return window.localStorage;
  } catch {
    throw new Error('当前浏览器不允许使用本地存储');
  }
}

const container = document.querySelector<HTMLDivElement>('#app');

if (!container) {
  throw new Error('应用挂载点不存在');
}
const appContainer = container;

const publicationPath = new URLSearchParams(window.location.search).get('publication');
const storageMode = document.querySelector('meta[name="vita-log-storage"]')?.getAttribute('content');

if (publicationPath) {
  void loadPublication(publicationPath);
} else if (storageMode === 'd1') {
  // Cloudflare：在线事实来源是 D1，访客匿名读取，保存走服务端会话授权。
  // 故障时报错而不是回退本机存储 —— 见 ADR-0002 的 fail-closed 决定。
  mountApp(appContainer, new D1HealthRepository(), new ServerEditorAuth(), { source: 'server' });
} else if (storageMode === 'sqlite') {
  mountApp(appContainer, new SqliteHealthRepository(), new ServerEditorAuth(), { source: 'server' });
} else {
  // 纯静态构建：只读查看与导出。刻意只传两个参数 —— 默认 auth 是
  // ReadOnlyEditorAuth，所以这一支没有、也不该有编辑入口或认证实现。
  try {
    mountApp(container, new LocalStorageHealthRepository(browserStorage()));
  } catch (error) {
    renderStartupError(error, '请使用支持本地存储的浏览器，或关闭隐私模式后重试。');
  }
}

async function loadPublication(path: string): Promise<void> {
  try {
    const response = await fetch(new URL(path, window.location.href).href, { credentials: 'omit' });
    if (!response.ok) throw new Error(`发布文件加载失败（${response.status}）`);
    const publication = parsePublication(await response.text());
    mountApp(appContainer, new PublishedHealthRepository(publication), new ReadOnlyEditorAuth(), { mode: 'reader', publishedAt: publication.publishedAt });
  } catch (error) {
    renderStartupError(error, '请检查分享链接中的 publication 文件是否已部署且可读取。');
  }
}

function renderStartupError(error: unknown, hint: string): void {
  const message = error instanceof Error ? error.message : '应用无法启动';
  appContainer.innerHTML = `<main class="fatal-state"><div class="fatal-icon">!</div><h1>无法打开轻盈计划</h1><p>${escapeHtml(message)}</p><p class="muted">${escapeHtml(hint)}</p></main>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] ?? character);
}
