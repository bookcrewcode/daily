// Bundles an edge function (index.ts + its lib copies) into ONE tree-shaken,
// whitespace-minified file at supabase/functions/<fn>/dist/index.ts, so the
// deploy payload stays under the MCP limit. Sources stay readable in git;
// dist/ is ignored. Usage: node scripts/desk-bundle.mjs desk
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const fn = process.argv[2];
if (!fn) { console.error("usage: node scripts/desk-bundle.mjs <function>"); process.exit(1); }
execSync("node scripts/desk-sync-libs.mjs", { stdio: "inherit" });
mkdirSync(`supabase/functions/${fn}/dist`, { recursive: true });
execSync(`npx --yes esbuild@0.24.2 supabase/functions/${fn}/index.ts --bundle --format=esm --platform=neutral --target=esnext --minify-whitespace --minify-syntax --legal-comments=none --outfile=supabase/functions/${fn}/dist/index.ts`, { stdio: "inherit" });
const out = readFileSync(`supabase/functions/${fn}/dist/index.ts`, "utf8");
writeFileSync(`supabase/functions/${fn}/dist/payload.json`, JSON.stringify([{ name: "index.ts", content: out }]));
console.log(`${fn}: ${out.length} bytes bundled → dist/index.ts (+ payload.json for the MCP deploy call)`);
