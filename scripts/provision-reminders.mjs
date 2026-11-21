import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim().replace(/\/$/, '');
const project = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url ?? '')?.[1];
const token = process.env.SUPABASE_ACCESS_TOKEN;
const [expected, mode] = process.argv.slice(2);
if (!token || !project || expected !== project || !['prepare', 'schedule'].includes(mode)) {
  throw new Error('Provide the expected Supabase project reference and either prepare or schedule.');
}

async function management(path, method, data) {
  const result = await fetch(`https://api.supabase.com/v1/projects/${project}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!result.ok) {
    await result.body?.cancel();
    throw Error(`Supabase ${path} returned HTTP ${result.status}.`);
  }
  const response = await result.text();
  return response ? JSON.parse(response) : null;
}
const query = (query, parameters) => management('database/query', 'POST', { query, parameters });
const vaultName = 'coach_daily_reminders_job_key';
const runner = `${url}/functions/v1/coach-pilot/api/jobs/daily-reminders`;

if (mode === 'prepare') {
  await query(await readFile(new URL('../supabase/migrations/202611210002_daily_reminders.sql', import.meta.url), 'utf8'));
  let [{ decrypted_secret: jobKey } = {}] = await query('select decrypted_secret from vault.decrypted_secrets where name = $1::text', [vaultName]);
  if (!jobKey) {
    jobKey = randomBytes(32).toString('base64url');
    await query('select vault.create_secret($1::text, $2::text)', [jobKey, vaultName]);
  }

  const names = new Set((await management('secrets', 'GET')).map(secret => secret.name));
  const publicExists = names.has('COACH_PUSH_PUBLIC_KEY');
  const privateExists = names.has('COACH_PUSH_PRIVATE_KEY');
  if (publicExists !== privateExists) throw new Error('A VAPID key is missing. Recover the pair before continuing.');
  const values = { COACH_REMINDER_JOB_KEY: jobKey };
  if (!publicExists) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { x, y, d } = privateKey.export({ format: 'jwk' });
    values.COACH_PUSH_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');
    values.COACH_PUSH_PRIVATE_KEY = d;
  }
  await management('secrets', 'POST', Object.entries(values).map(([name, value]) => ({ name, value })));
  console.log('Prepared reminder storage and installed private signing and scheduler keys.');
} else {
  const probe = await fetch(runner, { method: 'POST', signal: AbortSignal.timeout(10000) });
  if (probe.status !== 401) throw new Error(`The live reminder job is not ready (HTTP ${probe.status}).`);
  const command = `select net.http_post(
    url := '${runner}',
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret.decrypted_secret),
    timeout_milliseconds := 25000
  ) from vault.decrypted_secrets secret
  where secret.name = '${vaultName}' and exists (select 1 from public.coach_push_subscriptions)`;
  await query("select cron.schedule('coach-daily-reminders', '*/5 * * * *', $1::text)", [command]);
  console.log('Scheduled the reminder dispatcher. It sends only to devices the owner enables.');
}
