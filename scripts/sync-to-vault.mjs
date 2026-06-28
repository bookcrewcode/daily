#!/usr/bin/env node
// Nightly sync: pull today's data from the Daily app (Supabase) and write it
// into Ben's Obsidian daily note. Deterministic, no MCP needed.

import fs from "node:fs";
import path from "node:path";

const SUPABASE_URL = "https://pciljeqsrricybdnhvsu.supabase.co";
const ANON = "sb_publishable_pUix6c1Cx2GaJ1ZUzXJ32w_rJgGUYtZ";
const EMAIL = "bengarnet@gmail.com";
const PASSWORD = "lifeos2026";
const VAULT = "/Users/bengarnet/Library/Mobile Documents/iCloud~md~obsidian/Documents/Ben's brain ";

const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

async function api(token, p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  return r.json();
}

async function main() {
  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  const token = auth.access_token;
  if (!token) throw new Error("login failed: " + JSON.stringify(auth));

  const [dayArr, meals, lifts] = await Promise.all([
    api(token, `days?day=eq.${today}`),
    api(token, `meals?day=eq.${today}&order=created_at`),
    api(token, `lift_sets?day=eq.${today}&order=slot`),
  ]);
  const day = dayArr[0] || {};

  const wins = [
    ["💊💧 Meds + water", day.ws_meds],
    ["🍽️ Ate clean + logged", day.ws_eat],
    ["🏋️ Lifts", day.ws_lift],
    ["🧘 Stretch", day.ws_stretch],
    ["✍️ Vocab", day.ws_vocab],
    ["🐼 Chinese", day.ws_chinese],
    ["💼 BookCrew / research", day.ws_work],
  ];
  const score = wins.filter(([, v]) => v).length;

  let block = `<!-- APP-SYNC:START (auto from Daily app — do not edit by hand) -->\n`;
  block += `## 📲 From the Daily app\n`;
  block += `> Synced ${new Date().toLocaleString()} · **Win Stack ${score}/7**\n\n`;
  block += wins.map(([l, v]) => `- [${v ? "x" : " "}] ${l}`).join("\n") + "\n\n";
  block += `**🔥 Calories:** ${day.calories ?? 0} · **💪 Protein:** ${day.protein ?? 0} g`;
  if (day.bodyweight) block += ` · **⚖️ Weight:** ${day.bodyweight} lb`;
  if (day.vocab_count) block += ` · **✍️ Vocab words:** ${day.vocab_count}`;
  block += `\n`;
  if (meals.length) {
    block += `\n**🍎 Meals**\n` + meals.map((m) => `- ${m.name} — ${m.calories} kcal, ${m.protein}g`).join("\n") + "\n";
  }
  if (lifts.length) {
    const w = lifts[0].workout;
    block += `\n**🏋️ ${w}**\n` + lifts.map((s) => `- [${s.done ? "x" : " "}] ${s.exercise}${s.weight != null ? ` — ${s.weight} lb × ${s.reps ?? "?"}` : ""}`).join("\n") + "\n";
  }
  block += `<!-- APP-SYNC:END -->\n`;

  const file = path.join(VAULT, "10 Daily", `${today}.md`);
  let content;
  if (fs.existsSync(file)) {
    content = fs.readFileSync(file, "utf8");
    if (content.includes("<!-- APP-SYNC:START")) {
      content = content.replace(/<!-- APP-SYNC:START[\s\S]*?<!-- APP-SYNC:END -->\n?/, block);
    } else {
      content = content.trimEnd() + "\n\n" + block;
    }
  } else {
    content = `---\ntype: daily\ndate: ${today}\nxp: 0\ncreated: ${today}\ncssclasses:\n  - game\n---\n\n# 🗓️ ${today}\n\n` + block;
  }
  fs.writeFileSync(file, content);
  console.log(`[sync] ${today}: wins ${score}/7, ${meals.length} meals, ${lifts.length} lifts → ${file}`);
}

main().catch((e) => { console.error("[sync] FAILED", e); process.exit(1); });
