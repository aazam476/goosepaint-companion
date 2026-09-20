// Creates the concurrent Merkle tree that will hold every submitted
// Goose Paint image (as leaf hashes) plus its on-chain config account.
// This is a one-time setup step per environment — run it once, then
// point the Cloudflare Worker at the printed tree address.
//
// Sizing: maxDepth 14 / maxBufferSize 64 gives 2^14 = 16,384 leaves
// (i.e. 16,384 images this tree can ever hold) and can absorb up to 64
// concurrent appends per slot before a proof goes stale — comfortably
// more concurrency than a hackathon demo will see. A canopy depth of 0
// keeps the account (and therefore the one-time rent cost) small; the
// tradeoff is that `append` (used here) never needs a proof, so canopy
// depth doesn't matter for this app at all — it would only matter for
// `replace_leaf`/`verify_leaf`, which this app never calls.
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createAllocTreeIx,
  createInitEmptyMerkleTreeIx,
  SPL_NOOP_PROGRAM_ID,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  getConcurrentMerkleTreeAccountSize,
} from "@solana/spl-account-compression";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveCluster, isMainnet } from "./lib/cluster.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const keyPath = join(root, ".secrets", "gas-station-keypair.json");
const treeInfoPath = join(root, ".secrets", "tree-info.json");

const MAX_DEPTH = 14;
const MAX_BUFFER_SIZE = 64;
const CANOPY_DEPTH = 0;

if (!existsSync(keyPath)) {
  console.error("No gas station key found. Run `npm run gas:generate-key` (and gas:fund) first.");
  process.exit(1);
}
if (existsSync(treeInfoPath)) {
  console.error(
    `A tree already exists (${treeInfoPath}). Delete that file first if you ` +
      "really want to create a new one — your app will need to be repointed at it."
  );
  process.exit(1);
}

const { cluster, endpoint } = resolveCluster(process.argv.slice(2));
const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
const payer = Keypair.fromSecretKey(secret);
const connection = new Connection(endpoint, "confirmed");

console.log(`Cluster: ${cluster} (${endpoint})`);

const requiredSpace = getConcurrentMerkleTreeAccountSize(MAX_DEPTH, MAX_BUFFER_SIZE, CANOPY_DEPTH);
const rentLamports = await connection.getMinimumBalanceForRentExemption(requiredSpace);
console.log(`Tree account size: ${requiredSpace} bytes -> rent-exemption cost: ${rentLamports / 1e9} SOL`);

const balance = await connection.getBalance(payer.publicKey);
console.log(`Gas station balance: ${balance / 1e9} SOL`);
if (balance < rentLamports + 0.01 * 1e9) {
  console.error(
    `Balance too low to create this tree (need ~${(rentLamports / 1e9 + 0.01).toFixed(4)} SOL ` +
      "for rent-exemption plus a small fee buffer)."
  );
  console.error(
    isMainnet(cluster)
      ? "Fund the gas station with real SOL: npm run gas:fund -- --mainnet"
      : "Run `npm run gas:fund` first."
  );
  process.exit(1);
}

if (isMainnet(cluster)) {
  console.log("");
  console.log(`This will spend ~${rentLamports / 1e9} SOL of REAL money on mainnet to create the tree.`);
  console.log("Re-run with --confirm-mainnet appended if you're sure. Aborting otherwise.");
  if (!process.argv.includes("--confirm-mainnet")) {
    process.exit(0);
  }
}

const treeKeypair = Keypair.generate();
console.log(`Allocating tree account ${treeKeypair.publicKey.toBase58()}...`);

const allocIx = await createAllocTreeIx(
  connection,
  treeKeypair.publicKey,
  payer.publicKey,
  { maxDepth: MAX_DEPTH, maxBufferSize: MAX_BUFFER_SIZE },
  CANOPY_DEPTH
);

const initIx = createInitEmptyMerkleTreeIx(treeKeypair.publicKey, payer.publicKey, {
  maxDepth: MAX_DEPTH,
  maxBufferSize: MAX_BUFFER_SIZE,
});

const tx = new Transaction().add(allocIx, initIx);
const sig = await sendAndConfirmTransaction(connection, tx, [payer, treeKeypair], {
  commitment: "confirmed",
});

console.log("Tree created.");
console.log("  Signature:      " + sig);
console.log("  Tree address:   " + treeKeypair.publicKey.toBase58());
console.log("  Tree authority: " + payer.publicKey.toBase58() + " (the gas station key)");
console.log("  Compression program: " + SPL_ACCOUNT_COMPRESSION_PROGRAM_ID.toBase58());
console.log("  Max depth / buffer:  " + MAX_DEPTH + " / " + MAX_BUFFER_SIZE + " (capacity " + 2 ** MAX_DEPTH + " leaves)");

const info = {
  cluster,
  treeAddress: treeKeypair.publicKey.toBase58(),
  treeAuthority: payer.publicKey.toBase58(),
  maxDepth: MAX_DEPTH,
  maxBufferSize: MAX_BUFFER_SIZE,
  canopyDepth: CANOPY_DEPTH,
  createdAt: new Date().toISOString(),
  createSignature: sig,
};
writeFileSync(treeInfoPath, JSON.stringify(info, null, 2) + "\n");
console.log("");
console.log("Saved tree info to " + treeInfoPath);
console.log("Set TREE_ADDRESS as a Cloudflare Pages environment variable to:");
console.log("  " + treeKeypair.publicKey.toBase58());
