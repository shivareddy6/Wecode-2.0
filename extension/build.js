#!/usr/bin/env node
// Epic 02, Story 1/2 — produces a ready-to-load unpacked extension folder
// with the API base baked in at build time, per environment. There's no
// deployed WeCode domain yet (that's Epic 09), so `--env=prod` deliberately
// refuses to build a fake one — set WECODE_PROD_API_BASE once that exists.
const fs = require("node:fs");
const path = require("node:path");

const SRC_DIR = path.join(__dirname, "src");
const DIST_DIR = path.join(__dirname, "dist");

const env = process.argv.includes("--env=prod") ? "prod" : "dev";

const apiBase =
  env === "dev" ? "http://localhost:3000" : process.env.WECODE_PROD_API_BASE;

if (!apiBase) {
  console.error(
    "WECODE_PROD_API_BASE is not set — there's no deployed WeCode domain yet " +
      "(Epic 09). Build the dev variant instead: node extension/build.js --env=dev",
  );
  process.exit(1);
}

const apiOrigin = new URL(apiBase).origin;

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.cpSync(SRC_DIR, DIST_DIR, { recursive: true });

const manifestPath = path.join(DIST_DIR, "manifest.json");
const manifest = fs.readFileSync(manifestPath, "utf8").replace(
  /__API_ORIGIN__/g,
  apiOrigin,
);
fs.writeFileSync(manifestPath, manifest);

fs.writeFileSync(
  path.join(DIST_DIR, "config.js"),
  `const WECODE_CONFIG = ${JSON.stringify({ apiBase: apiOrigin }, null, 2)};\n`,
);

console.log(`Built ${env} extension -> ${path.relative(process.cwd(), DIST_DIR)} (apiBase: ${apiOrigin})`);
