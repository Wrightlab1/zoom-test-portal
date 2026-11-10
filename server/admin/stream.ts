import type { FastifyInstance } from 'fastify';
import type { Ctx, BusEvents } from '../context.js';

/** Server-Sent Events: live webhooks, token events, tunnel state and new API calls. */
export function registerStreamRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const names: (keyof BusEvents)[] = ['webhook', 'token', 'tunnel', 'call'];
    const handlers = names.map((name) => {
      const fn = (data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ctx.bus.on(name, fn as never);
      return [name, fn] as const;
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    ping.unref();
    const close = () => {
      clearInterval(ping);
      for (const [name, fn] of handlers) ctx.bus.off(name, fn as never);
    };
    req.raw.on('close', close);
  });
}
