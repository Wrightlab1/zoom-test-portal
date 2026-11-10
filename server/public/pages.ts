const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, self-contained result page for the OAuth callback. Reveals nothing about the portal. */
export function callbackPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}
main{max-width:480px;padding:24px}h1{font-size:20px;margin:0 0 8px;color:${ok ? '#1a7f37' : '#cf222e'}}p{margin:0 0 8px}small{opacity:.7}</style></head>
<body><main><h1>${ok ? '✓ ' : '✕ '}${esc(title)}</h1><p>${esc(message)}</p><small>You can close this tab and return to the portal.</small></main></body></html>`;
}
