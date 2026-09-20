// Walks every transaction that touched the compression tree, extracts
// the noop-logged payload from each one, and reconstructs the 12x12
// image. This is the read side of the pipeline: the Doomscroll app you
// build later will do essentially this, likely with a proper indexer
// instead of getSignaturesForAddress (which only paginates ~1000 sigs
// deep and gets slow as the tree grows) — but for a hackathon demo, or
// to sanity-check that submissions are landing correctly, this is a
// direct and dependency-light way to prove the whole pipeline works.
import { Connection, PublicKey } from "@solana/web3.js";
import { SPL_NOOP_PROGRAM_ID } from "@solana/spl-account-compression";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unpackPayload, PAYLOAD_BYTES } from "./lib/payload.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const treeInfoPath = join(root, ".secrets", "tree-info.json");

if (!existsSync(treeInfoPath)) {
  console.error("No tree found. Run `npm run gas:create-tree` first.");
  process.exit(1);
}

const { treeAddress, cluster } = JSON.parse(readFileSync(treeInfoPath, "utf8"));
const endpoint =
  cluster === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
const connection = new Connection(endpoint, "confirmed");
const treePubkey = new PublicKey(treeAddress);

console.log(`Reading transaction history for tree ${treeAddress} on ${cluster}...`);

const signatures = await connection.getSignaturesForAddress(treePubkey, { limit: 1000 });
console.log(`Found ${signatures.length} transaction(s).`);

const images = [];

for (const sigInfo of signatures.reverse()) {
  // oldest first, so image index order matches submission order
  if (sigInfo.err) continue;
  const tx = await connection.getTransaction(sigInfo.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) continue;

  const payload = extractNoopPayload(tx);
  if (!payload) continue;

  try {
    const { version, timestampSeconds, pixels } = unpackPayload(payload);
    images.push({
      signature: sigInfo.signature,
      slot: tx.slot,
      version,
      timestamp: new Date(timestampSeconds * 1000).toISOString(),
      pixels,
    });
  } catch (err) {
    console.warn(`Skipping ${sigInfo.signature}: ${err.message}`);
  }
}

console.log(`Reconstructed ${images.length} image(s).`);
for (const img of images) {
  console.log("");
  console.log(`--- ${img.signature} (slot ${img.slot}, ${img.timestamp}) ---`);
  printGrid(img.pixels);
}

/**
 * Finds the raw bytes this app logged via the Noop program in a given
 * transaction. The compression program's own `append` CPIs into Noop
 * too (to log the leaf + changelog), so a transaction can contain more
 * than one Noop log — this picks the one matching our fixed payload
 * size to avoid mistaking the library's own log for image data.
 */
function extractNoopPayload(tx) {
  const message = tx.transaction.message;
  const accountKeys = message.getAccountKeys
    ? message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    : message.accountKeys;

  const instructions = [
    ...message.compiledInstructions ?? message.instructions ?? [],
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
  ];

  for (const ix of instructions) {
    const programIdIndex = ix.programIdIndex;
    const programId = accountKeys.get
      ? accountKeys.get(programIdIndex)
      : accountKeys[programIdIndex];
    if (!programId || !programId.equals(SPL_NOOP_PROGRAM_ID)) continue;

    const data = typeof ix.data === "string" ? bs58Decode(ix.data) : Uint8Array.from(ix.data);
    if (data.length === PAYLOAD_BYTES) return data;
  }
  return null;
}

// Minimal base58 decoder so this script has no extra dependency beyond
// @solana/web3.js (which doesn't itself export a public decode helper).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Decode(str) {
  let bytes = [0];
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

const PALETTE = [
  "  ", "##", "RR", "OO", "YY", "GG", "TT", "CC", "BB", "PP", "MM", "..", "gg", "pp", "aa", "cc", "vv",
];
function printGrid(pixels) {
  for (let y = 0; y < 12; y++) {
    let row = "";
    for (let x = 0; x < 12; x++) {
      row += PALETTE[pixels[y * 12 + x]] ?? "??";
    }
    console.log(row);
  }
}
