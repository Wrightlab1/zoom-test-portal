import type { Ctx } from '../context.js';

export interface ProfileUrls {
  base: string;
  redirectUri: string;
  webhookUrl: string;
}

/**
 * The single source of truth for public URLs. The OAuth redirect URI is always derived from the
 * current base, so the authorize request and the token exchange agree.
 */
export class PublicUrls {
  private tunnelUrl: string | null = null;
  constructor(private ctx: Ctx) {}

  setTunnelUrl(url: string | null) {
    this.tunnelUrl = url ? url.replace(/\/+$/, '') : null;
  }

  base(): string | null {
    const o = this.ctx.settings.get().publicBaseUrlOverride.trim();
    if (o) return o.replace(/\/+$/, '');
    return this.tunnelUrl;
  }

  source(): 'override' | 'tunnel' | 'none' {
    if (this.ctx.settings.get().publicBaseUrlOverride.trim()) return 'override';
    return this.tunnelUrl ? 'tunnel' : 'none';
  }

  static redirectPath = (slug: string) => `/oauth/callback/${slug}`;
  static webhookPath = (slug: string) => `/webhooks/zoom/${slug}`;

  forProfile(slug: string, base = this.base()): ProfileUrls | null {
    if (!base) return null;
    return { base, redirectUri: base + PublicUrls.redirectPath(slug), webhookUrl: base + PublicUrls.webhookPath(slug) };
  }
}
