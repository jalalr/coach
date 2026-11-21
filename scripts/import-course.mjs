import { readFile } from 'node:fs/promises';

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
    await result.body?.cancel();
    throw new Error(`Supabase database import returned HTTP ${result.status}.`);
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
await query(upsert, ['published', JSON.stringify([{ id: 'active', payload: { revision } }])]);
console.log(`Published private course revision ${revision} with ${documents.length} documents.`);
