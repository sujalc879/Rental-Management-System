import { resolve } from 'node:path';
import { openDatabase } from '../../../packages/db/src/index';
import { createApp } from './app';
import { readConfig } from './config';

const config = readConfig();
const db = openDatabase();
const { app } = createApp(db, config);
const web = resolve('apps/web/dist');

const server = Bun.serve({
  hostname: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1',
  port: config.API_PORT,
  maxRequestBodySize: 256 * 1024,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/health' || path === '/ready') {
      if (!config.TRUSTED_PROXY_IP_HEADER) {
        const headers = new Headers(request.headers);
        headers.set('x-rental-client-ip', server.requestIP(request)?.address ?? '127.0.0.1');
        return app.fetch(new Request(request, { headers }));
      }
      return app.fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const asset = /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path);
    const file = Bun.file(`${web}${asset ? path : '/index.html'}`);
    if (!await file.exists()) return new Response('Page unavailable', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : file, { headers: {
      'Content-Type': file.type,
      'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      ...(config.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    } });
  },
});
console.log(JSON.stringify({ event: 'api.started', port: server.port }));
async function stop() { await server.stop(); await db.$disconnect(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
