import { resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

const mimeTypes: Record<string, string> = {
  wasm: 'application/wasm', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8', json: 'application/json', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon',
};
const routes = new Set(['/', '/tasks', '/focus', '/calendar', '/settings']);

export function previewHandler(directory = resolve('dist/web')) {
  const root = resolve(directory);
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    const respond = (message: string, status: number) => new Response(request.method === 'HEAD' ? null : message, { status, headers });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD');
      return respond('Method not allowed', 405);
    }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return respond('Invalid path', 400); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return respond('Invalid path', 400);
    const path = resolve(root, `.${routes.has(pathname) ? '/index.html' : pathname}`);
    if (!path.startsWith(`${root}${sep}`)) return respond('Forbidden', 403);
    const file = Bun.file(path);
    if (!(await file.exists())) return respond('Not found', 404);
    // realpath also prevents a symlink inside the export from exposing files outside it.
    const actualPath = await realpath(path);
    if (!actualPath.startsWith(`${root}${sep}`)) return respond('Forbidden', 403);
    headers.set('Content-Type', mimeTypes[path.split('.').pop() ?? ''] ?? 'application/octet-stream');
    headers.set('Content-Length', String(file.size));
    return new Response(request.method === 'HEAD' ? null : file, { headers });
  };
}

if (import.meta.main) {
  if (!(await Bun.file('dist/web/index.html').exists())) throw new Error('Run bun run export:web before starting the preview.');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 8100, fetch: previewHandler() });
  console.log(`Web preview: ${server.url}`);
}
