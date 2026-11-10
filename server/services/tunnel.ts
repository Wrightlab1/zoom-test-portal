import type { Ctx } from '../context.js';
import type { ProfilesRepo } from '../db/profiles.js';
import type { PublicUrls } from './publicUrls.js';
import { scrubString } from '../lib/redact.js';

export interface TunnelListener {
  url(): string | null;
  close(): Promise<void>;
}
export type Forwarder = (cfg: {
  addr: string;
  authtoken: string;
  domain?: string;
  onStatusChange?: (status: string) => void;
}) => Promise<TunnelListener>;

export type TunnelState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error';

export interface MarketplaceField {
  profileId: number;
  profileName: string;
  appType: 's2s' | 'user';
  field: string;
  value: string;
}

/** ngrok via the official SDK, pointed only at the public listener. */
export class TunnelService {
  private listener: TunnelListener | null = null;
  state: TunnelState = 'stopped';
  url: string | null = null;
  error: string | null = null;
  startedAt: number | null = null;
  private forwarder: Forwarder | null = null;

  constructor(
    private ctx: Ctx,
    private profiles: ProfilesRepo,
    private publicUrls: PublicUrls,
    /** host:port of the public listener, known once it is listening */
    private publicAddr: () => string,
  ) {}

  /** Tests inject a fake forwarder; production lazily loads @ngrok/ngrok. */
  setForwarder(f: Forwarder) {
    this.forwarder = f;
  }
  private async getForwarder(): Promise<Forwarder> {
    if (this.forwarder) return this.forwarder;
    const ngrok = await import('@ngrok/ngrok');
    return (cfg) => ngrok.forward({ ...cfg, proto: 'http' }) as unknown as Promise<TunnelListener>;
  }

  private emit() {
    this.ctx.bus.emit('tunnel', this.status() as unknown as Record<string, unknown>);
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    const authtoken = this.ctx.settings.getSecret('ngrokAuthtoken');
    if (!authtoken) throw new Error('Set your ngrok authtoken in Settings first.');
    const domain = this.ctx.settings.get().ngrokDomain.trim() || undefined;
    this.state = 'starting';
    this.error = null;
    this.emit();
    try {
      const forward = await this.getForwarder();
      this.listener = await forward({
        addr: this.publicAddr(),
        authtoken,
        domain,
        onStatusChange: (s) => {
          this.state = s === 'connected' ? 'running' : 'reconnecting';
          this.emit();
        },
      });
      this.url = this.listener.url();
      this.state = 'running';
      this.startedAt = Date.now();
      this.publicUrls.setTunnelUrl(this.url);
      this.ctx.db
        .prepare('INSERT INTO tunnel_history (started_at, url, reserved_domain) VALUES (?, ?, ?)')
        .run(this.startedAt, this.url ?? '', domain ?? null);
      // First time ever: there is nothing in Marketplace yet to be out of date.
      if (!this.ctx.settings.get().lastPublicUrl && this.url) this.ctx.settings.update({ lastPublicUrl: this.url });
    } catch (e) {
      this.state = 'error';
      this.error = scrubString((e as Error).message ?? String(e));
      this.listener = null;
      this.url = null;
      this.publicUrls.setTunnelUrl(null);
    }
    this.emit();
    if (this.state === 'error') throw new Error(this.error ?? 'ngrok failed to start');
  }

  async stop(): Promise<void> {
    const l = this.listener;
    this.listener = null;
    if (l) await l.close().catch(() => {});
    this.ctx.db.prepare('UPDATE tunnel_history SET stopped_at = ? WHERE stopped_at IS NULL').run(Date.now());
    this.state = 'stopped';
    this.url = null;
    this.startedAt = null;
    this.publicUrls.setTunnelUrl(null);
    this.emit();
  }

  /** Marketplace fields whose value comes from the public URL, for the current base. */
  marketplaceFields(base = this.publicUrls.base()): MarketplaceField[] {
    if (!base) return [];
    const out: MarketplaceField[] = [];
    for (const p of this.profiles.list()) {
      const u = this.publicUrls.forProfile(p.slug, base)!;
      if (p.type === 'user') {
        out.push({ profileId: p.id, profileName: p.name, appType: p.type, field: 'OAuth Redirect URL', value: u.redirectUri });
        out.push({ profileId: p.id, profileName: p.name, appType: p.type, field: 'OAuth Allow List', value: u.redirectUri });
      }
      out.push({ profileId: p.id, profileName: p.name, appType: p.type, field: 'Event Subscription — Event notification endpoint URL', value: u.webhookUrl });
    }
    return out;
  }

  /** The user confirms the Marketplace now has the current URL. */
  acknowledge(): void {
    const base = this.publicUrls.base();
    if (base) this.ctx.settings.update({ lastPublicUrl: base });
    this.emit();
  }

  status() {
    const s = this.ctx.settings.get();
    const base = this.publicUrls.base();
    const confirmed = s.lastPublicUrl || null;
    const changed = !!(base && confirmed && base !== confirmed);
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      startedAt: this.startedAt,
      reservedDomain: s.ngrokDomain || null,
      hasAuthtoken: !!this.ctx.settings.getSecret('ngrokAuthtoken'),
      forwardsTo: this.publicAddr(),
      publicBase: base,
      baseSource: this.publicUrls.source(),
      confirmedBase: confirmed,
      urlChanged: changed,
      needsUpdate: changed ? this.marketplaceFields(base) : [],
      ephemeralWarning: this.state === 'running' && !s.ngrokDomain,
    };
  }
}
