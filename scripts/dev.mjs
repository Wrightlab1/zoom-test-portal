// One command for development: API server (auto-restart) + Vite dev server (HMR).
// Open http://127.0.0.1:5173 — Vite proxies /api to the admin listener.
import { spawn } from 'node:child_process';

const procs = [
  ['server', 'npx', ['tsx', 'watch', '--clear-screen=false', 'server/index.ts']],
  ['web', 'npx', ['vite']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = name === 'server' ? '\x1b[36m[server]\x1b[0m ' : '\x1b[35m[web]\x1b[0m    ';
  const pipe = (s) => s.on('data', (d) => process.stdout.write(d.toString().split('\n').map((l, i, a) => (i === a.length - 1 && !l ? '' : prefix + l)).join('\n')));
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    console.log(`${prefix}exited with ${code}`);
    shutdown(code ?? 1);
  });
  return p;
});

let down = false;
function shutdown(code = 0) {
  if (down) return;
  down = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('\nDev UI: http://127.0.0.1:5173  (API on the admin listener, default 127.0.0.1:4800)\n');
