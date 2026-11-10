import type { DB } from './index.js';
import { aad } from './index.js';
import type { Cipher } from '../lib/crypto.js';
import { mask, secrets } from '../lib/redact.js';

export type ProfileType = 's2s' | 'user';

export interface ProfileRow {
  id: number;
  slug: string;
  name: string;
  type: ProfileType;
  client_id: string;
  client_secret_enc: string | null;
  account_id: string | null;
  webhook_secret_enc: string | null;
  use_pkce: number;
  auto_refresh: number;
  scopes_requested: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

/** What the admin API returns: secrets are never included, only a masked hint. */
export interface ProfileView {
  id: number;
  slug: string;
  name: string;
  type: ProfileType;
  clientId: string;
  clientSecretHint: string | null;
  accountId: string | null;
  webhookSecretHint: string | null;
  usePkce: boolean;
  autoRefresh: boolean;
  scopesRequested: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileInput {
  name: string;
  slug?: string;
  type: ProfileType;
  clientId: string;
  /** undefined = keep, null/'' = clear, string = replace */
  clientSecret?: string | null;
  accountId?: string | null;
  webhookSecret?: string | null;
  usePkce?: boolean;
  autoRefresh?: boolean;
  scopesRequested?: string | null;
  notes?: string | null;
}

const A_SECRET = aad('profiles', 'client_secret_enc');
const A_WEBHOOK = aad('profiles', 'webhook_secret_enc');

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile'
  );
}

export class ProfilesRepo {
  constructor(
    private db: DB,
    private cipher: Cipher,
  ) {}

  /** Register every stored secret with the redactor so it can never leak into logs. */
  registerSecrets(): void {
    for (const r of this.db.prepare('SELECT client_secret_enc, webhook_secret_enc FROM profiles').all() as ProfileRow[]) {
      secrets.add(this.cipher.decNullable(r.client_secret_enc, A_SECRET));
      secrets.add(this.cipher.decNullable(r.webhook_secret_enc, A_WEBHOOK));
    }
  }

  list(): ProfileRow[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY name COLLATE NOCASE').all() as ProfileRow[];
  }
  get(id: number): ProfileRow | null {
    return (this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined) ?? null;
  }
  getBySlug(slug: string): ProfileRow | null {
    return (this.db.prepare('SELECT * FROM profiles WHERE slug = ?').get(slug) as ProfileRow | undefined) ?? null;
  }

  clientSecret(p: ProfileRow): string | null {
    return this.cipher.decNullable(p.client_secret_enc, A_SECRET);
  }
  webhookSecret(p: ProfileRow): string | null {
    return this.cipher.decNullable(p.webhook_secret_enc, A_WEBHOOK);
  }

  view(p: ProfileRow): ProfileView {
    const cs = this.clientSecret(p);
    const ws = this.webhookSecret(p);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: p.type,
      clientId: p.client_id,
      clientSecretHint: cs ? mask(cs) : null,
      accountId: p.account_id,
      webhookSecretHint: ws ? mask(ws) : null,
      usePkce: !!p.use_pkce,
      autoRefresh: !!p.auto_refresh,
      scopesRequested: p.scopes_requested,
      notes: p.notes,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  private uniqueSlug(base: string, exceptId?: number): string {
    let slug = slugify(base);
    let i = 2;
    while (true) {
      const r = this.db.prepare('SELECT id FROM profiles WHERE slug = ?').get(slug) as { id: number } | undefined;
      if (!r || r.id === exceptId) return slug;
      slug = `${slugify(base).slice(0, 44)}-${i++}`;
    }
  }

  create(input: ProfileInput): ProfileRow {
    const now = Date.now();
    secrets.add(input.clientSecret);
    secrets.add(input.webhookSecret);
    const info = this.db
      .prepare(
        `INSERT INTO profiles (slug, name, type, client_id, client_secret_enc, account_id, webhook_secret_enc, use_pkce, auto_refresh, scopes_requested, notes, created_at, updated_at)
         VALUES (@slug, @name, @type, @client_id, @cs, @account_id, @ws, @use_pkce, @auto_refresh, @scopes, @notes, @now, @now)`,
      )
      .run({
        slug: this.uniqueSlug(input.slug || input.name),
        name: input.name,
        type: input.type,
        client_id: input.clientId,
        cs: this.cipher.encNullable(input.clientSecret, A_SECRET),
        account_id: input.type === 's2s' ? (input.accountId ?? null) : null,
        ws: this.cipher.encNullable(input.webhookSecret, A_WEBHOOK),
        use_pkce: input.usePkce ? 1 : 0,
        auto_refresh: input.autoRefresh === false ? 0 : 1,
        scopes: input.scopesRequested ?? null,
        notes: input.notes ?? null,
        now,
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, input: Partial<ProfileInput>): ProfileRow | null {
    const p = this.get(id);
    if (!p) return null;
    const sets: string[] = [];
    const vals: Record<string, unknown> = { id, now: Date.now() };
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = @${col}`);
      vals[col] = v;
    };
    if (input.name !== undefined) set('name', input.name);
    if (input.slug !== undefined && input.slug !== p.slug) set('slug', this.uniqueSlug(input.slug, id));
    if (input.type !== undefined) set('type', input.type);
    if (input.clientId !== undefined) set('client_id', input.clientId);
    if (input.clientSecret !== undefined) {
      secrets.add(input.clientSecret);
      set('client_secret_enc', this.cipher.encNullable(input.clientSecret, A_SECRET));
    }
    if (input.accountId !== undefined) set('account_id', input.accountId);
    if (input.webhookSecret !== undefined) {
      secrets.add(input.webhookSecret);
      set('webhook_secret_enc', this.cipher.encNullable(input.webhookSecret, A_WEBHOOK));
    }
    if (input.usePkce !== undefined) set('use_pkce', input.usePkce ? 1 : 0);
    if (input.autoRefresh !== undefined) set('auto_refresh', input.autoRefresh ? 1 : 0);
    if (input.scopesRequested !== undefined) set('scopes_requested', input.scopesRequested);
    if (input.notes !== undefined) set('notes', input.notes);
    if (sets.length) this.db.prepare(`UPDATE profiles SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(vals);
    return this.get(id);
  }

  duplicate(id: number): ProfileRow | null {
    const p = this.get(id);
    if (!p) return null;
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO profiles (slug, name, type, client_id, client_secret_enc, account_id, webhook_secret_enc, use_pkce, auto_refresh, scopes_requested, notes, created_at, updated_at)
         SELECT @slug, @name, type, client_id, client_secret_enc, account_id, webhook_secret_enc, use_pkce, auto_refresh, scopes_requested, notes, @now, @now FROM profiles WHERE id = @id`,
      )
      .run({ id, slug: this.uniqueSlug(`${p.slug}-copy`), name: `${p.name} (copy)`, now });
    return this.get(Number(info.lastInsertRowid));
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes > 0;
  }
}
