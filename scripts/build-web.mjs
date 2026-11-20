import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim().replace(/\/$/, '');
if (!supabaseUrl || !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(supabaseUrl)) {
  throw new Error('Set the Coach Supabase project URL before building the hosted web app.');
}

const output = new URL('../web-dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const name of ['account.js', 'app.js', 'index.html', 'styles.css']) {
  await copyFile(new URL(`../dist/${name}`, import.meta.url), new URL(name, output));
}
await copyFile(new URL('../node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url), new URL('supabase.js', output));
const apiBase = `${supabaseUrl}/functions/v1/coach-pilot`;
await writeFile(new URL('host-config.js', output), `export const coachApiBase = ${JSON.stringify(apiBase)};\n`);
console.log('Built the public interface in web-dist. Course content and provider keys are on the backend.');
