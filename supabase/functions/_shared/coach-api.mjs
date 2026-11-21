import { answerKeys, citation, questions } from './pilot-content.mjs';

const [definition, scenario] = questions;
const feedback = {
  [definition.id]: 'The recording identifies two distinct variables: willingness to learn and willingness to accept change.',
  [scenario.id]: 'Asking for feedback shows willingness to learn. Trying a change in response to the feedback tests willingness to accept change.',
};
const summary = 'The teachability index asks you to consider two things: how willing you are to learn, and how willing you are to accept change. You can be open to hearing feedback and still be reluctant to change a habit.';
const exercise = 'Pick one skill you’re practising. Name a piece of feedback you’re open to hearing, then choose one small change you can try in your next practice session.';
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

export function json(status, data) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function synthesizeSpeech(apiKey, text) {
  if (!apiKey) return null;
  const upstream = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&mip_opt_out=true', {
    method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(12000),
  });
  if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('audio/')) {
    await upstream.body?.cancel();
    throw new Error('Voice service did not return audio');
  }
  return upstream.arrayBuffer();
}

async function readBody(request) {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return JSON.parse(text + decoder.decode());
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new Error('Request is too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

function coach(question) {
  if (/example|scenario|feedback|habit/.test(question)) return 'example';
  if (/practice|practise|apply|improve|exercise|use it|try/.test(question)) return 'exercise';
  if (/teachab|learn|chang|variable|willing|index|explain|summari[sz]e|lesson/.test(question)) return 'summary';
  return 'prompt';
}

export function createCoachApi({ account, ownerEmail, recordingAvailable = false, getVoiceKey, signInRedirect, course, reminders }) {
  const speechCache = new Map();

  async function authRequest(path, options) {
    return fetch(`${account.supabaseUrl}/auth/v1/${path}`, {
      ...options, headers: { apikey: account.publishableKey, ...options.headers }, signal: AbortSignal.timeout(10000),
    });
  }

  async function authenticate(authorization) {
    if (!account) return {};
    if (!authorization?.startsWith('Bearer ')) return { denied: json(401, { error: 'Sign in to use this pilot.' }) };
    try {
      const remote = await authRequest('user', { headers: { authorization } });
      if (remote.ok) {
        const user = await remote.json();
        if (user.email_confirmed_at && user.email?.toLowerCase() === ownerEmail && user.id) return { user };
      }
      return { denied: json(403, { error: 'This account does not have access to the pilot.' }) };
    } catch {
      return { denied: json(502, { error: 'Sign-in could not be verified. Try again.' }) };
    }
  }

  async function sendSignInEmail(email) {
    if (!account) return json(404, { error: 'Sign-in is unavailable in local mode.' });
    if (typeof email !== 'string' || email.trim().toLowerCase() !== ownerEmail) {
      return json(403, { error: 'Use the email configured for this private pilot.' });
    }
    try {
      const endpoint = signInRedirect ? 'otp?' + new URLSearchParams({ redirect_to: signInRedirect }) : 'otp';
      const upstream = await authRequest(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ownerEmail, create_user: true }),
      });
      if (upstream.ok) return json(200, { sent: true });
      const problem = await upstream.json();
      if (upstream.status === 429) return json(429, { error: 'Supabase is limiting sign-in emails. Wait a minute and try again.' });
      if (['signup_disabled', 'otp_disabled', 'email_provider_disabled', 'email_address_not_authorized'].includes(problem.error_code)) {
        return json(422, { error: problem.msg || problem.message || 'Check the email settings in your Supabase project.' });
      }
      return json(502, { error: 'Supabase could not send the sign-in email. Try again or check the project’s Auth logs.' });
    } catch {
      return json(502, { error: 'Could not reach Supabase to send the sign-in email. Try again.' });
    }
  }

  async function playSpeech(id) {
    if (!speech.has(id)) return json(400, { error: 'Choose available text to read aloud.' });
    if (!speechCache.has(id)) speechCache.set(id, synthesizeSpeech(getVoiceKey(), speech.get(id)));
    try {
      const audio = await speechCache.get(id);
      if (!audio) {
        speechCache.delete(id);
        return json(503, { error: 'Set DEEPGRAM_API_KEY on the server to enable read-aloud.' });
      }
      return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
    } catch {
      speechCache.delete(id);
      return json(502, { error: 'The voice service is unavailable. Try again in a moment.' });
    }
  }

  async function handle(request, path) {
    if (request.method === 'GET' && path === '/api/config') return json(200, { account });
    if (request.method === 'POST' && path === '/api/jobs/daily-reminders') {
      return reminders ? reminders.run(request.headers.get('authorization')) : json(503, { error: 'Reminders are unavailable.' });
    }
    if (request.method === 'POST' && path === '/api/reminders') {
      const { user, denied } = await authenticate(request.headers.get('authorization'));
      if (denied) return denied;
      if (!reminders || !user) return json(503, { error: 'Reminders are unavailable.' });
      let body;
      try { body = await readBody(request); } catch { return json(400, { error: 'Invalid reminder settings.' }); }
      return reminders.manage(body, user.id);
    }
    if (path === '/api/course' && ['GET', 'POST'].includes(request.method)) {
      const { user, denied } = await authenticate(request.headers.get('authorization'));
      if (denied) return denied;
      if (!course || !user) return json(404, { error: 'The full course requires the hosted app.' });
      let body;
      if (request.method === 'POST') {
        try { body = await readBody(request); } catch { return json(400, { error: 'Invalid response.' }); }
      }
      return course(request.method, new URL(request.url), body, user.id);
    }
    const isLesson = request.method === 'GET' && path === '/api/lesson';
    const isWrite = request.method === 'POST' && ['/api/sign-in-email', '/api/coach', '/api/grade', '/api/speech'].includes(path);
    if (!isLesson && !isWrite) return json(404, { error: 'Page unavailable.' });
    if (path !== '/api/sign-in-email') {
      const { denied } = await authenticate(request.headers.get('authorization'));
      if (denied) return denied;
    }
    if (isLesson) return json(200, { summary, exercise, questions, citation, recordingAvailable });

    let body;
    try { body = await readBody(request); } catch { return json(400, { error: 'Invalid request.' }); }
    if (path === '/api/sign-in-email') return sendSignInEmail(body?.email);
    if (path === '/api/speech') return playSpeech(body?.id);
    if (path === '/api/coach' && typeof body?.question === 'string' && body.question.trim()) {
      const reply = coach(body.question.toLowerCase());
      return json(200, { reply: replies[reply], speechId: `reply:${reply}` });
    }
    if (path === '/api/grade') {
      const question = questions.find(item => item.id === body?.id);
      if (question?.choices.some(choice => choice.id === body.choice)) {
        return json(200, { correct: body.choice === answerKeys[question.id], feedback: feedback[question.id] });
      }
    }
    return json(400, { error: 'Choose a valid answer or enter a question.' });
  }

  return { authorize: async authorization => (await authenticate(authorization)).denied, handle };
}
