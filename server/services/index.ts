import type { Ctx } from '../context.js';

/** All long-lived services. Each stage adds to this. */
export class Services {
  private timers: NodeJS.Timeout[] = [];
  constructor(readonly ctx: Ctx) {}

  async startBackground(): Promise<void> {
    if (this.ctx.cfg.disableSchedulers) return;
  }

  async stopBackground(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  protected every(ms: number, fn: () => unknown) {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error('[scheduler]', e));
    }, ms);
    t.unref();
    this.timers.push(t);
  }
}

export function createServices(ctx: Ctx): Services {
  return new Services(ctx);
}
