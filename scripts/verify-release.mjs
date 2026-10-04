import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

const distDirectory = resolve(process.argv[2] ?? 'dist');

function fail(message) {
  throw new Error(`发布检查失败：${message}`);
}

async function requireFile(path, label) {
  try {
    const info = await stat(path);
    if (!info.isFile()) fail(`${label}不是文件`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('发布检查失败：')) throw error;
    fail(`缺少${label}`);
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}

async function serve(directory) {
  const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const candidate = resolve(directory, relativePath);
    if (candidate !== directory && !candidate.startsWith(`${directory}${sep}`)) {
      response.writeHead(400);
      response.end('bad path');
      return;
    }
    try {
      const body = await readFile(candidate);
      const extension = extname(candidate);
      const contentType = extension === '.html' ? 'text/html; charset=utf-8'
        : extension === '.js' ? 'text/javascript; charset=utf-8'
          : extension === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  try {
    await new Promise((resolveServer, rejectServer) => {
      server.once('error', rejectServer);
      server.listen(0, '127.0.0.1', resolveServer);
    });
  } catch (error) {
    server.close();
    fail(`无法启动临时静态服务器：${error instanceof Error ? error.message : error}`);
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    fail('无法取得本地静态服务器地址');
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function main() {
  const indexPath = join(distDirectory, 'index.html');
  await requireFile(indexPath, 'dist/index.html');
  const index = await readFile(indexPath, 'utf8');
  if (index.includes('/src/main.ts')) fail('生产入口仍指向 TypeScript 源文件');

  const references = [...index.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('./'));
  if (references.length === 0) fail('index.html 没有引用构建后的静态资源');
  for (const reference of references) await requireFile(resolve(distDirectory, reference), reference);

  const files = await collectFiles(distDirectory);
  const runtimeFiles = files.filter((path) => ['.js', '.css', '.html'].includes(extname(path)));
  const runtime = (await Promise.all(runtimeFiles.map((path) => readFile(path, 'utf8')))).join('\n');
  const forbiddenRuntimeGlobals = ['window.__SMART_PAGE__', 'globalThis.__SMART_PAGE__', '__SMART_PAGE__.database'];
  for (const forbidden of forbiddenRuntimeGlobals) {
    if (runtime.includes(forbidden)) fail(`运行产物包含废弃的 Workbuddy 全局入口：${forbidden}`);
  }

  const { server, origin } = await serve(distDirectory);
  try {
    const rootResponse = await fetch(`${origin}/`);
    if (!rootResponse.ok) fail(`静态服务器首页返回 ${rootResponse.status}`);
    const rootBody = await rootResponse.text();
    if (!rootBody.includes('<title>轻盈计划')) fail('静态服务器首页内容不完整');
    for (const path of files) {
      const reference = relative(distDirectory, path).split(sep).map(encodeURIComponent).join('/');
      const assetResponse = await fetch(`${origin}/${reference}`);
      if (!assetResponse.ok) fail(`静态资源 ${reference} 返回 ${assetResponse.status}`);
    }
  } finally {
    await new Promise((resolveServer) => server.close(resolveServer));
  }

  console.log(`发布检查通过：${basename(distDirectory)} 包含 ${files.length} 个文件，静态入口和资源可访问，未发现废弃 Workbuddy 全局入口。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
