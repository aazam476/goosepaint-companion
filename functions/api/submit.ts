// The "gas station": the one endpoint that touches Solana. It receives
// a decoded badge code from the app, independently re-validates its
// checksums (never trusting the client), packs the 144 pixels into a
// fixed-size payload, logs that payload via the Noop program so the
// raw image is retrievable later, and appends its hash as a new leaf
// in the compression tree — all paid for by this Worker's own keypair,
// so the end user never needs SOL or a wallet.
//
// Required Cloudflare Pages environment bindings (see README.md):
//   GAS_STATION_SECRET_KEY   - JSON array of the fee-payer's 64-byte secret key
//   TREE_ADDRESS             - base58 pubkey of the compression tree
//   SOLANA_RPC_URL           - defaults to devnet if unset
//   RATE_LIMIT_KV            - KV namespace binding (see wrangler.toml)
// Optional (all have safe devnet defaults — see README's mainnet section):
//   RATE_LIMIT_MAX_PER_MINUTE - per-IP submissions/minute (default 5)
//   DAILY_SUBMISSION_CAP      - global submissions/day across all users (default: unlimited)
//   PRIORITY_FEE_MICROLAMPORTS - compute-unit price; 0 disables it (default 0)
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createAppendIx, SPL_NOOP_PROGRAM_ID } from "@solana/spl-account-compression";
import { keccak_256 } from "js-sha3";
import { decodeAndValidate } from "./_decode";
import { packPayload, PAYLOAD_BYTES } from "./_payload";

interface Env {
  GAS_STATION_SECRET_KEY: string;
  TREE_ADDRESS: string;
  SOLANA_RPC_URL?: string;
  RATE_LIMIT_KV: KVNamespace;
  RATE_LIMIT_MAX_PER_MINUTE?: string;
  DAILY_SUBMISSION_CAP?: string;
  PRIORITY_FEE_MICROLAMPORTS?: string;
  // Fixed compute unit budget for this transaction. It only ever runs two
  // small, well-known instructions (Noop log + compression append), so a
  // generous fixed value avoids a simulation round-trip on every request
  // without risking under-provisioning. Override only if you change what
  // this endpoint sends.
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_MAX_PER_MINUTE = 5; // per IP per window — a real
// doomscroll feed only needs a handful of submissions a minute from any
// one device; this exists to stop a script from draining the gas
// station's SOL, not to throttle a legitimate user scanning a few badges.

const COMPUTE_UNIT_LIMIT = 40_000; // ~2x a comfortable margin over what
// a Noop log + one compression append actually consumes; keeps the
// priority fee calculation (price × limit) predictable per transaction.

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const cors = corsHeaders();
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const perIpLimit = positiveIntOr(env.RATE_LIMIT_MAX_PER_MINUTE, DEFAULT_RATE_LIMIT_MAX_PER_MINUTE);
    const rateLimited = await isRateLimited(env.RATE_LIMIT_KV, ip, perIpLimit);
    if (rateLimited) {
      return json({ ok: false, error: "Rate limit exceeded. Try again in a minute." }, 429, cors);
    }

    const dailyCap = positiveIntOr(env.DAILY_SUBMISSION_CAP, null);
    if (dailyCap !== null) {
      const overCap = await isOverDailyCap(env.RATE_LIMIT_KV, dailyCap);
      if (overCap) {
        return json(
          {
            ok: false,
            error: "Daily submission limit reached. This protects the gas station's balance — try again tomorrow.",
          },
          429,
          cors
        );
      }
    }

    const body = await request.json<{ code?: string; pixels?: number[] }>().catch(() => null);
    if (!body || typeof body.code !== "string") {
      return json({ ok: false, error: "Missing 'code' field." }, 400, cors);
    }

    const decoded = decodeAndValidate(body.code);
    if (!decoded.ok) {
      return json({ ok: false, error: decoded.reason ?? "Checksum validation failed." }, 422, cors);
    }

    if (!env.GAS_STATION_SECRET_KEY || !env.TREE_ADDRESS) {
      return json(
        { ok: false, error: "Gas station is not configured (missing secret key or tree address)." },
        500,
        cors
      );
    }

    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.GAS_STATION_SECRET_KEY)));
    const treePubkey = new PublicKey(env.TREE_ADDRESS);
    const connection = new Connection(env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

    const timestampSeconds = Math.floor(Date.now() / 1000);
    const payload = packPayload(decoded.pixels, timestampSeconds);
    if (payload.length !== PAYLOAD_BYTES) {
      // Defensive: should be unreachable given decodeAndValidate's
      // guarantees, but a size mismatch here would corrupt every image
      // read back later, so it's worth failing loudly instead of
      // sending a malformed transaction.
      return json({ ok: false, error: "Internal payload size mismatch." }, 500, cors);
    }

    const leaf = new Uint8Array(hexToBytes(keccak_256(payload)));

    // Logs the raw pixel data on-chain via the Noop program. The tree
    // itself only ever stores this leaf's 32-byte hash — the actual
    // image lives in this log entry, in the transaction history, which
    // is what makes the tree cheap: no per-image account, no rent.
    const noopLogIx = new TransactionInstruction({
      programId: SPL_NOOP_PROGRAM_ID,
      keys: [],
      data: Buffer.from(payload),
    });

    const appendIx = createAppendIx(treePubkey, payer.publicKey, leaf);

    const instructions: TransactionInstruction[] = [];

    // Priority fee: on devnet there's normally no contention, so this
    // defaults to 0 (off) and costs nothing extra. On mainnet, a
    // zero-priority transaction can sit unconfirmed or get dropped
    // during congestion — set PRIORITY_FEE_MICROLAMPORTS to a small
    // nonzero value (e.g. 1000) once you switch clusters. Cost impact:
    // priority fee = compute units × microLamports / 1,000,000, so at
    // 40,000 compute units and 1000 micro-lamports/CU that's 40 lamports
    // added on top of the 5000-lamport base fee (~0.8% extra) — raise
    // PRIORITY_FEE_MICROLAMPORTS if transactions are still landing slowly
    // during real congestion; it scales linearly with this value.
    const priorityFee = positiveIntOr(env.PRIORITY_FEE_MICROLAMPORTS, 0);
    if (priorityFee > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }));
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    }

    instructions.push(noopLogIx, appendIx);

    const tx = new Transaction().add(...instructions);
    const { signature, confirmedTx } = await sendAndConfirmResilient(connection, tx, payer);

    if (dailyCap !== null) {
      await incrementDailyCount(env.RATE_LIMIT_KV);
    }

    // Bust the feed's "latest page" cache (functions/api/feed.ts) so this
    // submission is visible on the next poll instead of waiting out KV's
    // 60s minimum TTL. The client always polls with limit=20 and no
    // `before` — that's the one key that matters for freshness — but
    // deleting a couple of other common limits too costs nothing and
    // covers a client that ever changes its default page size. Older,
    // `before`-paginated pages are deliberately left alone: those are
    // historical pages a viewer has already scrolled past, not the
    // "what's new" view this submission needs to appear in.
    await invalidateFeedCache(env.RATE_LIMIT_KV);

    return json(
      {
        ok: true,
        signature,
        slot: confirmedTx?.slot ?? null,
        cluster: env.SOLANA_RPC_URL?.includes("mainnet") ? "mainnet-beta" : "devnet",
        leafHash: bytesToHex(leaf),
      },
      200,
      cors
    );
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown server error." },
      500,
      cors
    );
  }
};

export const onRequestOptions: PagesFunction<Env> = async () => new Response(null, { headers: corsHeaders() });

// Solana transactions embed a recent blockhash that's only valid for
// ~150 blocks (roughly 60-90s). web3.js's own sendAndConfirmTransaction
// sends once and polls until that blockhash's block height is exceeded,
// then throws — even though the transaction it sent may still land in a
// block moments later (Solana doesn't retract it just because our client
// stopped watching). Under any real-world RPC latency (devnet congestion,
// a slow free-tier provider), that surfaces as a scary "expired: block
// height exceeded" error on a submission that actually succeeded, which
// is exactly what prompted this rewrite.
//
// This still gives an honest answer — it never reports success before
// Solana itself confirms the transaction — while keeping RPC usage
// reasonable per submission, since that cost multiplies by however many
// people are submitting at once:
//   - Sends once. No speculative resend on a fixed timer; a fresh
//     blockhash from a healthy RPC rarely gets silently dropped, and this
//     was the single biggest source of extra calls in an earlier version.
//   - Polls getSignatureStatus with searchTransactionHistory (needed so a
//     load-balanced provider's other backend nodes are checked too, not
//     just whichever one answers this particular request) plus a real
//     getBlockHeight call each iteration — an earlier version tried to
//     save that second call by reusing getSignatureStatus's returned
//     slot instead, but slot and block height can diverge enough
//     (block height skips slots with no produced block) to report the
//     blockhash expired well before it actually had. Correctness here
//     matters more than the saved call.
//   - Backs off the poll interval over time (fast at first, since most
//     submissions confirm within a few seconds; slower later, since a
//     submission still unconfirmed after 10s is already an atypical
//     case and doesn't need checking every 2s).
//   - Only resends once, and only after a long silence (15s) — a real
//     safety net for a dropped first send, not routine noise.
const POLL_SCHEDULE_MS = [1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000]; // ~1s,
// 2s, 4s, 6s, 9s, 12s, 17s, 22s elapsed — then falls back to 5s steps.
const RESEND_AFTER_MS = 15000; // one resend, only if nothing's landed by
// this point — most submissions never reach it.

async function sendAndConfirmResilient(
  connection: Connection,
  tx: Transaction,
  payer: Keypair
): Promise<{ signature: string; confirmedTx: Awaited<ReturnType<Connection["getTransaction"]>> }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  const rawTx = tx.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 0, // this loop handles resending itself, on its own schedule
  });

  let elapsedMs = 0;
  let hasResent = false;
  let pollIndex = 0;

  while (true) {
    // searchTransactionHistory is required here: without it, a load-
    // balanced RPC provider (multiple backend nodes behind one endpoint,
    // as free-tier Helius is) can have this particular request land on a
    // node whose recent-status cache doesn't happen to include this
    // signature yet, returning a false "not found" even though another
    // node already confirmed it. This was the likely cause of the
    // premature "no confirmation was found" failures seen in practice.
    const { value: status } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });

    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }

    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      const confirmedTx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      return { signature, confirmedTx };
    }

    // Block height — not slot — is what a blockhash's validity window is
    // actually defined against. An earlier version of this code compared
    // against getSignatureStatus's returned slot as a way to save an RPC
    // call, on the assumption that slot and block height track closely
    // enough for this purpose. That assumption was wrong: block height
    // only advances for slots that actually produce a block, while slot
    // number advances every ~400ms regardless — so block height can run
    // meaningfully behind slot number, especially on devnet where skip
    // rates are non-trivial. Using slot here could and did jump to "the
    // blockhash has expired" well before it actually had, causing this
    // function to give up while the transaction was still perfectly
    // valid and simply hadn't landed yet. A dedicated getBlockHeight
    // call costs a little more but decides this correctly.
    const currentBlockHeight = await connection.getBlockHeight("confirmed");
    if (currentBlockHeight > lastValidBlockHeight) {
      const confirmedTx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (confirmedTx) {
        return { signature, confirmedTx };
      }
      throw new Error(`Signature ${signature} expired: block height exceeded and no confirmation was found.`);
    }

    if (!hasResent && elapsedMs >= RESEND_AFTER_MS) {
      hasResent = true;
      await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {
        // Ignore resend errors (e.g. "already processed") — the poll
        // loop above is the source of truth on whether it landed.
      });
    }

    const waitMs = POLL_SCHEDULE_MS[Math.min(pollIndex, POLL_SCHEDULE_MS.length - 1)];
    pollIndex++;
    elapsedMs += waitMs;
    await sleep(waitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors feed.ts's cache key format exactly (`feed-cache:${limit}:${before
// ?? "latest"}`) — these two files must stay in sync if that format ever
// changes. Only "latest" (no `before`) keys are cleared; see the call site
// above for why paginated history pages are left untouched.
const LIKELY_LATEST_PAGE_LIMITS = [20, 30, 50, 100]; // the client's own
// default (20) plus feed.ts's DEFAULT_LIMIT/MAX_LIMIT, in case either
// changes independently of the other.

async function invalidateFeedCache(kv: KVNamespace): Promise<void> {
  await Promise.all(
    LIKELY_LATEST_PAGE_LIMITS.map((limit) => kv.delete(`feed-cache:${limit}:latest`).catch(() => {}))
  );
}

async function isRateLimited(kv: KVNamespace, ip: string, maxPerMinute: number): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= maxPerMinute) return true;
  await kv.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return false;
}

// Tracks total submissions across ALL users for the current UTC day, so
// a viral spike (or an attacker who spreads requests across many IPs to
// dodge the per-IP limit) can't run up real mainnet fees unattended
// overnight. This is a soft, best-effort cap: KV is eventually
// consistent, so under very high concurrency a handful of requests past
// the cap can still slip through in the same instant — acceptable for
// what this guards against (a slow, sustained drain), not meant to be a
// hard atomic limit.
function dailyCounterKey(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `daily-submissions:${today}`;
}

async function isOverDailyCap(kv: KVNamespace, cap: number): Promise<boolean> {
  const current = await kv.get(dailyCounterKey());
  const count = current ? parseInt(current, 10) : 0;
  return count >= cap;
}

async function incrementDailyCount(kv: KVNamespace): Promise<void> {
  const key = dailyCounterKey();
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  // 26 hours: comfortably outlives the UTC day this key represents so a
  // slow trailing read near midnight still sees it, but it still cleans
  // itself up rather than accumulating one KV entry per day forever.
  await kv.put(key, String(count + 1), { expirationTtl: 26 * 60 * 60 });
}

function positiveIntOr<T extends number | null>(raw: string | undefined, fallback: T): number | T {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body: unknown, status: number, extraHeaders: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
