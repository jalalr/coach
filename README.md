# Success Mastery Level 1 pilot

## Supabase sign-in and quiz sync

Run `npm ci` in `level-1-pilot` to install the browser client. From the PersonalCoach workspace, start the connected pilot with `node --env-file=level-1-pilot/.env.local level-1-pilot/server.mjs`. The settings file needs `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `COACH_OWNER_EMAIL`. The app also accepts Supabase's `NEXT_PUBLIC_`-prefixed names for the URL and publishable key.

The Supabase project needs the quiz-progress migration and email sign-in enabled. The configured owner address can create its app account on the first sign-in, subject to the project's Auth settings. Enter the email code or copy the original Supabase verification link into the pilot. Sign in using the same account on each device. A quiz save checks its revision before writing, so an older browser cannot overwrite newer progress. Start without the settings file for local mode.

## Hosted pilot

Deploy the `coach-pilot` Edge Function from this folder with the Supabase CLI and a project-scoped deployment token. The function validates the Supabase session and verified owner email before serving lessons, scores, or read-aloud audio. The project injects its own Supabase URL and publishable key. Configure these server secrets in the Coach project:

- `COACH_OWNER_EMAIL` is the email allowed to use the pilot.
- `COACH_WEB_ORIGIN` is the HTTPS origin of the frontend, without a trailing slash.
- `COACH_DEEPGRAM_API_KEY` enables optional read-aloud.

From this folder, run `node --env-file=.env.local scripts/build-web.mjs` and publish the generated `web-dist` directory to the configured HTTPS host. The static build sends API requests to Supabase. It contains the sign-in interface and no course recordings, answer keys, or server secrets.

In Azure Static Web Apps, deploy only `web-dist`. Set the Supabase Auth Site URL and allowed redirect URL to the Azure site address. The browser returns to the root page after an email link is verified. Request a fresh sign-in email after changing the address, since earlier links can still contain the earlier redirect.

## Local mode

From the PersonalCoach workspace, run `node level-1-pilot/server.mjs`. Open `http://127.0.0.1:4173` in Chrome on the same laptop. Node is the only server dependency. Leave that terminal running while you use the pilot and press Ctrl+C when finished.

The pilot includes two generated Teachability questions and keeps their answer keys server-side. When the original course folder is present, it plays the cited recording from 14:58 to 15:43. A standalone checkout can set `COACH_SOURCE_AUDIO` to that recording’s local path. The server listens on the laptop’s loopback address and grades answers locally.

If **Enable voice** appears, use it to install Chrome’s on-device English speech pack. Hold the mic button with your mouse, touch, or Space, and release it to send the question. You can also use **Start recording** and **Stop and send**. The quiz accepts a spoken A, B, or C once voice is enabled, then asks you to confirm your choice. Type your question if local speech recognition is unavailable.

Use **Read reply aloud**, **Read question aloud**, or **Read feedback aloud** to listen. The server uses Deepgram Aura-2 and reads `DEEPGRAM_API_KEY` from its environment or your existing Windows user setting. Each read-aloud request sends only the prepared text you selected to Deepgram with model improvement opted out. Replays reuse audio cached in memory until the server restarts.

Coach replies use a small set of responses grounded in the Teachability excerpt. Local mode stores quiz results per browser. Use an HTTPS deployment to open the connected pilot from another device.
