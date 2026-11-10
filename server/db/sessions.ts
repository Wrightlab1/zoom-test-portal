import type { DB } from './index.js';

export interface SessionRow {
  id_hash: string;
  csrf: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export class AdminRepo {
  constructor(private db: DB) {}

  hasPassword(): boolean {
    return !!this.db.prepare('SELECT 1 FROM admin_user WHERE id = 1').get();
  }
  getPasswordHash(): string | null {
    const r = this.db.prepare('SELECT password_hash FROM admin_user WHERE id = 1').get() as { password_hash: string } | undefined;
    return r?.password_hash ?? null;
  }
  setPasswordHash(hash: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO admin_user (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at',
      )
      .run(hash, now, now);
  }

  createSession(idHash: string, csrf: string, ttlMs: number, userAgent?: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (id_hash, csrf, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(idHash, csrf, now, now, now + ttlMs, userAgent ?? null);
  }
  getSession(idHash: string): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined) ?? null;
  }
  touchSession(idHash: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(Date.now(), idHash);
  }
  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }
  deleteAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run();
  }
  purgeExpired(idleMs: number): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now, now - idleMs);
  }
}
