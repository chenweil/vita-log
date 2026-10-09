import { backupTo, readBackupFile, restoreFromFile } from './d1-backup';
import { createOwnerBackupClient } from './d1-backup-transport';
import { readOwnerFile } from './d1-owner-file';

const usage = '用法：npm run d1:backup -- backup|restore --origin https://域名 --credentials /受限目录/credentials.json --directory /受限备份目录 [--file 备份文件 --expected-version N --confirm]';

/** Passwords come from a private file, never argv, stdout or a persisted cookie jar. */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') { console.log(usage); return; }
  const options = new Map<string, string>();
  let confirm = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--confirm') { confirm = true; continue; }
    if (!['--origin', '--credentials', '--directory', '--file', '--expected-version'].includes(key) || !args[index + 1] || options.has(key)) throw new Error(usage);
    options.set(key, args[++index]);
  }
  const originValue = options.get('--origin');
  const credentialsPath = options.get('--credentials');
  const directory = options.get('--directory');
  if (!originValue || !credentialsPath || !directory || !['backup', 'restore'].includes(command)) throw new Error(usage);
  const credentials = readOwnerFile(credentialsPath);
  const owner = await createOwnerBackupClient(originValue, credentials, globalThis, credentials.access);
  try {
    const client = owner.api;
    if (command === 'backup') {
      console.log(JSON.stringify(await backupTo(directory, client)));
    } else {
      const file = options.get('--file');
      if (!file) throw new Error(usage);
      const target = readBackupFile(file);
      if (!confirm) {
        const current = await client.backup();
        console.log(JSON.stringify({ currentVersion: current.version, targetRecords: target.weights.length + target.measurements.length + target.steps.length + target.checkins.length + target.diets.length, instruction: '核对来源与备份内容后，追加 --expected-version 上述版本 --confirm。恢复前会落盘当前在线数据。' }));
      } else {
        const expected = options.get('--expected-version');
        if (!expected || !/^\d+$/.test(expected)) throw new Error('恢复必须指定预览看到的 --expected-version');
        console.log(JSON.stringify(await restoreFromFile(file, directory, client, Number(expected))));
      }
    }
  } finally {
    await owner.logout();
  }
}

main().catch(() => {
  // Parser/network errors can embed response or credential contents. Never print them.
  console.error('备份/恢复命令未确认完整成功；请检查参数、受限目录权限和服务状态。恢复请求若已发出，请先重新读取在线数据，勿盲目重试。');
  process.exitCode = 1;
});
