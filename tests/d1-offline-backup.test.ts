import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/domain';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { CloudflareRuntime, resetRuntime } from './support/cloudflare-runtime';
import { D1BackupClient, backupTo, restoreFromFile } from '../server/d1-backup';
import { SqliteStore } from '../server/store';

const password = 'a sufficiently long owner password';
const credential = await createOwnerCredential(password);
let directory: string;
let runtime: CloudflareRuntime;
beforeEach(async () => {
  resetRuntime();
  directory = mkdtempSync(join(tmpdir(), 'vita-offline-'));
  runtime = new CloudflareRuntime({ credential });
  const snapshot = createEmptySnapshot();
  snapshot.settings.name = 'offline owner';
  runtime.db.seed(JSON.stringify(snapshot), 4);
  await runtime.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) });
});
afterEach(() => { runtime.close(); rmSync(directory, { recursive: true, force: true }); resetRuntime(); });

it('完整 JSON 与可读 SQLite 副本落在受限目录，包含完整 owner 数据', async () => {
  const result = await backupTo(directory, new D1BackupClient(runtime));
  const json = JSON.parse(readFileSync(result.json, 'utf8'));
  expect(json.settings.name).toBe('offline owner');
  expect(json.backup.version).toBe(4);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  for (const file of [result.json, result.sqlite]) expect(statSync(file).mode & 0o777).toBe(0o600);
  const store = new SqliteStore({ database: result.sqlite, backups: join(directory, 'sqlite-backups') });
  try { expect(store.load().snapshot.settings.name).toBe('offline owner'); } finally { store.close(); }
});

it('恢复前将当前在线数据落盘为完整 JSON 和 SQLite，恢复不倒退在线版本', async () => {
  const client = new D1BackupClient(runtime);
  const target = await backupTo(directory, client);
  const changed = createEmptySnapshot();
  changed.settings.name = 'new online data';
  runtime.db.seed(JSON.stringify(changed), 5);
  const result = await restoreFromFile(target.json, directory, client, 5);
  expect(JSON.parse(readFileSync(result.safety.json, 'utf8')).settings.name).toBe('new online data');
  expect(statSync(result.safety.sqlite).size).toBeGreaterThan(0);
  const current = await client.backup();
  expect(current.snapshot.settings.name).toBe('offline owner');
  expect(current.version).toBe(6);
});

it('恢复前备份无法落盘时停止恢复，不改在线数据', async () => {
  const client = new D1BackupClient(runtime);
  const target = await backupTo(directory, client);
  const occupied = join(directory, 'not-a-directory');
  writeFileSync(occupied, 'occupied');
  await expect(restoreFromFile(target.json, occupied, client, 4)).rejects.toThrow();
  expect(runtime.requests).not.toContain('POST /api/restore');
  expect((await client.backup()).version).toBe(4);
});

it('备份被篡改时不发送恢复请求', async () => {
  const client = new D1BackupClient(runtime);
  const target = await backupTo(directory, client);
  const content = JSON.parse(readFileSync(target.json, 'utf8'));
  content.settings.name = 'tampered';
  writeFileSync(target.json, JSON.stringify(content));
  await expect(restoreFromFile(target.json, directory, client, 4)).rejects.toThrow('校验失败');
  expect(runtime.requests).not.toContain('POST /api/restore');
});

it('确认后在线版本已改变时停止恢复，保留新数据', async () => {
  const client = new D1BackupClient(runtime);
  const target = await backupTo(directory, client);
  runtime.db.seed(JSON.stringify(createEmptySnapshot()), 5);
  await expect(restoreFromFile(target.json, directory, client, 4)).rejects.toThrow('重新预览');
  expect(runtime.requests).not.toContain('POST /api/restore');
  expect((await client.backup()).version).toBe(5);
});
