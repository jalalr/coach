import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { questions, answerKeys, citation, originalRecording } from './pilot-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [definition, scenario] = questions;
const feedback = {
  [definition.id]: 'The recording identifies two distinct variables: willingness to learn and willingness to accept change.',
  [scenario.id]: 'Asking for feedback shows willingness to learn. Trying a change in response to the feedback tests willingness to accept change.',
};
const summary = 'The teachability index asks you to consider two things: how willing you are to learn, and how willing you are to accept change. You can be open to hearing feedback and still be reluctant to change a habit.';
const exercise = 'Pick one skill you’re practising. Name a piece of feedback you’re open to hearing, then choose one small change you can try in your next practice session.';
const recording = process.env.COACH_SOURCE_AUDIO ? resolve(process.env.COACH_SOURCE_AUDIO) : resolve(root, originalRecording);
const previewOrigin = process.env.COACH_PHONE_PREVIEW_ORIGIN?.trim();
const recordingAvailable = !previewOrigin && existsSync(recording);
const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'],
  '/account.js': ['account.js', 'text/javascript'] };
const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim().replace(/\/$/, '');
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)?.trim();
const ownerEmail = process.env.COACH_OWNER_EMAIL?.trim().toLowerCase();
const accountConfig = supabaseUrl || publishableKey || ownerEmail ? { supabaseUrl, publishableKey } : null;
if (accountConfig && (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl) || !publishableKey?.startsWith('sb_publishable_') || !ownerEmail)) {
  throw new Error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and COACH_OWNER_EMAIL together.');
}
if (previewOrigin && (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(previewOrigin) || !accountConfig)) {
  throw new Error('A phone preview requires Supabase sign-in and its exact HTTPS tunnel origin.');
}

async function authorize(request, response) {
  if (!accountConfig) return true;
  const { authorization } = request.headers;
  if (!authorization?.startsWith('Bearer ')) {
    json(response, 401, { error: 'Sign in to use this pilot.' });
    return false;
  }
  try {
    const remote = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { authorization, apikey: publishableKey }, signal: AbortSignal.timeout(8000),
    });
    if (remote.ok) {
      const user = await remote.json();
      if (user.email_confirmed_at && user.email?.toLowerCase() === ownerEmail) return true;
    }
    json(response, 403, { error: 'This account does not have access to the pilot.' });
  } catch {
    json(response, 502, { error: 'Sign-in could not be verified. Try again.' });
  }
  return false;
}
const replies = {
  example: 'Suppose you ask for feedback on a presentation. Listening to the feedback is willingness to learn. Trying a shorter introduction at your next rehearsal is a way to demonstrate willingness to accept change.',
  exercise,
  summary,
  prompt: 'Try asking me to explain the teachability index, give a feedback example, or suggest a way to practise it.',
};
const speech = new Map(Object.entries(replies).map(([id, text]) => [`reply:${id}`, text]));
for (const { id, prompt, choices } of questions) {
  speech.set(`question:${id}`, [prompt, ...choices.map(choice => `Option ${choice.id.toUpperCase()}. ${choice.text}`)].join(' '));
  speech.set(`feedback:${id}`, feedback[id]);
}
const speechCache = new Map();

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

async function synthesize(text) {
  const apiKey = getVoiceKey();
  if (!apiKey) return null;
  const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&mip_opt_out=true', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) {
    await response.body?.cancel();
    throw new Error(`Voice API status ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function playSpeech(response, id) {
  if (!speech.has(id)) return json(response, 400, { error: 'Choose available text to read aloud.' });
  if (!speechCache.has(id)) speechCache.set(id, synthesize(speech.get(id)));
  try {
    const audio = await speechCache.get(id);
    if (!audio) {
      speechCache.delete(id);
      return json(response, 503, { error: 'Set DEEPGRAM_API_KEY on the local server to enable read-aloud.' });
    }
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
    return response.end(audio);
  } catch {
    speechCache.delete(id);
    return json(response, 502, { error: 'The voice service is unavailable. Try again in a moment.' });
  }
}

function coach(question) {
  if (/example|scenario|feedback|habit/.test(question)) return 'example';
  if (/practice|practise|apply|improve|exercise|use it|try/.test(question)) return 'exercise';
  if (/teachab|learn|chang|variable|willing|index|explain|summari[sz]e|lesson/.test(question)) return 'summary';
  return 'prompt';
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('Request is too large');
  }
  return JSON.parse(body);
}

async function sendSignInEmail(response, email) {
  if (!accountConfig) return json(response, 404, { error: 'Sign-in is unavailable in local mode.' });
  if (typeof email !== 'string' || email.trim().toLowerCase() !== ownerEmail) {
    return json(response, 403, { error: 'Use the email configured for this private pilot.' });
  }
  try {
    const upstream = await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, create_user: true }),
      signal: AbortSignal.timeout(12000),
    });
    if (upstream.ok) return json(response, 200, { sent: true });
    const problem = await upstream.json();
    if (upstream.status === 429) return json(response, 429, { error: 'Supabase is limiting sign-in emails. Wait a minute and try again.' });
    if (['signup_disabled', 'otp_disabled', 'email_provider_disabled', 'email_address_not_authorized'].includes(problem.error_code)) {
      return json(response, 422, { error: problem.msg || problem.message || 'Check the email settings in your Supabase project.' });
    }
    return json(response, 502, { error: 'Supabase could not send the sign-in email. Try again or check the project’s Auth logs.' });
  } catch {
    return json(response, 502, { error: 'Could not reach Supabase to send the sign-in email. Try again.' });
  }
}

function audio(request, response) {
  const size = statSync(recording).size;
  const range = request.headers.range;
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  if (!range) {
    response.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(recording).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  createReadStream(recording, { start, end }).pipe(response);
}

const port = Number(process.env.PILOT_PORT || 4173);
const authority = `127.0.0.1:${port}`;
const publicAuthority = previewOrigin ? new URL(previewOrigin).host : null;
createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const allowedHost = request.headers.host === authority || request.headers.host === publicAuthority;
  const allowedOrigin = !request.headers.origin || request.headers.origin === `http://${authority}` || request.headers.origin === previewOrigin;
  if (!allowedHost || !allowedOrigin) {
    return json(response, 403, { error: 'Use the pilot’s local address.' });
  }
  if (request.method === 'GET') {
    if (request.url === '/api/config') return json(response, 200, { account: accountConfig });
    if (request.url === '/supabase.js' && accountConfig) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      createReadStream(new URL('./node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url)).pipe(response);
      return;
    }
    if (['/api/lesson', '/source-audio'].includes(request.url)) {
      if (!await authorize(request, response)) return;
      if (request.url === '/api/lesson') return json(response, 200, { summary, exercise, questions, citation, recordingAvailable });
      if (!recordingAvailable) return json(response, 404, { error: 'Source audio is available from the original course folder.' });
      return audio(request, response);
    }
    if (Object.hasOwn(files, request.url)) {
      const [name, type] = files[request.url];
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      createReadStream(new URL(`./dist/${name}`, import.meta.url)).pipe(response);
      return;
    }
  }
  if (request.method === 'POST' && ['/api/sign-in-email', '/api/coach', '/api/grade', '/api/speech'].includes(request.url)) {
    if (request.url !== '/api/sign-in-email' && !await authorize(request, response)) return;
    let body;
    try { body = await readBody(request); } catch { return json(response, 400, { error: 'Invalid request.' }); }
    if (request.url === '/api/sign-in-email') return sendSignInEmail(response, body?.email);
    if (request.url === '/api/speech') return playSpeech(response, body?.id);
    if (request.url === '/api/coach' && typeof body?.question === 'string' && body.question.trim()) {
      const reply = coach(body.question.toLowerCase());
      return json(response, 200, { reply: replies[reply], speechId: `reply:${reply}` });
    }
    if (request.url === '/api/grade') {
      const question = questions.find(item => item.id === body?.id);
      if (question?.choices.some(choice => choice.id === body.choice)) {
        const correct = body.choice === answerKeys[question.id];
        return json(response, 200, { correct, feedback: feedback[question.id] });
      }
    }
    return json(response, 400, { error: 'Choose a valid answer or enter a question.' });
  }
  return json(response, 404, { error: 'Page unavailable.' });
}).listen(port, '127.0.0.1', () => console.log(`Level 1 pilot: http://${authority}`));
