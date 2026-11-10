import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Load KEY=VALUE lines from .env (if present) without overriding the real environment. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export interface AppConfig {
  dataDir: string;
  dbFile: string;
  keyFile: string;
  masterKeyEnv?: string;
  adminHost: string;
  adminPort: number;
  adminAllowNonLoopback: boolean;
  adminAllowedHosts: string[];
  publicHost: string;
  publicPort: number;
  /** Disable background timers (tests drive them explicitly). */
  disableSchedulers?: boolean;
  /** Logger on/off (tests silence it). */
  logLevel: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopbackHost = (h: string) => LOOPBACK.has(h) || h.startsWith('127.');

export function configFromEnv(env = process.env): AppConfig {
  const dataDir = path.resolve(env.ZTP_DATA_DIR ?? path.join(process.cwd(), 'data'));
  return {
    dataDir,
    dbFile: path.join(dataDir, 'portal.db'),
    keyFile: path.resolve(env.ZTP_KEY_FILE ?? path.join(os.homedir(), '.config', 'zoom-test-portal', 'master.key')),
    masterKeyEnv: env.ZTP_MASTER_KEY || undefined,
    adminHost: env.ZTP_ADMIN_HOST ?? '127.0.0.1',
    adminPort: Number(env.ZTP_ADMIN_PORT ?? 4800),
    adminAllowNonLoopback: env.ZTP_ADMIN_ALLOW_NON_LOOPBACK === '1',
    adminAllowedHosts: (env.ZTP_ADMIN_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    publicHost: env.ZTP_PUBLIC_HOST ?? '127.0.0.1',
    publicPort: Number(env.ZTP_PUBLIC_PORT ?? 4801),
    logLevel: env.ZTP_LOG_LEVEL ?? 'info',
  };
}
