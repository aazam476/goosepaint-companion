# Goose Paint

Expo app (iOS + Android + web) that scans a 12x12, 17-color badge screen,
decodes it into a checksum-verified pixel grid, and publishes it to a
Solana compression tree through a zero-cost "gas station" backend
running on Cloudflare Pages Functions. A second tab ("Drawings") shows a
live doomscroll-style feed of every image anyone has published, read
straight back off the chain. The badge-decoding UI, camera homography,
and Tesseract OCR are unchanged from your original design — this build
wires them into Expo and gives both the "Publish" button and the feed a
real backend instead of simulated/mock data.

## How it fits together

```
                    ┌─────────────────────────────────────┐
                    │            Expo app                  │
                    │  iOS/Android: WebView(decoder.html)  │
                    │  Web (mobile): iframe(/decoder.html) │
                    │  Web (desktop): "switch to mobile"   │
                    │  Two tabs: Drawings feed / Upload+Scan│
                    └───────────────┬───────────────────────┘
                        │ GET /api/feed          │ POST /api/submit { code }
                        ▼                        ▼
                    ┌─────────────────────────────────────┐
                    │   Cloudflare Pages Functions         │
                    │   (the "gas station")                │
                    │   feed:   reads tree tx history,     │
                    │           unpacks images for the UI  │
                    │   submit: re-validates mod-17        │
                    │           checksums, packs 144       │
                    │           pixels -> 95 bytes, rate-  │
                    │           limits by IP (KV), pays    │
                    │           the tx fee itself           │
                    └───────────────┬───────────────────────┘
                                    │ 1 tx: Noop log + Compression append
                                    ▼
                    ┌─────────────────────────────────────┐
                    │   Solana devnet                      │
                    │   - Noop program logs the raw 95     │
                    │     pixel bytes (the actual image)   │
                    │   - Compression program stores only  │
                    │     keccak256(payload) as a new leaf │
                    └───────────────────────────────────────┘
```

The two tabs live in one page (`public/decoder.html`) behind a floating
tab bar, switched by JS (`switchToTab`) rather than app-level navigation
— the whole page (feed + scanner) loads once into the same WebView/iframe
either way.

Storing only a hash in the tree (state compression) is what keeps your
own costs down: the tree account is allocated once, at a fixed size, no
matter how many images get published into it. The real pixel data lives
in transaction history via the Noop program's log — free to write
(it's just log data, not an account), and readable later by anyone
scanning that history (see `npm run gas:read-tree`, and reuse the same
approach in your Doomscroll app).

The "gas station" pattern means end users never touch a wallet or pay a
fee: your Cloudflare Function holds one funded keypair and signs every
transaction itself.

## One-time setup

```bash
npm install
```

This also runs a `postinstall` step that patches a packaging bug in
`@solana/spl-account-compression@0.4.1` (its published `package.json`
points `main`/`exports` at a file that doesn't exist in the tarball —
see `scripts/patch-spl-account-compression.mjs` for details). You don't
need to do anything for this; it's automatic on every `npm install`,
including Cloudflare's own build.

### 1. Create the gas station keypair

```bash
npm run gas:generate-key   # writes .secrets/gas-station-keypair.json (gitignored)
npm run gas:fund           # airdrops 2 devnet SOL to it
```

If the devnet faucet rate-limits you, fund the printed address manually
at https://faucet.solana.com.

### 2. Create the compression tree

```bash
npm run gas:create-tree
```

This allocates a tree sized for 16,384 images (depth 14 / buffer 64) —
plenty for a hackathon — and writes its address to
`.secrets/tree-info.json`. This step spends a small amount of devnet SOL
from the gas station key (tree account rent, one time).

### 3. Configure Cloudflare Pages

Create a KV namespace for rate limiting:

```bash
npx wrangler kv namespace create RATE_LIMIT_KV
```

Paste the returned `id` into `wrangler.toml` (and the preview id for
local dev). Then set these as Cloudflare Pages environment
variables/secrets (dashboard → your project → Settings → Environment
variables, or `wrangler pages secret put <NAME>`):

| Variable | Value |
|---|---|
| `GAS_STATION_SECRET_KEY` | contents of `.secrets/gas-station-keypair.json` (the JSON array) |
| `TREE_ADDRESS` | `treeAddress` from `.secrets/tree-info.json` |

These two are all you need for devnet — everything else
(`RATE_LIMIT_MAX_PER_MINUTE`, `DAILY_SUBMISSION_CAP`,
`PRIORITY_FEE_MICROLAMPORTS`) has a safe default and only matters once
you move to mainnet (see "Moving to mainnet" below).

For local development, copy `.dev.vars.example` to `.dev.vars` and fill
in the same two values.

### 4. Point the app at your deployed Worker

Edit `constants/config.ts` and set `GAS_STATION_URL` to your Cloudflare
Pages domain (e.g. `https://goose-paint.pages.dev`).

## Running it

```bash
# The Cloudflare Function, locally:
npm run pages:dev

# The Expo app (in another terminal):
npm run web       # mobile-width browser window, or resize to test desktop handoff
npm run ios       # requires Xcode / iOS simulator
npm run android   # requires Android Studio / emulator
```

Deploy the backend with:

```bash
npm run pages:deploy
```

## Editing the decoder page

`public/decoder.html` is the source of truth for the scanning/decoding
UI — it's what mobile web loads directly and what gets embedded into the
native WebView. After changing it, run:

```bash
npm run sync-decoder
```

to regenerate `constants/decoderHtml.ts`, which is what the native
build actually bundles (react-native-webview takes HTML as a string, not
a file reference).

## Verifying a submission landed

```bash
npm run gas:read-tree
```

Walks the tree's transaction history, pulls each Noop-logged payload,
and prints the reconstructed 12x12 grid to the terminal. This is also a
reference implementation for the reconstruction logic your Doomscroll
viewer app will need.

The app's own Drawings tab does the same thing over HTTP, via
`GET /api/feed` (`functions/api/feed.ts`) — query params: `limit`
(default 30, max 100) and `before` (a signature, for pagination; the
response's `nextBefore` feeds back into the next call). It re-parses the
last `limit` transactions on every request rather than maintaining an
index, which is fine at hackathon scale; if the tree grows past a few
hundred images, add a KV-backed cache in front of it before raising
`limit` further.

## Moving to mainnet

Everything above targets devnet by default. Switching to mainnet means
real SOL is spent on every submission (reading is still always free — see
below), so this is a deliberate, separate setup rather than an env-var
flip. Every `gas:*` script now accepts `--mainnet` (or `--rpc=<url>` to
point at a specific paid RPC provider instead of the public endpoint).

### What it costs

- **Reading** (`/api/feed`, the Drawings tab): free, always, on any
  cluster. Solana doesn't charge SOL to read state, only to write it.
- **Tree creation** (one-time): pays rent-exemption for a single account
  sized for this tree (depth 14 / buffer 64 → 16,384 images). At current
  rent rates this is roughly **0.2–0.4 SOL** depending on the exact byte
  size and rent parameters at the time — `gas:create-tree` prints the
  exact figure (via a live RPC call) before spending anything, and
  refuses to proceed on mainnet without `--confirm-mainnet`.
- **Each submission**: one transaction, one signer, no new accounts. Base
  fee is 5,000 lamports; add a small priority fee (see below) for
  reliable confirmation under mainnet congestion. Total per image is on
  the order of **$0.001–0.01** at typical SOL prices — not free like
  devnet, but far cheaper than an NFT mint, which is the whole point of
  using compression instead of one account per image.
- **Cloudflare**: unchanged — Pages Functions and KV both stay within
  the free tier at hackathon-to-small-app scale regardless of cluster.
  The only mainnet-specific cost lever is your RPC provider, if you
  move off the public endpoint (see below).

### Setup steps

1. **Generate a gas station key** (skip if reusing an existing one):
   ```bash
   npm run gas:generate-key
   ```

2. **Fund it with real SOL.** There is no faucet on mainnet. Either:
   - Send SOL manually from an exchange or wallet app to the printed
     address, or
   - Transfer from a keypair file you already control:
     ```bash
     npm run gas:fund -- --mainnet --from=/path/to/your-wallet.json 0.5
     ```
   Fund it for tree creation (~0.2–0.4 SOL) plus enough for the
   submission volume you expect (e.g. 1,000 submissions at a rough
   worst case of $0.01 each is still only a few SOL).

3. **Create the tree on mainnet**, after confirming the cost it prints:
   ```bash
   npm run gas:create-tree -- --mainnet --confirm-mainnet
   ```
   This writes `.secrets/tree-info.json` with `"cluster": "mainnet-beta"`.

4. **Get a paid RPC endpoint.** The public
   `https://api.mainnet-beta.solana.com` endpoint is free but rate-limited
   and not meant for production traffic — under real usage you'll want a
   provider like Helius, QuickNode, or Triton (all have free tiers that
   comfortably cover a small app's read+write volume). You'll set this
   as `SOLANA_RPC_URL` in step 6.

5. **Set a priority fee.** Add `PRIORITY_FEE_MICROLAMPORTS` (see step 6)
   — something like `1000` is a reasonable starting point. Without this,
   submissions can sit unconfirmed or get dropped when the network is
   busy, since the transaction otherwise carries zero priority.

6. **Update the Cloudflare Pages environment variables** (dashboard →
   your project → Settings → Environment variables, or
   `wrangler pages secret put <NAME>`):

   | Variable | Mainnet value |
   |---|---|
   | `GAS_STATION_SECRET_KEY` | contents of `.secrets/gas-station-keypair.json` (unchanged if reusing the same key) |
   | `TREE_ADDRESS` | `treeAddress` from the new `.secrets/tree-info.json` |
   | `SOLANA_RPC_URL` | your paid RPC provider's mainnet URL |
   | `PRIORITY_FEE_MICROLAMPORTS` | `1000` (tune based on confirmation times you observe) |
   | `RATE_LIMIT_MAX_PER_MINUTE` | optional — lower than the default `5` if you want tighter per-IP protection on real funds |
   | `DAILY_SUBMISSION_CAP` | optional but recommended — a global ceiling (e.g. `500`) on submissions per UTC day across all users, so a viral spike or an attacker spreading requests across IPs can't run up fees unattended; unset means no cap |

   For local `wrangler pages dev` testing against mainnet, set the same
   keys in `.dev.vars` instead (copy from `.dev.vars.example`).

7. **Redeploy**:
   ```bash
   npm run pages:deploy
   ```

8. **Update `constants/config.ts`** if your Pages domain changed, and
   rebuild the Expo app.

### Why these specific safeguards exist

- **Priority fee** (`functions/api/submit.ts`): defaults to `0` (off),
  which is correct for devnet (no contention) but risky on mainnet
  congestion. Setting `PRIORITY_FEE_MICROLAMPORTS` adds a
  `ComputeBudgetProgram` instruction pair; cost scales linearly — at
  40,000 compute units, 1000 micro-lamports/CU adds 40 lamports on top
  of the 5,000-lamport base fee.
- **Daily submission cap**: a soft, best-effort global counter in KV
  (keyed per UTC day). It exists because the per-IP rate limit alone
  doesn't bound *total* spend — someone determined to grief the gas
  station's balance could spread requests across many IPs. This isn't a
  hard atomic limit (KV is eventually consistent, so a handful of
  requests can slip through right at the boundary under heavy
  concurrency), but it stops a slow, sustained drain from running
  unattended overnight.
- **`--confirm-mainnet` on tree creation**: a one-time cost, but real
  money and irreversible once spent — the script prints the exact
  computed cost from a live RPC call and requires an explicit second
  flag before proceeding, rather than silently spending on the first
  invocation.

## Notes on the design decisions

- **Scanner**: runs unmodified inside a WebView (native) or a same-origin
  iframe (mobile web), so the existing homography + Tesseract OCR code
  didn't need a rewrite.
- **Desktop web**: shown a static "switch to mobile" screen, detected via
  a combination of user-agent and coarse-pointer/viewport checks (no
  single signal is fully reliable, so it's not perfect — a very narrow
  desktop browser window could, in principle, be misdetected — but this
  favors the failure mode of a desktop user occasionally seeing the
  scanner rather than a phone user being blocked).
- **Checksum validation happens twice**: once in the browser (fast
  feedback, gates the Publish button) and again inside the gas station
  (because the client can never be trusted — anyone can call
  `/api/submit` directly with a hand-crafted body). Both implementations
  are tested to agree; see the git history / conversation for the
  cross-check script.
- **Network**: defaults to devnet everywhere (scripts, RPC endpoint,
  faucet funding). See "Moving to mainnet" above for the full switch-over
  — it's a deliberate multi-step process, not an env-var flip, because it
  starts costing real money.
- **Rate limiting** is per-IP via Cloudflare KV, tunable with
  `RATE_LIMIT_MAX_PER_MINUTE` (default 5/minute). A separate
  `DAILY_SUBMISSION_CAP` env var, unset by default, adds a global
  best-effort ceiling across all users — see "Moving to mainnet" for why
  that second layer matters once real SOL is on the line.
