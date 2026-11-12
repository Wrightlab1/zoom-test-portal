import type { DB } from './index.js';
import type { Cipher } from '../lib/crypto.js';

export const DEFAULT_ALLOWLIST = [
  'zoom.us',
  'api.zoom.us',
  'api-au.zoom.us',
  'api-ca.zoom.us',
  'api-eu.zoom.us',
  'api-in.zoom.us',
  'api-sa.zoom.us',
  'api-sg.zoom.us',
  'api-uk.zoom.us',
  'api-us.zoom.us',
];

export interface Settings {
  /** Outbound host allowlist. Entries: "host", "*.domain", or "http://host:port" to permit plain HTTP (mock servers). */
  allowlist: string[];
  /** OAuth host base (authorize/token/revoke). */
  oauthBaseUrl: string;
  /** Default API base when no token api_url is known. */
  apiBaseUrl: string;
  webhookToleranceSec: number;
  retentionDays: number;
  maxStoredBodyBytes: number;
  ngrokDomain: string;
  ngrokAutostart: boolean;
  /** Use this instead of the ngrok URL (e.g. external tunnel or tests). Empty = use ngrok. */
  publicBaseUrlOverride: string;
  /** Last public URL we built Marketplace values from, for change detection. */
  lastPublicUrl: string;
  /** Refresh user tokens / re-request S2S tokens when this many seconds remain. */
  refreshLeadSec: number;
  /** Admin (bulk) authorization: wait this long after the bulk code exchange before asking for user tokens. Zoom says user-token preparation may be asynchronous and suggests 1–2 minutes. */
  bulkFirstFetchDelaySec: number;
  /** batch_size for the bulk token exchange (Zoom: default 100, max 500; must stay the same within a session). */
  bulkBatchSize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  allowlist: DEFAULT_ALLOWLIST,
  oauthBaseUrl: 'https://zoom.us',
  apiBaseUrl: 'https://api.zoom.us',
  webhookToleranceSec: 300,
  retentionDays: 0,
  maxStoredBodyBytes: 1024 * 1024,
  ngrokDomain: '',
  ngrokAutostart: false,
  publicBaseUrlOverride: '',
  lastPublicUrl: '',
  refreshLeadSec: 300,
  bulkFirstFetchDelaySec: 90,
  bulkBatchSize: 100,
};

export const SECRET_SETTINGS = ['ngrokAuthtoken'] as const;
export type SecretSettingKey = (typeof SECRET_SETTINGS)[number];

export class SettingsRepo {
  private cache: Settings | null = null;
  constructor(
    private db: DB,
    private cipher: Cipher,
  ) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE is_secret = 0').all() as { key: string; value: string }[];
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    for (const r of rows) {
      if (r.key in s) {
        try {
          (s as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
        } catch {
          /* ignore corrupt value, keep default */
        }
      }
    }
    this.cache = s;
    return s;
  }

  update(patch: Partial<Settings>): Settings {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
        stmt.run(k, JSON.stringify(v), now);
      }
    })();
    this.cache = null;
    return this.get();
  }

  getSecret(key: SecretSettingKey): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ? AND is_secret = 1').get(key) as { value: string | null } | undefined;
    return r?.value ? this.cipher.decrypt(r.value, `settings.${key}`) : null;
  }

  setSecret(key: SecretSettingKey, value: string | null): void {
    const enc = value ? this.cipher.encrypt(value, `settings.${key}`) : null;
    this.db
      .prepare(
        'INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, enc, Date.now());
  }
}
