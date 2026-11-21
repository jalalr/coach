import { json } from './coach-api.mjs';

function supportedEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1400) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      (['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname) ||
        /\.(push\.apple\.com|notify\.windows\.com|push\.microsoft\.com)$/.test(url.hostname));
  } catch { return false; }
}

function validSchedule(zone, minute) {
  if (typeof zone !== 'string' || zone.length > 100 || !Number.isInteger(minute) || minute < 0 || minute >= 1440) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
  catch { return false; }
}

export function createReminders({ supabaseUrl, serviceKey, vapid, jobKey, buildPushPayload }) {
  if (!serviceKey || !vapid.publicKey || !vapid.privateKey || !vapid.subject || !jobKey) return null;
  const headers = { apikey: serviceKey, ...(!serviceKey.startsWith('sb_secret_') && { Authorization: `Bearer ${serviceKey}` }) };

  async function database(path, params = {}, method = 'GET', body) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}?${new URLSearchParams(params)}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Reminder database request failed');
    }
    return response.status === 204 ? [] : response.json();
  }

  const table = 'coach_push_subscriptions';
  const filters = (user, endpoint) => ({ user_id: `eq.${user}`, endpoint: `eq.${endpoint}` });

  async function deliver(subscription, test = false) {
    if (!supportedEndpoint(subscription.endpoint)) return 410;
    const request = await buildPushPayload({ data: JSON.stringify({ test }), options: { ttl: 1800 } }, subscription, vapid);
    const response = await fetch(subscription.endpoint, { ...request, redirect: 'error', signal: AbortSignal.timeout(9000) });
    await response.body?.cancel();
    return response.status;
  }

  async function manage(value, userId) {
    if (value?.action === 'key') return json(200, { publicKey: vapid.publicKey });
    const { action, endpoint, timeZone, minute, subscription } = value ?? {};
    if (!supportedEndpoint(endpoint)) return json(400, { error: 'This browser’s push endpoint is unsupported.' });
    const where = filters(userId, endpoint);
    try {
      if (action === 'status') {
        const [saved] = await database(table, { ...where, select: 'minute_of_day,time_zone', limit: 1 });
        return json(200, { saved: saved ?? null });
      }
      if (action === 'disable') {
        await database(table, where, 'DELETE');
        return json(200, { enabled: false });
      }
      if (action === 'save') {
        const p256dh = subscription?.keys?.p256dh;
        const auth = subscription?.keys?.auth;
        if (!validSchedule(timeZone, minute) || subscription?.endpoint !== endpoint ||
            !/^[A-Za-z0-9_-]{87}$/.test(p256dh ?? '') || !/^[A-Za-z0-9_-]{22}$/.test(auth ?? '')) {
          return json(400, { error: 'Choose a time and enable notifications on this device.' });
        }
        await database(table, { on_conflict: 'user_id,endpoint' }, 'POST', {
          user_id: userId, endpoint, time_zone: timeZone, minute_of_day: minute,
          subscription: { endpoint, keys: { p256dh, auth } },
        });
        return json(200, { enabled: true });
      }
      if (action === 'test') {
        const cutoff = new Date(Date.now() - 30000).toISOString();
        const [row] = await database(table, { ...where, or: `(tested_at.is.null,tested_at.lt.${cutoff})` }, 'PATCH', { tested_at: new Date().toISOString() });
        if (!row) return json(429, { error: 'Enable reminders first, or wait 30 seconds before testing again.' });
        const status = await deliver(row.subscription, true);
        if ([404, 410].includes(status)) {
          await database(table, where, 'DELETE');
          return json(410, { error: 'This registration has expired. Turn reminders off and enable them again.' });
        }
        if (status >= 200 && status < 300) return json(200, { sent: true });
        throw new Error('Test notification delivery failed');
      }
      return json(400, { error: 'Choose an available reminder action.' });
    } catch {
      return json(502, { error: 'Coach could not save or send your reminder. Try again.' });
    }
  }

  async function run(authorization) {
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (provided.length !== jobKey.length) return json(401, { error: 'Scheduler authorization required.' });
    let difference = 0;
    for (let index = 0; index < jobKey.length; index++) difference |= provided.charCodeAt(index) ^ jobKey.charCodeAt(index);
    if (difference) return json(401, { error: 'Scheduler authorization required.' });
    try {
      const due = await database('rpc/claim_coach_push_reminders', {}, 'POST', {});
      const results = await Promise.allSettled(due.map(async row => {
        const status = await deliver(row.subscription);
        const where = filters(row.user_id, row.endpoint);
        if (status >= 200 && status < 300) {
          await database(table, where, 'PATCH', { last_sent_day: row.reminder_day });
          return true;
        }
        if ([404, 410].includes(status)) await database(table, where, 'DELETE');
        return false;
      }));
      return json(200, { claimed: due.length, delivered: results.filter(result => result.status === 'fulfilled' && result.value).length });
    } catch {
      return json(502, { error: 'The reminder job could not finish.' });
    }
  }

  return { manage, run };
}
