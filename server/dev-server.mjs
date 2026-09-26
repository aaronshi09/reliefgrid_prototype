/* ============================================================================
 * ReliefGrid — local development server (zero dependencies, Node 18+).
 *   npm run dev      →  http://localhost:8787
 * Serves the static site from the project root and mounts the same api/ai/*
 * handlers that deploy as serverless functions. Loads .env if present.
 * Never serves dotfiles (.env), server/ or api/ source.
 * ==========================================================================*/
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/* Minimal .env loader (KEY=value lines; existing env vars win). */
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const ROUTES = {
  '/api/ai/status': 'api/ai/status.js',
  '/api/ai/interpret': 'api/ai/interpret.js',
  '/api/ai/explain': 'api/ai/explain.js',
  '/api/ai/analyze': 'api/ai/analyze.js',
  '/api/ai/location-context': 'api/ai/location-context.js',
};
const handlers = {};
async function handlerFor(path) {
  if (!ROUTES[path]) return null;
  if (!handlers[path]) handlers[path] = (await import(pathToFileURL(join(ROOT, ROUTES[path])).href)).default;
  return handlers[path];
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};
const BLOCKED_PREFIXES = ['server', 'api', 'node_modules', 'scripts'];

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const parts = rel.split('/');
  if (parts.some(p => p.startsWith('.')) || BLOCKED_PREFIXES.includes(parts[0])) { res.statusCode = 404; return res.end('Not found'); }
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(normalize(ROOT + sep)) && file !== normalize(ROOT)) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    const s = await stat(file);
    const target = s.isDirectory() ? join(file, 'index.html') : file;
    const buf = await readFile(target);
    res.setHeader('Content-Type', TYPES[extname(target).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  } catch (_) { res.statusCode = 404; res.end('Not found'); }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    const h = await handlerFor(pathname);
    if (!h) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } })); }
    return h(req, res);
  }
  return serveStatic(req, res, pathname);
});

const PORT = Number(process.env.PORT) || 8787;
server.listen(PORT, () => {
  const g = process.env.GEMINI_API_KEY ? 'configured' : 'not set';
  const o = process.env.OPENAI_API_KEY ? 'configured' : 'not set';
  console.log(`ReliefGrid running at http://localhost:${PORT}`);
  console.log(`  GEMINI_API_KEY: ${g}   OPENAI_API_KEY: ${o}   (AI features without a key stay disabled)`);
});
