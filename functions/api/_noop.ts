// Extracts this app's raw pixel payload out of a confirmed transaction's
// Noop program log. Mirrors the extraction logic in scripts/read-tree.mjs
// (kept separate for the same reason as _payload.ts / _decode.ts — the
// Worker and the local Node scripts are bundled by different toolchains).
import type { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { PAYLOAD_BYTES } from "./_payload";

/**
 * Finds the fixed-size payload this app logged via the Noop program. A
 * transaction can contain more than one Noop log (the compression
 * program's own `append` instruction CPIs into Noop too, to log the leaf
 * + changelog), so this matches on our exact payload length to avoid
 * mistaking that library-internal log for image data.
 */
export function extractNoopPayload(
  tx: ParsedTransactionWithMeta,
  noopProgramId: PublicKey
): Uint8Array | null {
  const topLevel = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);

  for (const ix of [...topLevel, ...inner]) {
    if (!("programId" in ix)) continue;
    if (!ix.programId.equals(noopProgramId)) continue;
    if (!("data" in ix) || typeof ix.data !== "string") continue;

    const bytes = base58Decode(ix.data);
    if (bytes.length === PAYLOAD_BYTES) return bytes;
  }
  return null;
}

// Minimal base58 decoder (Cloudflare Workers has no Buffer.from(str,
// "base58"), and pulling in bs58 as a dependency for one function isn't
// worth it — this is the same approach scripts/read-tree.mjs uses).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(str: string): Uint8Array {
  let bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error("invalid base58 character");
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
