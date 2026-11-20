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
    async verify(email, codeOrLink) {
      let credentials = { email, token: codeOrLink, type: 'email' };
      if (!/^\d{6,10}$/.test(codeOrLink)) {
        let link;
        try { link = new URL(codeOrLink); } catch { /* Validation below handles an invalid link. */ }
        const type = link?.searchParams.get('type');
        const tokenHash = link?.searchParams.get('token') ?? link?.searchParams.get('token_hash');
        if (!link || link.origin !== config.supabaseUrl || link.pathname !== '/auth/v1/verify' ||
            !['signup', 'magiclink', 'email'].includes(type) || !tokenHash) {
          throw new Error('Enter the numeric code or copy the original Supabase verification link from your email.');
        }
        credentials = { token_hash: tokenHash, type };
      }
      const { session } = value(await client.auth.verifyOtp(credentials));
      if (session?.user.email?.toLowerCase() !== email.toLowerCase()) {
        if (session) await client.auth.signOut({ scope: 'local' });
        throw new Error('This email verification does not match the email entered above.');
      }
      return session;
    },
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
