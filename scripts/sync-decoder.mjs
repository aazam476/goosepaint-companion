// Regenerates constants/decoderHtml.ts from public/decoder.html so the
// native WebView (which needs the HTML as an inline JS string) and the
// mobile-web iframe (which loads the same file as a static asset) never
// drift apart. Run this after any edit to public/decoder.html.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const html = readFileSync(join(root, "public/decoder.html"), "utf8");
const out =
  "// Auto-generated from public/decoder.html — do NOT hand-edit.\n" +
  "// Run `npm run sync-decoder` after changing public/decoder.html to regenerate.\n" +
  "export const DECODER_HTML = " + JSON.stringify(html) + ";\n";

writeFileSync(join(root, "constants/decoderHtml.ts"), out);
console.log(`Synced constants/decoderHtml.ts (${out.length} bytes)`);
