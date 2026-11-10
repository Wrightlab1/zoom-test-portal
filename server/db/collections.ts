import type { DB } from './index.js';
import { aad } from './index.js';
import type { Cipher } from '../lib/crypto.js';
import type { KV, ParsedCollection, ParsedEnvironment, RequestDefinition } from '../lib/postman.js';
import { sha256hex } from '../lib/crypto.js';

export interface CollectionRow {
  id: number;
  name: string;
  postman_id: string | null;
  description: string | null;
  variables_enc: string | null;
  source_hash: string | null;
  request_count: number;
  imported_at: number;
  updated_at: number;
}

export interface CollectionRequestRow {
  id: number;
  collection_id: number;
  folder_id: number | null;
  match_key: string;
  postman_id: string | null;
  name: string;
  method: string;
  url_raw: string;
  path_template: string;
  definition: string;
  description: string | null;
  sort: number;
  updated_at: number;
}

export interface ImportSummary {
  collectionId: number;
  name: string;
  created: boolean;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  relinkedSavedRequests: number;
  orphanedSavedRequests: number;
  folders: number;
  warnings: string[];
}

const A_VARS = aad('collections', 'variables_enc');
const A_ENV = aad('environments', 'values_enc');

export class CollectionsRepo {
  constructor(
    private db: DB,
    private cipher: Cipher,
  ) {}

  list(): CollectionRow[] {
    return this.db.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all() as CollectionRow[];
  }
  get(id: number): CollectionRow | null {
    return (this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined) ?? null;
  }
  variables(c: CollectionRow): KV[] {
    const v = this.cipher.decNullable(c.variables_enc, A_VARS);
    return v ? JSON.parse(v) : [];
  }
  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM collections WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Import or update. A collection is "the same" if its Postman ID matches, or else its name.
   * Requests are matched on method + path template, so a newer export updates definitions in
   * place; saved requests keep pointing at them, and orphaned ones re-link if the endpoint returns.
   */
  import(parsed: ParsedCollection, opts: { targetId?: number; sourceText: string }): ImportSummary {
    const now = Date.now();
    return this.db.transaction((): ImportSummary => {
      let existing: CollectionRow | null = null;
      if (opts.targetId) existing = this.get(opts.targetId);
      if (!existing && parsed.postmanId) existing = (this.db.prepare('SELECT * FROM collections WHERE postman_id = ?').get(parsed.postmanId) as CollectionRow | undefined) ?? null;
      if (!existing) existing = (this.db.prepare('SELECT * FROM collections WHERE name = ? AND postman_id IS NULL').get(parsed.name) as CollectionRow | undefined) ?? null;

      const varsEnc = this.cipher.encNullable(JSON.stringify(parsed.variables), A_VARS);
      let collectionId: number;
      if (existing) {
        collectionId = existing.id;
        this.db
          .prepare('UPDATE collections SET name = ?, postman_id = COALESCE(?, postman_id), description = ?, variables_enc = ?, source_hash = ?, request_count = ?, updated_at = ? WHERE id = ?')
          .run(parsed.name, parsed.postmanId, parsed.description, varsEnc, sha256hex(opts.sourceText), parsed.requests.length, now, collectionId);
      } else {
        collectionId = Number(
          this.db
            .prepare('INSERT INTO collections (name, postman_id, description, variables_enc, source_hash, request_count, imported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(parsed.name, parsed.postmanId, parsed.description, varsEnc, sha256hex(opts.sourceText), parsed.requests.length, now, now).lastInsertRowid,
        );
      }

      // Folders are rebuilt each time (requests are re-pointed below).
      this.db.prepare('UPDATE collection_requests SET folder_id = NULL WHERE collection_id = ?').run(collectionId);
      this.db.prepare('DELETE FROM collection_folders WHERE collection_id = ?').run(collectionId);
      const folderIds = new Map<string, number>();
      const insFolder = this.db.prepare('INSERT INTO collection_folders (collection_id, parent_id, name, description, sort) VALUES (?, ?, ?, ?, ?)');
      for (const f of parsed.folders) {
        folderIds.set(f.key, Number(insFolder.run(collectionId, f.parentKey ? (folderIds.get(f.parentKey) ?? null) : null, f.name, f.description, f.sort).lastInsertRowid));
      }

      const existingReqs = new Map(
        (this.db.prepare('SELECT id, match_key, definition, name, description, method, updated_at FROM collection_requests WHERE collection_id = ?').all(collectionId) as CollectionRequestRow[]).map((r) => [r.match_key, r]),
      );
      const ins = this.db.prepare(
        'INSERT INTO collection_requests (collection_id, folder_id, match_key, postman_id, name, method, url_raw, path_template, definition, description, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const upd = this.db.prepare(
        'UPDATE collection_requests SET folder_id = ?, postman_id = ?, name = ?, method = ?, url_raw = ?, path_template = ?, definition = ?, description = ?, sort = ?, updated_at = ? WHERE id = ?',
      );
      let added = 0;
      let updated = 0;
      let unchanged = 0;
      const seen = new Set<string>();
      for (const r of parsed.requests) {
        seen.add(r.matchKey);
        const def = JSON.stringify(r.definition);
        const folderId = r.folderKey ? (folderIds.get(r.folderKey) ?? null) : null;
        const prev = existingReqs.get(r.matchKey);
        if (prev) {
          const same = prev.definition === def && prev.name === r.name && prev.description === r.description;
          upd.run(folderId, r.postmanId, r.name, r.method, r.definition.urlRaw, r.definition.pathTemplate, def, r.description, r.sort, same ? prev.updated_at : now, prev.id);
          if (same) unchanged++;
          else updated++;
        } else {
          ins.run(collectionId, folderId, r.matchKey, r.postmanId, r.name, r.method, r.definition.urlRaw, r.definition.pathTemplate, def, r.description, r.sort, now);
          added++;
        }
      }
      // Remove requests no longer in the collection. Saved requests are kept (FK sets NULL) and
      // remember their match_key so they re-link if the endpoint comes back.
      let removed = 0;
      const del = this.db.prepare('DELETE FROM collection_requests WHERE id = ?');
      for (const [key, r] of existingReqs) {
        if (!seen.has(key)) {
          del.run(r.id);
          removed++;
        }
      }
      const relinked = this.db
        .prepare(
          `UPDATE saved_requests SET collection_request_id = (
             SELECT cr.id FROM collection_requests cr WHERE cr.collection_id = saved_requests.collection_id AND cr.match_key = saved_requests.match_key)
           WHERE collection_id = ? AND collection_request_id IS NULL AND match_key IN (SELECT match_key FROM collection_requests WHERE collection_id = ?)`,
        )
        .run(collectionId, collectionId).changes;
      const orphaned = (this.db.prepare('SELECT COUNT(*) n FROM saved_requests WHERE collection_id = ? AND collection_request_id IS NULL').get(collectionId) as { n: number }).n;

      return {
        collectionId,
        name: parsed.name,
        created: !existing,
        added,
        updated,
        unchanged,
        removed,
        relinkedSavedRequests: relinked,
        orphanedSavedRequests: orphaned,
        folders: parsed.folders.length,
        warnings: parsed.warnings,
      };
    })();
  }

  /** Compact tree for the explorer: folders + request headers only (no definitions). */
  tree(collectionId: number) {
    const folders = this.db.prepare('SELECT id, parent_id AS parentId, name, sort FROM collection_folders WHERE collection_id = ? ORDER BY sort').all(collectionId);
    const requests = this.db
      .prepare('SELECT id, folder_id AS folderId, name, method, path_template AS path, sort FROM collection_requests WHERE collection_id = ? ORDER BY sort')
      .all(collectionId);
    return { folders, requests };
  }

  getRequest(id: number): (Omit<CollectionRequestRow, 'definition'> & { definition: RequestDefinition }) | null {
    const r = this.db.prepare('SELECT * FROM collection_requests WHERE id = ?').get(id) as CollectionRequestRow | undefined;
    return r ? { ...r, definition: JSON.parse(r.definition) } : null;
  }

  // ---- environments ----
  listEnvironments() {
    return this.db.prepare('SELECT id, name, postman_id AS postmanId, imported_at AS importedAt FROM environments ORDER BY name COLLATE NOCASE').all() as {
      id: number;
      name: string;
    }[];
  }
  environmentValues(id: number): KV[] | null {
    const r = this.db.prepare('SELECT values_enc FROM environments WHERE id = ?').get(id) as { values_enc: string | null } | undefined;
    if (!r) return null;
    const v = this.cipher.decNullable(r.values_enc, A_ENV);
    return v ? JSON.parse(v) : [];
  }
  importEnvironment(env: ParsedEnvironment): { id: number; created: boolean } {
    const enc = this.cipher.encNullable(JSON.stringify(env.values), A_ENV);
    const existing = this.db.prepare('SELECT id FROM environments WHERE (postman_id IS NOT NULL AND postman_id = ?) OR (postman_id IS NULL AND name = ?)').get(env.postmanId, env.name) as
      | { id: number }
      | undefined;
    if (existing) {
      this.db.prepare('UPDATE environments SET name = ?, values_enc = ?, imported_at = ? WHERE id = ?').run(env.name, enc, Date.now(), existing.id);
      return { id: existing.id, created: false };
    }
    const id = Number(this.db.prepare('INSERT INTO environments (name, postman_id, values_enc, imported_at) VALUES (?, ?, ?, ?)').run(env.name, env.postmanId, enc, Date.now()).lastInsertRowid);
    return { id, created: true };
  }
  updateEnvironmentValues(id: number, values: KV[]): boolean {
    return this.db.prepare('UPDATE environments SET values_enc = ? WHERE id = ?').run(this.cipher.encNullable(JSON.stringify(values), A_ENV), id).changes > 0;
  }
  deleteEnvironment(id: number): boolean {
    return this.db.prepare('DELETE FROM environments WHERE id = ?').run(id).changes > 0;
  }

  // ---- saved requests ----
  listSaved() {
    return this.db
      .prepare(
        `SELECT s.id, s.name, s.collection_id AS collectionId, s.collection_request_id AS collectionRequestId, s.match_key AS matchKey,
                s.profile_id AS profileId, s.authorization_id AS authorizationId, s.request, s.updated_at AS updatedAt,
                (s.collection_id IS NOT NULL AND s.collection_request_id IS NULL) AS orphaned
         FROM saved_requests s ORDER BY s.name COLLATE NOCASE`,
      )
      .all()
      .map((r: any) => ({ ...r, orphaned: !!r.orphaned, request: JSON.parse(r.request) }));
  }
  getSaved(id: number) {
    return this.listSaved().find((s: any) => s.id === id) ?? null;
  }
  saveRequest(p: { id?: number; name: string; collectionRequestId?: number | null; profileId?: number | null; authorizationId?: number | null; request: unknown }): number {
    const now = Date.now();
    let collectionId: number | null = null;
    let matchKey: string | null = null;
    if (p.collectionRequestId) {
      const cr = this.db.prepare('SELECT collection_id, match_key FROM collection_requests WHERE id = ?').get(p.collectionRequestId) as { collection_id: number; match_key: string } | undefined;
      if (cr) {
        collectionId = cr.collection_id;
        matchKey = cr.match_key;
      }
    }
    if (p.id) {
      const prev = this.db.prepare('SELECT collection_id, match_key, collection_request_id FROM saved_requests WHERE id = ?').get(p.id) as any;
      this.db
        .prepare('UPDATE saved_requests SET name = ?, collection_id = ?, collection_request_id = ?, match_key = ?, profile_id = ?, authorization_id = ?, request = ?, updated_at = ? WHERE id = ?')
        .run(
          p.name,
          collectionId ?? prev?.collection_id ?? null,
          p.collectionRequestId ?? prev?.collection_request_id ?? null,
          matchKey ?? prev?.match_key ?? null,
          p.profileId ?? null,
          p.authorizationId ?? null,
          JSON.stringify(p.request),
          now,
          p.id,
        );
      return p.id;
    }
    return Number(
      this.db
        .prepare('INSERT INTO saved_requests (name, collection_id, collection_request_id, match_key, profile_id, authorization_id, request, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.name, collectionId, p.collectionRequestId ?? null, matchKey, p.profileId ?? null, p.authorizationId ?? null, JSON.stringify(p.request), now, now).lastInsertRowid,
    );
  }
  deleteSaved(id: number): boolean {
    return this.db.prepare('DELETE FROM saved_requests WHERE id = ?').run(id).changes > 0;
  }
}
