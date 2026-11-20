# Success Mastery Level 1 pilot

## Supabase sign-in and quiz sync

Run `npm ci` in `level-1-pilot` to install the browser client. From the PersonalCoach workspace, start the connected pilot with `node --env-file=level-1-pilot/.env.local level-1-pilot/server.mjs`. The settings file needs `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `COACH_OWNER_EMAIL`. The app also accepts Supabase's `NEXT_PUBLIC_`-prefixed names for the URL and publishable key.

The Supabase project needs the quiz-progress migration, a confirmed Auth user for the owner email, and a Magic Link email template that includes the sign-in code via `{{ .Token }}`. Sign in using the same account on each device. A quiz save checks its revision before writing, so an older browser cannot overwrite newer progress. The original local mode remains available by starting without the settings file.

## Local mode

From the PersonalCoach workspace, run `node level-1-pilot/server.mjs`. Open `http://127.0.0.1:4173` in Chrome on the same laptop. Node is the only server dependency. Leave that terminal running while you use the pilot and press Ctrl+C when finished.

The pilot includes two generated Teachability questions and keeps their answer keys server-side. When the original course folder is present, it plays the cited recording from 14:58 to 15:43. A standalone checkout can set `COACH_SOURCE_AUDIO` to that recording’s local path. The server listens on the laptop’s loopback address and grades answers locally.

If **Enable voice** appears, use it to install Chrome’s on-device English speech pack. Hold the mic button with your mouse, touch, or Space, and release it to send the question. You can also use **Start recording** and **Stop and send**. The quiz accepts a spoken A, B, or C once voice is enabled, then asks you to confirm your choice. Type your question if local speech recognition is unavailable.

Use **Read reply aloud**, **Read question aloud**, or **Read feedback aloud** to listen. The server uses Deepgram Aura-2 and reads `DEEPGRAM_API_KEY` from its environment or your existing Windows user setting. Each read-aloud request sends only the prepared text you selected to Deepgram with model improvement opted out. Replays reuse audio cached in memory until the server restarts.

Coach replies use a small set of responses grounded in the Teachability excerpt. Local mode stores quiz results per browser. Use an HTTPS deployment to open the connected pilot from another device.
