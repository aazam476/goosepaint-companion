/**
 * Base URL of the Cloudflare Pages Functions deployment (the "gas
 * station"). Set this to your deployed Pages domain, e.g.
 * "https://goose-paint.pages.dev". During local development against
 * `wrangler pages dev`, point it at http://localhost:8788.
 *
 * Kept as a plain constant (not an env var) because this value gets
 * baked into three different bundles (iOS, Android, web) and all three
 * need the same answer at build time; Expo's EXPO_PUBLIC_* env vars work
 * too if you prefer — swap the line below for
 * `process.env.EXPO_PUBLIC_GAS_STATION_URL` and set it in `.env`.
 */
export const GAS_STATION_URL = "https://goosepaint.work";
