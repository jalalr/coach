import { createCoachApi, json } from '../_shared/coach-api.mjs';
import { createCourseApi } from '../_shared/course-api.mjs';

const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
const publishableKey = Deno.env.get('COACH_PUBLISHABLE_KEY') || keys.default || Object.values(keys)[0];
const ownerEmail = Deno.env.get('COACH_OWNER_EMAIL')?.trim().toLowerCase();
const webOrigin = Deno.env.get('COACH_WEB_ORIGIN')?.trim();
const serverKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const serviceKey = serverKeys.default || Object.values(serverKeys)[0] || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const getVoiceKey = () => Deno.env.get('COACH_DEEPGRAM_API_KEY');
const api = supabaseUrl && typeof publishableKey === 'string' && ownerEmail
  ? createCoachApi({
    account: { supabaseUrl, publishableKey },
    ownerEmail,
    getVoiceKey,
    signInRedirect: webOrigin ? new URL('/', webOrigin).href : undefined,
    course: createCourseApi({ supabaseUrl, serviceKey, getVoiceKey }),
  })
  : null;

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  if (origin && origin !== webOrigin) return json(403, { error: 'Open the configured Coach web address.' });

  const path = new URL(request.url).pathname.replace(/^\/(?:functions\/v1\/)?coach-pilot(?=\/|$)/, '');
  let response;
  if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
  else if (!api) response = json(503, { error: 'Coach is awaiting server configuration.' });
  else response = await api.handle(request, path);

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Vary', 'Origin');
  if (origin && origin === webOrigin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
  }
  return response;
});
