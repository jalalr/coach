import { readFile } from 'node:fs/promises';
import { dailySets } from '../supabase/functions/_shared/course-api.mjs';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim().replace(/\/$/, '');
const project = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(supabaseUrl ?? '')?.[1];
if (!project || !process.env.SUPABASE_ACCESS_TOKEN) throw new Error('Set the project URL and management token to import the course.');
if (process.argv[2] !== project) throw new Error('Pass the expected Supabase project reference to confirm the import target.');

const packageUrl = new URL('../.course-import/documents.json', import.meta.url);
const { revision, documents } = JSON.parse(await readFile(packageUrl, 'utf8'));
if (!/^[0-9a-f]{20}$/.test(revision) || !documents.some(document => document.id === 'index')) throw new Error('Invalid course package.');
const endpoint = `https://api.supabase.com/v1/projects/${project}/database/query`;

async function query(query, parameters) {
  const result = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, parameters }),
  });
  if (!result.ok) {
    const problem = await result.json().catch(() => ({}));
    const detail = [problem.message, problem.error].find(text => typeof text === 'string') ?? '';
    const diagnosis = detail.match(/cannot extract elements from (?:an object|a scalar)|division by zero|duplicate key|permission denied/i)?.[0];
    throw new Error(`Supabase database import returned HTTP ${result.status}${diagnosis ? ` (${diagnosis})` : ''}.`);
  }
  return result.json();
}

const migration = await readFile(new URL('../supabase/migrations/202611210001_success_mastery.sql', import.meta.url), 'utf8');
await query(migration);
const upsert = `insert into public.coach_course_documents (revision, document_id, payload)
  select $1::text, item->>'id', item->'payload' from jsonb_array_elements($2::jsonb) as data(item)
  on conflict (revision, document_id) do update set payload = excluded.payload`;

const batches = [];
let batch = [];
let size = 0;
for (const document of documents) {
  const bytes = Buffer.byteLength(JSON.stringify(document));
  if (batch.length && size + bytes > 160000) {
    batches.push(batch);
    batch = [];
    size = 0;
  }
  batch.push(document);
  size += bytes;
}
if (batch.length) batches.push(batch);
for (const group of batches) await query(upsert, [revision, JSON.stringify(group)]);

const rows = await query('select count(*)::int as count from public.coach_course_documents where revision = $1::text', [revision]);
if (rows[0]?.count !== documents.length) throw new Error('The imported document count differs from the local package.');
const publish = `with previous as (
    select payload->>'revision' as revision from public.coach_course_documents
    where revision = 'published' and document_id = 'active' and payload->>'revision' <> $1::text
  ), order_documents as materialized (
    select document_id, payload from public.coach_course_documents
    where revision = $1::text and document_id like 'order:%' and jsonb_typeof(payload) = 'array'
  ), pool_documents as materialized (
    select document_id, payload from public.coach_course_documents
    where revision = $1::text and document_id like 'pool:%' and jsonb_typeof(payload) = 'array'
  ), retained as (
    select 'lessons' as section, substring(document_id from 8) as item_id from public.coach_course_documents
    where revision = $1::text and document_id like 'lesson:%'
    union all
    select substring(document_id from 7), item_id from order_documents
    cross join lateral jsonb_array_elements_text(payload) as ids(item_id)
  ), previous_activity as (
    select activity.* from public.coach_course_activity activity join previous using (revision)
  ), daily_activity as materialized (
    select * from previous_activity where section ~ '^daily:[1-5]:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ), valid_daily as (
    select activity.user_id, activity.section, activity.item_id
    from daily_activity activity
    join pool_documents pool on pool.document_id = 'pool:' || ($2::jsonb ->> (split_part(activity.section, ':', 2)::int - 1))
    cross join lateral jsonb_array_elements(pool.payload) with ordinality as items(item, position)
    cross join lateral (select jsonb_array_length(pool.payload) as size,
      (split_part(activity.section, ':', 3)::date - date '1970-01-01') * 3 as rotation) as day
    where items.item->>'id' = activity.item_id
      and mod(mod(items.position - 1 - day.rotation, nullif(day.size, 0)) + day.size, nullif(day.size, 0)) < least(3, day.size)
  ), carried as (
    insert into public.coach_course_activity (user_id, revision, section, item_id, response, correct, topic, updated_at)
    select activity.user_id, $1::text, activity.section, activity.item_id,
      activity.response, activity.correct, activity.topic, activity.updated_at
    from previous_activity activity
    where exists (select 1 from retained where (retained.section, retained.item_id) = (activity.section, activity.item_id))
      or exists (select 1 from valid_daily daily where (daily.user_id, daily.section, daily.item_id) =
        (activity.user_id, activity.section, activity.item_id))
    on conflict (user_id, revision, section, item_id) do nothing
    returning 1
  ), activated as (
    insert into public.coach_course_documents (revision, document_id, payload)
    values ('published', 'active', jsonb_build_object('revision', $1::text))
    on conflict (revision, document_id) do update set payload = excluded.payload
    returning 1
  ) select (select count(*)::int from carried) as copied, (select count(*)::int from activated) as activated`;
const [release] = await query(publish, [revision, JSON.stringify(dailySets)]);
if (release?.activated !== 1) throw new Error('The course revision switch did not finish.');
console.log(`Published private course revision ${revision} with ${documents.length} documents and carried forward ${release.copied} progress records.`);
