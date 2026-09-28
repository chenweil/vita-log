import './styles.css';
import { mountApp } from './app';
import { LocalStorageHealthRepository, type StorageLike } from './storage';

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

try {
  mountApp(container, new LocalStorageHealthRepository(browserStorage()));
} catch (error) {
  const message = error instanceof Error ? error.message : '应用无法启动';
  container.innerHTML = `<main class="fatal-state"><div class="fatal-icon">!</div><h1>无法打开轻盈计划</h1><p>${escapeHtml(message)}</p><p class="muted">请使用支持本地存储的浏览器，或关闭隐私模式后重试。</p></main>`;
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
