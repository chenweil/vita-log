import { lstatSync, readFileSync } from 'node:fs';
import { isRecord } from '../src/domain';
import type { AccessCredentials } from './d1-backup-transport';

/** Only private regular files; never echo their contents or parser errors. */
export function readOwnerFile(path: string): { username: string; password: string; access?: AccessCredentials } {
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error('凭据必须来自权限为 0600 的真实文件');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('凭据文件无法读取或格式无效'); }
  if (!isRecord(value) || typeof value.username !== 'string' || !value.username.trim() || typeof value.password !== 'string' || !value.password) throw new Error('凭据文件无效');
  let access: AccessCredentials | undefined;
  if (value.accessClientId !== undefined || value.accessClientSecret !== undefined) {
    if (typeof value.accessClientId !== 'string' || !value.accessClientId || typeof value.accessClientSecret !== 'string' || !value.accessClientSecret) throw new Error('Access 服务凭据必须成对提供');
    access = { clientId: value.accessClientId, clientSecret: value.accessClientSecret };
  }
  return { username: value.username, password: value.password, access };
}
