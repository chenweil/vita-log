import { defineConfig } from 'vite';

// 部署到子路径的静态托管（GitHub Pages 项目页等）时，设置
// VITE_BASE=/仓库名/ ；根路径托管（Cloudflare Pages / Vercel / Netlify）留空。
const base = process.env.VITE_BASE ?? './';

export default defineConfig({
  base,
  // 显式绑定 IPv4，否则 Node 会把 localhost 解析成 IPv6，只监听 [::1]:5173，
  // 导致 127.0.0.1:5173 无法访问
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
