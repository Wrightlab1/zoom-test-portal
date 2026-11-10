import { EventEmitter } from 'node:events';
import type { AppConfig } from './config.js';
import type { DB } from './db/index.js';
import type { Cipher } from './lib/crypto.js';
import type { SettingsRepo } from './db/settings.js';
import type { AdminRepo } from './db/sessions.js';
import type { Services } from './services/index.js';

/** Events pushed to the admin UI over SSE. */
export interface BusEvents {
  webhook: [Record<string, unknown>];
  token: [{ profileId: number; authorizationId?: number | null; kind: string }];
  tunnel: [Record<string, unknown>];
  call: [Record<string, unknown>];
}

export class Bus extends EventEmitter<BusEvents> {
  constructor() {
    super();
    this.setMaxListeners(100); // one set per open SSE connection
  }
}

/** Shared application context: configuration, storage and services. */
export interface Ctx {
  cfg: AppConfig;
  db: DB;
  cipher: Cipher;
  settings: SettingsRepo;
  adminRepo: AdminRepo;
  bus: Bus;
  /** One-time code printed to the console, required to set the first password. */
  setupCode: string | null;
  services: Services;
}
