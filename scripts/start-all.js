// Starts the mock BSE API and the dashboard together (zero dependencies).
//   npm start        -> 15-minute pulls (as per spec)
//   npm run demo     -> 20-second pulls (for a quick walkthrough), unless PULL_DELAY_MS is set
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../shared/config.js';

loadEnv();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
if (process.argv.includes('--demo') && !process.env.PULL_DELAY_MS) env.PULL_DELAY_MS = '20000';

const procs = [
  ['bse-mock', 'bse-mock/server.js', '\x1b[36m'],
  ['dashboard', 'dashboard/server.js', '\x1b[35m'],
].map(([name, file, color]) => {
  const p = spawn(process.execPath, [path.join(root, file)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${color}${name.padEnd(9)}\x1b[0m |`;
  const pipe = (stream, out) =>
    stream.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) if (line) out.write(`${prefix} ${line}\n`);
    });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix} exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return p;
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const port = env.DASHBOARD_PORT || 3000;
setTimeout(() => {
  console.log(`\n  Dashboard:  http://localhost:${port}`);
  console.log(`  Pull delay: ${Math.round(Number(env.PULL_DELAY_MS || 900000) / 1000)} s\n`);
}, 400);
