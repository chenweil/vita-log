import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // 显式绑定 IPv4，否则 Node 会把 localhost 解析成 IPv6，只监听 [::1]:5173，
  // 导致 127.0.0.1:5173 无法访问
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
