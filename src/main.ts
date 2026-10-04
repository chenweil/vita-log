import './styles.css';
import { mountApp } from './app';
import { ReadOnlyEditorAuth } from './auth';
import { parsePublication, PublishedHealthRepository } from './publication';
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

if (publicationPath) {
  void loadPublication(publicationPath);
} else if (document.querySelector('meta[name="vita-log-storage"][content="sqlite"]')) {
  mountApp(appContainer, new SqliteHealthRepository(), new ServerEditorAuth());
} else {
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
