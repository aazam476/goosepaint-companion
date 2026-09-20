// Funds the gas station key.
//
// Devnet (default): airdrops free SOL from the public faucet.
// Mainnet (--mainnet): there is no faucet — real SOL only. This script
// can either transfer from another local keypair file you already hold
// (--from=<path-to-keypair.json>), or, with no --from, just print the
// gas station's address and exit so you can send it SOL yourself from
// an exchange or wallet app. It never fabricates funds on mainnet.
//
// Usage:
//   npm run gas:fund                              # devnet airdrop, 2 SOL
//   npm run gas:fund -- 5                         # devnet airdrop, 5 SOL
//   npm run gas:fund -- --mainnet                 # just prints the address to fund manually
//   npm run gas:fund -- --mainnet --from=./payer.json 0.5   # transfers 0.5 SOL from ./payer.json
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveCluster, isMainnet } from "./lib/cluster.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const keyPath = join(root, ".secrets", "gas-station-keypair.json");

if (!existsSync(keyPath)) {
  console.error("No gas station key found. Run `npm run gas:generate-key` first.");
  process.exit(1);
}

const { cluster, endpoint } = resolveCluster(process.argv.slice(2));
const fromArg = process.argv.find((a) => a.startsWith("--from="));
const amountArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const AMOUNT_SOL = Number(amountArg ?? "2");

if (!Number.isFinite(AMOUNT_SOL) || AMOUNT_SOL <= 0) {
  console.error(`Invalid amount: ${amountArg}`);
  process.exit(1);
}

const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
const keypair = Keypair.fromSecretKey(secret);
const connection = new Connection(endpoint, "confirmed");

console.log(`Cluster: ${cluster} (${endpoint})`);
console.log(`Gas station address: ${keypair.publicKey.toBase58()}`);

if (!isMainnet(cluster)) {
  // ---- Devnet: free faucet airdrop ----
  console.log(`Requesting ${AMOUNT_SOL} SOL airdrop on devnet...`);
  try {
    const sig = await connection.requestAirdrop(keypair.publicKey, AMOUNT_SOL * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`Airdrop confirmed. Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    console.error("Airdrop failed:", err.message);
    console.error(
      "Devnet faucets are rate-limited per IP/address. Try again in a minute, or " +
        "fund manually at https://faucet.solana.com with address:"
    );
    console.error("  " + keypair.publicKey.toBase58());
    process.exit(1);
  }
  process.exit(0);
}

// ---- Mainnet: real SOL only ----
if (!fromArg) {
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`Current balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  console.log("");
  console.log("This is mainnet — there is no faucet. Send real SOL to the address above");
  console.log("from an exchange or wallet app, or re-run with --from=<path-to-keypair.json>");
  console.log("to transfer from a keypair file you already control, e.g.:");
  console.log(`  npm run gas:fund -- --mainnet --from=./my-wallet.json 0.5`);
  process.exit(0);
}

const fromPath = resolve(fromArg.slice("--from=".length));
if (!existsSync(fromPath)) {
  console.error(`Source keypair file not found: ${fromPath}`);
  process.exit(1);
}
const fromSecret = Uint8Array.from(JSON.parse(readFileSync(fromPath, "utf8")));
const fromKeypair = Keypair.fromSecretKey(fromSecret);

const fromBalance = await connection.getBalance(fromKeypair.publicKey);
const lamportsToSend = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);
console.log(`Source address: ${fromKeypair.publicKey.toBase58()} (balance: ${fromBalance / LAMPORTS_PER_SOL} SOL)`);
console.log(`Transferring ${AMOUNT_SOL} SOL to the gas station on MAINNET. This spends real money.`);

if (fromBalance < lamportsToSend + 5000) {
  console.error("Source balance too low to cover the transfer plus its own fee.");
  process.exit(1);
}

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: fromKeypair.publicKey,
    toPubkey: keypair.publicKey,
    lamports: lamportsToSend,
  })
);
const sig = await sendAndConfirmTransaction(connection, tx, [fromKeypair], { commitment: "confirmed" });
const newBalance = await connection.getBalance(keypair.publicKey);
console.log(`Transfer confirmed: ${sig}`);
console.log(`Gas station balance is now ${newBalance / LAMPORTS_PER_SOL} SOL`);
