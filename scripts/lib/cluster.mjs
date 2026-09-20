// Shared cluster resolution for the setup scripts, so "--mainnet",
// "--devnet" and "--rpc=<url>" behave identically in generate-gas-key,
// fund-gas-key, create-tree and read-tree, and a script can't silently
// default to devnet when the caller meant mainnet (or vice versa).
export function resolveCluster(argv) {
  const rpcArg = argv.find((a) => a.startsWith("--rpc="));
  const explicitRpc = rpcArg ? rpcArg.slice("--rpc=".length) : null;

  const wantsMainnet = argv.includes("--mainnet");
  const wantsDevnet = argv.includes("--devnet");

  if (wantsMainnet && wantsDevnet) {
    throw new Error("Pass either --mainnet or --devnet, not both.");
  }

  if (explicitRpc) {
    // An explicit --rpc always wins; cluster label is inferred for
    // display/tree-info purposes only; it doesn't change any RPC calls.
    return {
      cluster: explicitRpc.includes("mainnet") ? "mainnet-beta" : wantsMainnet ? "mainnet-beta" : "devnet",
      endpoint: explicitRpc,
    };
  }

  if (wantsMainnet) {
    return { cluster: "mainnet-beta", endpoint: "https://api.mainnet-beta.solana.com" };
  }

  // Default: devnet. Explicit --devnet and "no flag at all" both land
  // here, so existing invocations without flags keep working exactly as
  // before this change.
  return { cluster: "devnet", endpoint: "https://api.devnet.solana.com" };
}

export function isMainnet(cluster) {
  return cluster === "mainnet-beta";
}
