const quizId = 'success-mastery-level-1-teachability-v1';

export async function connectAccount(config) {
  await new Promise((resolve, reject) => {
    const sdk = document.createElement('script');
    sdk.src = '/supabase.js';
    sdk.onload = resolve;
    sdk.onerror = () => reject(new Error('Could not load the Supabase sign-in client. Refresh to retry.'));
    document.head.append(sdk);
  });
  const client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: { detectSessionInUrl: false, flowType: 'pkce' },
  });

  function value(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  return {
    async session() { return value(await client.auth.getSession()).session; },
    watch(change) { client.auth.onAuthStateChange((event, session) => change(event, session)); },
    async sendCode(email) { value(await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })); },
    async verify(email, token) { return value(await client.auth.verifyOtp({ email, token, type: 'email' })).session; },
    async signOut() { value(await client.auth.signOut({ scope: 'local' })); },
    async progress() {
      return value(await client.from('coach_quiz_progress').select('choices,version').eq('quiz_id', quizId).maybeSingle())
        ?? { choices: [], version: 0 };
    },
    async save(choices, version) {
      return value(await client.rpc('save_coach_quiz', { p_quiz_id: quizId, p_version: version, p_choices: choices }));
    },
  };
}
