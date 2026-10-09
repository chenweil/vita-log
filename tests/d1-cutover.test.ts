import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptySnapshot } from '../src/domain';
import { SqliteStore } from '../server/store';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { confirmCutover, previewCutover, readCutoverSource } from '../server/d1-cutover';
import { readOwnerFile } from '../server/d1-owner-file';
import { createOwnerBackupClient } from '../server/d1-backup-transport';
import { CloudflareRuntime, resetRuntime } from './support/cloudflare-runtime';

let root: string;
let sqlite: string;
let runtime: CloudflareRuntime;
const password = 'cutover test only long password';
beforeEach(async () => {
  resetRuntime();
  root = mkdtempSync(join(tmpdir(), 'vita-cutover-'));
  sqlite = join(root, 'source.sqlite');
  const store = new SqliteStore({ database: sqlite, backups: join(root, 'local-backups') });
  const snapshot = createEmptySnapshot();
  snapshot.settings.name = 'synthetic migration owner';
  store.commit(snapshot, 0);
  store.close();
  runtime = new CloudflareRuntime({ credential: await createOwnerCredential(password) });
});
afterEach(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); resetRuntime(); });
const login = () => createOwnerBackupClient('https://vita-log.pages.dev', { username: 'owner', password }, runtime);

it('来源只读；不存在或未初始化时拒绝，不创造空库', () => {
  const bytes = readFileSync(sqlite);
  expect(readCutoverSource(sqlite).version).toBe(1);
  expect(readFileSync(sqlite)).toEqual(bytes);
  const absent = join(root, 'absent.sqlite');
  expect(() => readCutoverSource(absent)).toThrow();
  expect(existsSync(absent)).toBe(false);
  const empty = join(root, 'empty.sqlite');
  new SqliteStore({ database: empty, backups: root }).close();
  expect(() => readCutoverSource(empty)).toThrow('尚无');
});

it('预览不迁入健康数据；显式确认后保存迁移前后 JSON/SQLite，并确认注销', async () => {
  const owner = await login();
  const source = readCutoverSource(sqlite);
  const preview = await previewCutover(source, owner);
  expect(preview.empty).toBe(true);
  expect(runtime.db.storedVersion()).toBe(0);
  const result = await confirmCutover(source, join(root, 'offline'), preview.sourceSha256, owner);
  expect(result.reconciled).toBe(true);
  expect(runtime.db.storedName()).toBe(source.snapshot.settings.name);
  for (const pair of [result.safety, result.backup]) {
    expect(JSON.parse(readFileSync(pair.json, 'utf8')).settings).toEqual(source.snapshot.settings);
    const store = new SqliteStore({ database: pair.sqlite, backups: root });
    expect(store.credentials()).toBeNull();
    expect(store.load().snapshot.settings).toEqual(source.snapshot.settings);
    store.close();
  }
  await owner.logout();
  expect(runtime.db.sessionRows()).toBe(0);
});

it('备份落盘失败、来源确认摘要不匹配、D1 非空都阻止首次迁移', async () => {
  const owner = await login();
  const source = readCutoverSource(sqlite);
  const occupied = join(root, 'occupied');
  writeFileSync(occupied, 'not a directory');
  await expect(confirmCutover(source, occupied, source.sha256, owner)).rejects.toThrow();
  await expect(confirmCutover(source, root, '0'.repeat(64), owner)).rejects.toThrow('来源已变化');
  expect(runtime.requests).not.toContain('POST /api/migrate');
  runtime.db.seed(JSON.stringify(createEmptySnapshot()), 5);
  await expect(confirmCutover(source, root, source.sha256, owner)).rejects.toThrow('已有');
  expect(runtime.requests).not.toContain('POST /api/migrate');
  expect(runtime.db.storedVersion()).toBe(5);
  await owner.logout();
});

it('迁移后备份不可读时不报完整成功，不重放已经提交的迁移', async () => {
  const owner = await login();
  const source = readCutoverSource(sqlite);
  const original = owner.api.backup.bind(owner.api);
  owner.api.backup = async () => { throw new Error('offline after promotion'); };
  await expect(confirmCutover(source, join(root, 'offline'), source.sha256, owner)).rejects.toThrow();
  expect(runtime.db.storedVersion()).toBe(1);
  owner.api.backup = original;
  await expect(confirmCutover(source, join(root, 'offline'), source.sha256, owner)).rejects.toThrow('已有');
  expect(runtime.requests.filter((path) => path === 'POST /api/migrate')).toHaveLength(1);
  await owner.logout();
});

it('数量摘要相同但非摘要设置被改写时，完整回读仍拒绝验收成功', async () => {
  const owner = await login();
  const source = readCutoverSource(sqlite);
  const original = owner.api.backup.bind(owner.api);
  owner.api.backup = async () => {
    const backup = await original();
    backup.snapshot.settings.proteinTarget += 1;
    return backup;
  };
  await expect(confirmCutover(source, join(root, 'offline'), source.sha256, owner)).rejects.toThrow('在线副本对账未通过');
  expect(runtime.db.storedVersion()).toBe(1);
  await owner.logout();
});

it('被替换的预览摘要不允许发送迁移请求', async () => {
  const owner = await login();
  const source = readCutoverSource(sqlite);
  const original = owner.fetch;
  owner.fetch = async (input, init) => {
    const response = await original(input, init);
    if (String(input) !== '/api/migration-preview') return response;
    const value = await response.json();
    value.summary.total += 1;
    return Response.json(value);
  };
  await expect(confirmCutover(source, join(root, 'offline'), source.sha256, owner)).rejects.toThrow('预览对账不一致');
  expect(runtime.requests).not.toContain('POST /api/migrate');
  expect(runtime.db.storedVersion()).toBe(0);
  await owner.logout();
});

it('受限凭据过滤和 Access 成对校验', () => {
  const file = join(root, 'credentials.json');
  writeFileSync(file, JSON.stringify({ username: 'owner', password, accessClientId: 'synthetic-id', accessClientSecret: 'synthetic-secret' }), { mode: 0o600 });
  expect(readOwnerFile(file).access).toEqual({ clientId: 'synthetic-id', clientSecret: 'synthetic-secret' });
  chmodSync(file, 0o644);
  expect(() => readOwnerFile(file)).toThrow('0600');
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify({ username: 'owner', password, accessClientId: 'synthetic-id' }));
  expect(() => readOwnerFile(file)).toThrow('成对');
  writeFileSync(file, '{"password":"synthetic-private-password", broken');
  expect(() => readOwnerFile(file)).toThrow('凭据文件无法读取或格式无效');
});

it('Access 凭据随同源请求发送，跨域和重定向不能转发本人凭据', async () => {
  const requests: Request[] = [];
  const owner = await createOwnerBackupClient('https://vita-log.pages.dev', { username: 'owner', password }, {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response('{}', { headers: { 'set-cookie': 'vita-log-session=synthetic-cookie; Path=/api' } });
    },
  }, { clientId: 'synthetic-id', clientSecret: 'synthetic-secret' });
  await owner.fetch('/api/migration-preview', { method: 'POST' });
  await expect(owner.fetch('https://other.example/api/backup')).rejects.toThrow('其他域名');
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.redirect).toBe('error');
    expect(request.headers.get('cf-access-client-secret')).toBe('synthetic-secret');
  }
  expect(requests[1].headers.get('cookie')).toBe('vita-log-session=synthetic-cookie');
  expect(requests[1].headers.get('origin')).toBe('https://vita-log.pages.dev');
});
