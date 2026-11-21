import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createCoachApi, json } from './supabase/functions/_shared/coach-api.mjs';
import { originalRecording } from './supabase/functions/_shared/pilot-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const recording = process.env.COACH_SOURCE_AUDIO ? resolve(process.env.COACH_SOURCE_AUDIO) : resolve(root, originalRecording);
const previewOrigin = process.env.COACH_PHONE_PREVIEW_ORIGIN?.trim();
const recordingAvailable = !previewOrigin && existsSync(recording);
const files = {
  '/': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/account.js': ['account.js', 'text/javascript'],
  '/host-config.js': ['host-config.js', 'text/javascript'],
  '/course-library.js': ['course-library.js', 'text/javascript'],
  '/install.js': ['install.js', 'text/javascript'],
  '/service-worker.js': ['service-worker.js', 'text/javascript'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/coach-180.png': ['coach-180.png', 'image/png'],
  '/coach-192.png': ['coach-192.png', 'image/png'],
  '/coach-512.png': ['coach-512.png', 'image/png'],
};
const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim().replace(/\/$/, '');
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)?.trim();
const ownerEmail = process.env.COACH_OWNER_EMAIL?.trim().toLowerCase();
const account = supabaseUrl || publishableKey || ownerEmail ? { supabaseUrl, publishableKey } : null;
if (account && (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl) || !publishableKey?.startsWith('sb_publishable_') || !ownerEmail)) {
  throw new Error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and COACH_OWNER_EMAIL together.');
}
if (previewOrigin && (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(previewOrigin) || !account)) {
  throw new Error('A phone preview requires Supabase sign-in and its exact HTTPS tunnel origin.');
}

function getVoiceKey() {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY.trim();
  if (process.platform !== 'win32') return '';
  try {
    const value = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'DEEPGRAM_API_KEY'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return value.match(/^\s*DEEPGRAM_API_KEY\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/m)?.[1].trim() ?? '';
  } catch { return ''; }
}

const api = createCoachApi({ account, ownerEmail, recordingAvailable, getVoiceKey });

function audio(request, response) {
  const size = statSync(recording).size;
  const range = request.headers.range;
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (!range) {
    response.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(recording).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end) {
    response.writeHead(416, { 'Content-Range': 'bytes */' + size }).end();
    return;
  }
  response.writeHead(206, {
    ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1,
  });
  createReadStream(recording, { start, end }).pipe(response);
}

function send(response, result) {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (result.body) Readable.fromWeb(result.body).pipe(response);
  else response.end();
}

const port = Number(process.env.PILOT_PORT || 4173);
const authority = '127.0.0.1:' + port;
const localOrigin = 'http://' + authority;
const publicAuthority = previewOrigin ? new URL(previewOrigin).host : null;
createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const allowedHost = request.headers.host === authority || request.headers.host === publicAuthority;
  const allowedOrigin = !request.headers.origin || request.headers.origin === localOrigin || request.headers.origin === previewOrigin;
  if (!allowedHost || !allowedOrigin) return send(response, json(403, { error: 'Use the pilot’s local address.' }));
  if (request.method === 'GET') {
    if (request.url === '/supabase.js' && account) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      createReadStream(new URL('./node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url)).pipe(response);
      return;
    }
    if (request.url === '/source-audio') {
      const denied = await api.authorize(request.headers.authorization);
      if (denied) return send(response, denied);
      if (!recordingAvailable) return send(response, json(404, { error: 'Source audio is available from the original course folder.' }));
      return audio(request, response);
    }
    if (Object.hasOwn(files, request.url)) {
      const [name, type] = files[request.url];
      const contentType = type.startsWith('image/') ? type : type + '; charset=utf-8';
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      createReadStream(new URL('./dist/' + name, import.meta.url)).pipe(response);
      return;
    }
  }
  if (request.url?.startsWith('/api/')) {
    const options = { method: request.method, headers: request.headers };
    if (request.method === 'POST') Object.assign(options, { body: Readable.toWeb(request), duplex: 'half' });
    const result = await api.handle(new Request(localOrigin + request.url, options), request.url);
    return send(response, result);
  }
  return send(response, json(404, { error: 'Page unavailable.' }));
}).listen(port, '127.0.0.1', () => console.log('Level 1 pilot: ' + localOrigin));
