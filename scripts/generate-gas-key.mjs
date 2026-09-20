// Generates the "gas station" keypair: the wallet that pays every
// transaction fee so end users never need SOL or a wallet of their own.
// Run this once per environment (local dev, then again for the deployed
// Cloudflare Pages project) and keep the printed secret key private —
// it's the account an attacker would drain to grief your app's costs.
import { Keypair } from "@solana/web3.js";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const secretsDir = join(root, ".secrets");
const outPath = join(secretsDir, "gas-station-keypair.json");

if (existsSync(outPath)) {
  console.error(
    `A gas station key already exists at ${outPath}.\n` +
      "Delete it first if you really want to generate a new one " +
      "(doing so orphans any SOL already sent to the old key)."
  );
  process.exit(1);
}

const keypair = Keypair.generate();
mkdirSync(secretsDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(Array.from(keypair.secretKey)));

console.log("Generated gas station keypair.");
console.log("Public key (fund this address with devnet SOL):");
console.log("  " + keypair.publicKey.toBase58());
console.log("");
console.log("Secret key saved to (DO NOT COMMIT):");
console.log("  " + outPath);
console.log("");
console.log("Next steps (devnet, the default):");
console.log("  1. npm run gas:fund          # airdrops devnet SOL to this key");
console.log("  2. npm run gas:create-tree   # creates the compression tree");
console.log("  3. Set GAS_STATION_SECRET_KEY as a Cloudflare Pages secret");
console.log("     (see README.md) using this same secret key.");
console.log("");
console.log("For mainnet instead, see the \"Moving to mainnet\" section in README.md —");
console.log("every gas:* script accepts --mainnet, and funding works differently (no faucet).");
