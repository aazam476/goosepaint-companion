// @solana/spl-account-compression@0.4.1 ships a broken `main`/`exports`
// pointer: package.json says the entry is ./dist/cjs/index.js, but the
// actual compiled output landed one directory deeper, at
// ./dist/cjs/src/index.js (this is a known packaging bug in that
// release, not a mistake in this project). Left unpatched, `require()`
// or a bundler's exports-map resolution (which both Node and esbuild —
// what `wrangler` uses for Cloudflare Pages Functions — enforce) fails
// with MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED, even though the
// working code is right there on disk.
//
// This runs as a postinstall step so a fresh `npm install` (including
// Cloudflare's own build step) always ends up with a working package,
// without needing a maintained fork or a lockfile-breaking patch tool.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, "..", "node_modules", "@solana", "spl-account-compression");
const pkgJsonPath = join(pkgDir, "package.json");

if (!existsSync(pkgJsonPath)) {
  console.log("[patch-spl-account-compression] package not installed, skipping");
  process.exit(0);
}

const realEntry = join(pkgDir, "dist", "cjs", "src", "index.js");
if (!existsSync(realEntry)) {
  console.warn(
    "[patch-spl-account-compression] expected compiled file not found at " +
      realEntry +
      " — package layout may have changed; skipping patch."
  );
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const fixedMain = "./dist/cjs/src/index.js";
const fixedTypes = "./dist/types/src/index.d.ts";

let changed = false;
if (pkg.main !== fixedMain) {
  pkg.main = fixedMain;
  changed = true;
}
if (pkg.module !== fixedMain) {
  pkg.module = fixedMain;
  changed = true;
}
if (pkg.exports && pkg.exports["."]) {
  if (pkg.exports["."].require !== fixedMain || pkg.exports["."].import !== fixedMain) {
    pkg.exports["."].require = fixedMain;
    pkg.exports["."].import = fixedMain;
    changed = true;
  }
  if (existsSync(join(pkgDir, "dist", "types", "src", "index.d.ts"))) {
    pkg.exports["."].types = fixedTypes;
    pkg.types = fixedTypes;
  }
}

if (changed) {
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("[patch-spl-account-compression] patched main/exports to " + fixedMain);
} else {
  console.log("[patch-spl-account-compression] already patched, nothing to do");
}
