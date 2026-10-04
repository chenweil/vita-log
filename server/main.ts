import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { SqliteStore } from './store';
import { createApi } from './api';

const store = new SqliteStore({ database: resolve(process.env.VITA_DATABASE ?? 'data/vita-log.sqlite'), backups: resolve(process.env.VITA_BACKUPS ?? 'backups') });
const api = createApi(store);
const dist = resolve('dist');
const port = Number(process.env.VITA_PORT ?? 4318);
const server = createServer(async (req, res) => {
  try {
    const expectedHost = `127.0.0.1:${port}`;
    if (req.headers.host !== expectedHost) { res.writeHead(403); res.end('只允许本机访问'); return; }
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 5 * 1024 * 1024) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'validation-failed', message: '请求超过 5 MiB 上限' })); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = await api(new Request(url, { method: req.method, headers, ...(length ? { body: Buffer.concat(chunks) } : {}) }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders); res.end(await response.text()); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(`${dist}${sep}`)) { res.writeHead(403); res.end(); return; }
    let content = await readFile(path);
    if (path.endsWith('index.html')) content = Buffer.from(content.toString().replace('</head>', '<meta name="vita-log-storage" content="sqlite"></head>'));
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end('页面资源不可用，请先运行 npm run build'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Vita Log SQLite: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
