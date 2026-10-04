import { resolve } from 'node:path';
import { SqliteStore } from './store';
const store = new SqliteStore({ database: resolve(process.env.VITA_DATABASE ?? 'data/vita-log.sqlite'), backups: resolve(process.env.VITA_BACKUPS ?? 'backups') });
try {
  const [command, name, confirmation] = process.argv.slice(2);
  if (command === 'backup') console.log(store.backup());
  else if (command === 'list') console.log(JSON.stringify(store.backups(), null, 2));
  else if (command === 'restore' && name) {
    const item = store.backups().find(backup => backup.name === name);
    if (!item) throw new Error('没有找到有效备份');
    console.log(JSON.stringify(item, null, 2));
    if (confirmation !== '--confirm') throw new Error('核对上述摘要后，追加 --confirm 执行恢复');
    const restored = store.restore(name, store.load().version);
    console.log(`已恢复，数据版本 ${restored.version}`);
  } else throw new Error('用法：npm run sqlite -- backup|list|restore <name> [--confirm]');
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
finally { store.close(); }
