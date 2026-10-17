// Copies the pure desk modules (src/lib/desk) and portfolio modules
// (src/lib/portfolio, written "pf:<name>") into each edge function's lib/ dir,
// rewriting relative imports to Deno's explicit ".ts" form, and fails when a
// copy drifts. Run after every change to src/lib/desk/* or src/lib/portfolio/*;
// the build check runs it with --check.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const MODS = ["types", "clock", "ta", "risk", "rules", "ledger", "stats", "vote", "playbook", "scan", "league"];
const PF_MODS = ["lots", "weekly", "report", "tick"];
const TARGETS = {
  tape: ["types", "clock", "ta"],
  desk: ["types", "clock", "risk", "rules", "vote", "playbook", "stats", "ledger", "ta", "scan"],
  "desk-scan": ["types", "clock", "risk", "rules", "ledger", "ta", "scan"],
  "desk-sync": ["types", "clock", "ledger", "risk"],
  "desk-review": ["types", "stats", "playbook", "league"],
  "desk-league": ["types", "clock", "risk", "rules", "ledger", "stats", "scan", "ta", "league"],
  pilot: ["types", "clock", "pf:lots", "pf:weekly", "pf:report", "pf:tick"],
};
const check = process.argv.includes("--check");
let drift = 0;
for (const [fn, mods] of Object.entries(TARGETS)) {
  const dir = `supabase/functions/${fn}/lib`;
  if (!check) mkdirSync(dir, { recursive: true });
  for (const m of mods) {
    const pf = m.startsWith("pf:");
    const name = pf ? m.slice(3) : m;
    if (!(pf ? PF_MODS : MODS).includes(name)) throw new Error(`unknown module ${m}`);
    // Deno wants explicit ".ts" specifiers, and every copy sits flat in lib/, so
    // "../desk/clock" and "./clock" both become "./clock.ts". Comment-only and blank
    // lines are dropped so the deploy payload stays under the MCP limit. Logic is untouched.
    const src = readFileSync(`src/lib/${pf ? "portfolio" : "desk"}/${name}.ts`, "utf8")
      .replace(/from "\.\.\/desk\/([a-z-]+)"/g, 'from "./$1.ts"')
      .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"')
      .split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//")).join("\n") + "\n";
    const out = `${dir}/${name}.ts`;
    if (check) { if (!existsSync(out) || readFileSync(out, "utf8") !== src) { console.error(`drift: ${out}`); drift++; } }
    else writeFileSync(out, src);
  }
}
if (check && drift) process.exit(1);
console.log(check ? "desk lib copies in sync" : "desk lib copies written");
