// Copies the pure desk modules into each edge function's lib/ dir, rewriting
// relative imports to Deno's explicit ".ts" form, and fails when a copy drifts.
// Run after every change to src/lib/desk/*; the build check runs it with --check.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const MODS = ["types", "clock", "ta", "risk", "rules", "ledger", "stats", "vote", "playbook", "scan"];
const TARGETS = {
  tape: ["types", "clock", "ta"],
  desk: ["types", "clock", "risk", "rules", "vote", "playbook", "stats", "ledger", "ta", "scan"],
  "desk-scan": ["types", "clock", "risk", "rules", "ledger", "ta", "scan"],
  "desk-sync": ["types", "clock", "ledger", "risk"],
  "desk-review": ["types", "stats", "playbook"],
};
const check = process.argv.includes("--check");
let drift = 0;
for (const [fn, mods] of Object.entries(TARGETS)) {
  const dir = `supabase/functions/${fn}/lib`;
  if (!check) mkdirSync(dir, { recursive: true });
  for (const m of mods) {
    if (!MODS.includes(m)) throw new Error(`unknown module ${m}`);
    // Deno wants explicit ".ts" specifiers; comment-only and blank lines are
    // dropped so the deploy payload stays under the MCP limit. Logic is untouched.
    const src = readFileSync(`src/lib/desk/${m}.ts`, "utf8")
      .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"')
      .split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//")).join("\n") + "\n";
    const out = `${dir}/${m}.ts`;
    if (check) { if (!existsSync(out) || readFileSync(out, "utf8") !== src) { console.error(`drift: ${out}`); drift++; } }
    else writeFileSync(out, src);
  }
}
if (check && drift) process.exit(1);
console.log(check ? "desk lib copies in sync" : "desk lib copies written");
