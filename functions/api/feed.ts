// Read side of the pipeline: returns recently submitted images from the
// compression tree as JSON, so the app's "Drawings" feed shows real
// on-chain data instead of the sample art in the mockup. This mirrors
// scripts/read-tree.mjs's approach (walk getSignaturesForAddress, pull
// each tx's Noop log, unpack it) but runs inside the Worker so the app
// doesn't need direct RPC access or a wallet of its own.
//
// Caches its response in the same KV namespace used for submit-side rate
// limiting (see CACHE_TTL_SECONDS below), so it only re-fetches and
// re-parses from Solana at most once per cache window regardless of how
// many people are viewing the feed at once — RPC load stays flat instead
// of scaling with visitor count. On a cache miss, real fetches are
// throttled (see fetchThrottled) to stay under free-tier RPC rate limits.
import { Connection, PublicKey } from "@solana/web3.js";
import { SPL_NOOP_PROGRAM_ID } from "@solana/spl-account-compression";
import { unpackPayload } from "./_payload";
import { extractNoopPayload } from "./_noop";

interface Env {
  TREE_ADDRESS: string;
  SOLANA_RPC_URL?: string;
  RATE_LIMIT_KV: KVNamespace;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// How long a given (limit, before) page is served straight from KV before
// this endpoint touches Solana again. Any number of concurrent viewers
// hitting the feed within this window share one cached response — RPC
// load stops scaling with visitor count and instead becomes "at most one
// real fetch every CACHE_TTL_SECONDS", regardless of how many people are
// looking at the feed at once.
//
// 60 is Cloudflare KV's hard minimum expirationTtl — anything shorter is
// rejected outright by the KV API, so this can't be tuned lower than 60
// without switching to a different cache backend (e.g. Cache API or
// Durable Objects). In practice this is fine here: the client's own poll
// interval is 20s, so a brand-new submission was never visible to an
// already-open feed sooner than that anyway; this only affects how long a
// freshly-opened/reloaded feed can show slightly-stale data (up to 60s
// worst case) before it re-fetches.
const CACHE_TTL_SECONDS = 60;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const cors = { "Access-Control-Allow-Origin": "*" };

  try {
    if (!env.TREE_ADDRESS) {
      return json({ ok: false, error: "TREE_ADDRESS is not configured." }, 500, cors);
    }

    const url = new URL(request.url);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT)
    );
    const before = url.searchParams.get("before") ?? undefined;

    const cacheKey = `feed-cache:${limit}:${before ?? "latest"}`;
    if (env.RATE_LIMIT_KV) {
      const cached = await env.RATE_LIMIT_KV.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Cache": "HIT", ...cors },
        });
      }
    }

    const connection = new Connection(env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
    const treePubkey = new PublicKey(env.TREE_ADDRESS);

    const signatureInfos = await connection.getSignaturesForAddress(treePubkey, {
      limit,
      before,
    });

    const confirmed = signatureInfos.filter((s) => !s.err);
    const signatures = confirmed.map((s) => s.signature);

    // Some RPC providers (Helius's free tier, in practice) reject the
    // batched getParsedTransactions call outright regardless of batch
    // size, even though their own docs describe a 10-item allowance for
    // it. Rather than chase an undocumented real limit, fetch each
    // transaction individually with getParsedTransaction, throttled to a
    // steady rate rather than fired all at once — see fetchThrottled.
    const transactions = signatures.length ? await fetchThrottled(connection, signatures) : [];

    const images: Array<{
      signature: string;
      slot: number;
      timestamp: string | null;
      pixels: number[];
    }> = [];

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      if (!tx) continue;
      const raw = extractNoopPayload(tx, SPL_NOOP_PROGRAM_ID);
      if (!raw) continue;
      try {
        const { timestampSeconds, pixels } = unpackPayload(raw);
        images.push({
          signature: signatures[i],
          slot: tx.slot,
          timestamp: timestampSeconds ? new Date(timestampSeconds * 1000).toISOString() : null,
          pixels,
        });
      } catch {
        // A malformed or foreign payload of the same byte length as ours
        // — skip it rather than let one bad row break the whole feed.
        continue;
      }
    }

    const oldestSignature = confirmed.length ? confirmed[confirmed.length - 1].signature : null;

    const responseBody = JSON.stringify({
      ok: true,
      cluster: env.SOLANA_RPC_URL?.includes("mainnet") ? "mainnet-beta" : "devnet",
      images,
      // Pass this back as `before` to page further into history.
      nextBefore: signatureInfos.length === limit ? oldestSignature : null,
    });

    if (env.RATE_LIMIT_KV) {
      // Fire-and-forget-ish: awaited so the write is guaranteed to land
      // before the Worker's execution context is torn down, but it
      // doesn't change what's returned to this request either way.
      await env.RATE_LIMIT_KV.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL_SECONDS });
    }

    return new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS", ...cors },
    });
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown server error." },
      500,
      cors
    );
  }
};

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });

// Issues one getParsedTransaction call per signature — unbatched, since
// at least one free-tier provider (Helius, in practice) rejects the
// batched getParsedTransactions method outright regardless of batch size,
// despite its own docs describing a 10-item allowance. Unbatched calls
// aren't subject to that restriction on any provider.
//
// Requests are issued in fixed-size waves rather than all at once, with a
// pause between waves, to stay under a steady per-second rate limit (most
// free tiers, Helius included, cap plain RPC at ~10 req/s) even at
// MAX_LIMIT. Combined with the KV cache above, this only ever runs once
// every CACHE_TTL_SECONDS regardless of how many users are viewing the
// feed concurrently — this throttle protects the one real fetch, not
// each individual page view.
const REQUESTS_PER_SECOND = 8; // stay a little under most providers' ~10/s
// free-tier ceiling, leaving headroom for /api/submit's own RPC calls
// happening around the same time.

async function fetchThrottled(connection: Connection, signatures: string[]) {
  const results: (Awaited<ReturnType<Connection["getParsedTransaction"]>>)[] = [];

  for (let i = 0; i < signatures.length; i += REQUESTS_PER_SECOND) {
    const wave = signatures.slice(i, i + REQUESTS_PER_SECOND);
    const waveResults = await Promise.all(
      wave.map((signature) =>
        connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )
    );
    results.push(...waveResults);

    const isLastWave = i + REQUESTS_PER_SECOND >= signatures.length;
    if (!isLastWave) {
      await sleep(1000);
    }
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status: number, extraHeaders: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
