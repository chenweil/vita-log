import { defineConfig, type Plugin } from 'vite';

// 部署到子路径的静态托管（GitHub Pages 项目页等）时，设置
// VITE_BASE=/仓库名/ ；根路径托管（Cloudflare Pages / Vercel / Netlify）留空。
const base = process.env.VITE_BASE ?? './';

/**
 * 声明这份产物的在线事实来源，方式与自托管 Node 服务一致：
 * `<meta name="vita-log-storage" content="…">`。
 *
 * 自托管服务在响应 index.html 时注入 `sqlite`；Cloudflare Pages 没有这一步，
 * 所以标记必须随构建产物一起发布，否则页面会退回 localStorage —— 那正是
 * ADR-0002 要求 fail-closed 的那种静默降级：访客会看到一台空看板，而不是
 * 「服务不可用」。
 *
 * 未设置时不注入任何标记，纯静态构建因此保持只读查看与导出（见 06.1-04）。
 */
const storageMode = (): Plugin | undefined => {
  const mode = process.env.VITE_STORAGE_MODE;
  if (mode !== 'd1') return undefined;
  return {
    name: 'vita-log-storage-mode',
    transformIndexHtml: (html) => html.replace('</head>', '<meta name="vita-log-storage" content="d1"></head>'),
  };
};

export default defineConfig({
  base,
  plugins: [storageMode()],
  // 显式绑定 IPv4，否则 Node 会把 localhost 解析成 IPv6，只监听 [::1]:5173，
  // 导致 127.0.0.1:5173 无法访问
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
