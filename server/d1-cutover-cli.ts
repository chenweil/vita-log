import { readCutoverSource, previewCutover, confirmCutover } from './d1-cutover';
import { readOwnerFile } from './d1-owner-file';
import { createOwnerBackupClient } from './d1-backup-transport';

const usage = '用法：npm run d1:cutover -- --origin https://域名 --credentials /受限目录/credentials.json --sqlite /来源.sqlite --directory /受限备份目录 [--confirm --source-sha256 预览摘要]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const options = new Map<string, string>();
  let confirm = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--confirm' && !confirm) { confirm = true; continue; }
    if (!['--origin', '--credentials', '--sqlite', '--directory', '--source-sha256'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || options.has(key)) throw new Error(usage);
    options.set(key, args[++index]);
  }
  const origin = options.get('--origin');
  const file = options.get('--credentials');
  const sqlite = options.get('--sqlite');
  const directory = options.get('--directory');
  const approved = options.get('--source-sha256');
  if (!origin || !file || !sqlite || !directory || (confirm && (!approved || !/^[a-f0-9]{64}$/.test(approved))) || (!confirm && approved)) throw new Error(usage);
  const source = readCutoverSource(sqlite);
  const credentials = readOwnerFile(file);
  const owner = await createOwnerBackupClient(origin, credentials, globalThis, credentials.access);
  try {
    console.log(JSON.stringify(confirm
      ? await confirmCutover(source, directory, approved!, owner)
      : await previewCutover(source, owner), null, 2));
  } finally { await owner.logout(); }
}

main().catch(() => {
  // Never echo a parser error, API body, health content or authentication material.
  console.error('迁移流程未确认完整成功。若已发送迁移请求，数据可能已经落库；请保持访问隔离并重新核对在线快照、备份和注销状态，勿盲目重试。');
  process.exitCode = 1;
});
