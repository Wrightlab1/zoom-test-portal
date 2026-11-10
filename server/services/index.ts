import type { Ctx } from '../context.js';
import { ProfilesRepo } from '../db/profiles.js';
import { AuthorizationsRepo } from '../db/authorizations.js';
import { CallsRepo } from '../db/calls.js';
import { CallLogger } from './callLog.js';
import { ZoomOAuthClient } from './oauthClient.js';
import { TokenService } from './tokens.js';
import { secrets } from '../lib/redact.js';
import { PublicUrls } from './publicUrls.js';

/** All long-lived services, constructed once per app. */
export class Services {
  readonly profiles: ProfilesRepo;
  readonly auths: AuthorizationsRepo;
  readonly calls: CallsRepo;
  readonly callLog: CallLogger;
  readonly oauth: ZoomOAuthClient;
  readonly tokens: TokenService;
  readonly publicUrls: PublicUrls;
  private timers: NodeJS.Timeout[] = [];

  constructor(readonly ctx: Ctx) {
    this.profiles = new ProfilesRepo(ctx.db, ctx.cipher);
    this.auths = new AuthorizationsRepo(ctx.db, ctx.cipher);
    this.calls = new CallsRepo(ctx.db);
    this.callLog = new CallLogger(this.calls, ctx.bus, () => ctx.settings.get().maxStoredBodyBytes);
    this.oauth = new ZoomOAuthClient(ctx, this.profiles, this.callLog);
    this.tokens = new TokenService(ctx, this.profiles, this.auths, this.oauth);
    this.publicUrls = new PublicUrls(ctx);

    // Every stored secret is known to the redactor before any request is handled.
    this.profiles.registerSecrets();
    this.auths.registerSecrets();
    secrets.add(ctx.settings.getSecret('ngrokAuthtoken'));
  }

  async startBackground(): Promise<void> {
    if (this.ctx.cfg.disableSchedulers) return;
    this.every(30_000, () => this.tokens.tick());
    void this.tokens.tick().catch(() => {});
  }

  async stopBackground(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  protected every(ms: number, fn: () => unknown) {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error('[scheduler]', e instanceof Error ? e.message : e));
    }, ms);
    t.unref();
    this.timers.push(t);
  }
}

export function createServices(ctx: Ctx): Services {
  return new Services(ctx);
}
