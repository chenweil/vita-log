/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';

describe('application entry document', () => {
  it('shows launch instructions without requesting modules when opened from a file URL', async () => {
    document.body.innerHTML = indexHtml;
    const script = document.querySelector<HTMLScriptElement>('script[type="module"]');
    expect(script).not.toBeNull();
    expect(script?.src).toBe('');

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runEntry = new AsyncFunction('window', 'document', script?.textContent ?? '');
    await runEntry({ location: { protocol: 'file:' } }, document);

    expect(document.querySelector('#app')?.textContent).toContain('这个页面需要通过本地服务打开');
    expect(document.querySelector('#app')?.textContent).toContain('npm run dev');
    expect(document.querySelectorAll('script[src]')).toHaveLength(0);
  });
});
