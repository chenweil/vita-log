import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { createOwnerCredential } from '../functions/_lib/owner-credentials';
import { SqliteStore } from './store';

/**
 * The one place an owner account can be created.
 *
 * There is no public route for this on either backend, so the first
 * administrator — and every later password rotation — happens here, run by the
 * owner against a machine they already control.
 *
 *   npm run owner -- cloudflare-credential     → prints the Secret value
 *   npm run owner -- sqlite-set <username>     → provisions/rotates the local store
 *
 * The password is read from `VITA_OWNER_PASSWORD` or from stdin, and never from
 * argv. An argument lands in the shell history and in the process table, both
 * of which outlive the command; the environment and a pipe do not.
 */
const USAGE = [
  '用法：',
  '  npm run owner -- cloudflare-credential           打印 VITA_LOG_OWNER_CREDENTIAL 的值',
  '  npm run owner -- sqlite-set <username>            预置或轮换本机 SQLite 的本人账号',
  '',
  '密码从 VITA_OWNER_PASSWORD 环境变量或标准输入读取，不接受命令行参数。',
  '示例：printf %s "$NEW_PASSWORD" | npm run owner -- sqlite-set owner',
].join('\n');

// The login route accepts anything from 10 characters, because that floor only
// has to keep implausible input out of the KDF. This one is a policy for
// credentials being created after a published one was treated as exposed, so it
// is deliberately stricter — and deliberately not raised at login, which would
// lock out an existing owner rather than protect a new password.
const MIN_PASSWORD = 12;

async function readPassword(): Promise<string> {
  const fromEnvironment = process.env.VITA_OWNER_PASSWORD;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;

  // A pipe is the usual non-interactive case; an interactive terminal would
  // need a hidden prompt, which this tool deliberately does not implement —
  // stdin is read as-is so what the owner types is never echoed by us.
  if (process.stdin.isTTY) throw new Error(`请通过 VITA_OWNER_PASSWORD 或管道提供密码。\n${USAGE}`);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function assertUsable(password: string): void {
  // The historical credential is considered exposed, so a short password is
  // not something worth persisting. Refusing here is better than accepting it
  // and forgetting that the value is guessable.
  if (password.length < MIN_PASSWORD) throw new Error(`密码至少需要 ${MIN_PASSWORD} 个字符`);
  if (password.length > 1024) throw new Error('密码过长');
}

const [command, username, ...extra] = process.argv.slice(2);

try {
  if (command === 'cloudflare-credential') {
    // A stray positional here would be a password somebody believed was being
    // read as one. Refuse loudly rather than silently use the environment.
    if (username) throw new Error(`不接受额外参数；密码只能来自 VITA_OWNER_PASSWORD 或标准输入。\n${USAGE}`);
    const password = await readPassword();
    assertUsable(password);
    console.log(await createOwnerCredential(password));
    console.error('\n把上面这一行写入 Cloudflare Secret：wrangler pages secret put VITA_LOG_OWNER_CREDENTIAL');
  } else if (command === 'sqlite-set' && username) {
    if (extra.length > 0) throw new Error(`不接受额外参数；密码只能来自 VITA_OWNER_PASSWORD 或标准输入。\n${USAGE}`);
    if (!username.trim() || username.length > 100) throw new Error('账号无效');
    const password = await readPassword();
    assertUsable(password);
    const store = new SqliteStore({ database: resolve(process.env.VITA_DATABASE ?? 'data/vita-log.sqlite'), backups: resolve(process.env.VITA_BACKUPS ?? 'backups') });
    try {
      const rotating = store.credentials() !== null;
      const salt = randomBytes(16).toString('hex');
      store.setOwnerCredentials(username.trim(), salt, scryptSync(password, salt, 64).toString('hex'));
      // Rotating a password that was published does not by itself unseat anyone
      // who already logged in with it, so the operator is told the remaining
      // step rather than left to assume the rotation covered it. SQLite sessions
      // live in the server process's memory, so a restart clears them.
      console.error(rotating
        ? `已轮换账号 ${username.trim()}。已签发的会话仍然可用：重启服务进程即可全部失效。`
        : `已预置账号 ${username.trim()}。`);
      if (rotating) console.error('若怀疑泄露期间有人登录过，请重启服务；Cloudflare 部署请改 Secret 后另行清空 owner_session 表。');
    } finally { store.close(); }
  } else if (command === '--help' || command === '-h' || command === undefined) {
    console.log(USAGE);
  } else {
    throw new Error(USAGE);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}