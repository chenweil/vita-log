// 生成 404.html：GitHub Pages 用它处理深链接回退（把 404 请求重写到 404.html）。
// 对根路径托管是无害的多余文件。
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('dist/index.html');
const target = resolve('dist/404.html');

if (!existsSync(source)) {
  console.error('未找到 dist/index.html，请先运行 vite build');
  process.exit(1);
}

copyFileSync(source, target);
console.log('已生成 dist/404.html（深链接回退到首页）');
