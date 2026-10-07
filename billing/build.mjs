// Builds the compass-billing Vercel project with the Build Output API
// (https://vercel.com/docs/build-output-api/v3): each endpoint is bundled by
// esbuild — the handlers under supabase/functions/ included — into one
// self-contained Node function, and the daily reconciliation is declared as a
// Vercel Cron job. Vercel runs `npm run build` in billing/ and deploys
// .vercel/output as is.
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";

const OUT = ".vercel/output";
// path → entry, max duration (seconds)
const FUNCTIONS = [
  ["api/billing", "src/entries/billing.ts", 60],
  ["api/stripe/webhook", "src/entries/webhook.ts", 60],
  ["api/reconcile", "src/entries/reconcile.ts", 60],
];
// Daily, 06:17 UTC (the Vercel Cron bearer is CRON_SECRET).
const CRONS = [{ path: "/api/reconcile", schedule: "17 6 * * *" }];

await rm(OUT, { recursive: true, force: true });
for (const [path, entry, maxDuration] of FUNCTIONS) {
  const dir = `${OUT}/functions/${path}.func`;
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: `${dir}/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["pg-native"],
    legalComments: "none",
    logLevel: "warning",
  });
  await writeFile(`${dir}/.vc-config.json`, JSON.stringify({
    runtime: "nodejs22.x",
    handler: "index.js",
    launcherType: "Nodejs",
    shouldAddHelpers: false,
    maxDuration,
  }, null, 2));
}
await writeFile(`${OUT}/config.json`, JSON.stringify({ version: 3, crons: CRONS }, null, 2));
console.log(`built ${FUNCTIONS.length} functions and ${CRONS.length} cron job into ${OUT}`);
