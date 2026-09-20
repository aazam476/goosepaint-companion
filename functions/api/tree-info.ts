// Public read-only endpoint so any client (this app, or the future
// Doomscroll viewer) can discover which tree to watch without
// hardcoding the address in multiple codebases.
interface Env {
  TREE_ADDRESS: string;
  SOLANA_RPC_URL?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return new Response(
    JSON.stringify({
      treeAddress: env.TREE_ADDRESS ?? null,
      cluster: env.SOLANA_RPC_URL?.includes("mainnet") ? "mainnet-beta" : "devnet",
    }),
    { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
};
