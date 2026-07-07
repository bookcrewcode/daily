#!/usr/bin/env node
// Two-way sync between the Daily app (Supabase) and Ben's Obsidian daily note.
//
// App → Vault: habits, calories/protein/weight, meals, lifts, Top 3.
// Vault → App: the native "## 💪 Habits" checklist and "## 🎯 Top 3 today" list are
//   read back and merged into Supabase. Habit merge is UNION-only (OR logic) — ticking
//   either surface counts, and we never un-check something that's already true.
//   Top 3 is vault-authoritative when it has content (that's where mornings get planned).

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

async function api(token, p, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
    method: opts.method ?? "GET",
    body: opts.body,
  });
  return r.status === 204 ? null : r.json();
}

// ── Vault-side parsing helpers ───────────────────────────────────────
function sectionLines(content, heading) {
  const re = new RegExp(`## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = content.match(re);
  return m ? m[1].split("\n") : [];
}

// Native Habits checklist → which win-stack keys it can affect (Read has no app equivalent).
const HABIT_MAP = [
  { needle: /gym/i, keys: ["ws_lift"] },
  { needle: /chinese/i, keys: ["ws_chinese"] },
  { needle: /vocab/i, keys: ["ws_vocab"] },
  { needle: /meds.*water|water.*meds/i, keys: ["ws_meds", "ws_water"] },
];

function parseVaultHabits(content) {
  const lines = sectionLines(content, "💪 Habits");
  const ticked = new Set();
  for (const line of lines) {
    const isChecked = /^- \[x\]/i.test(line.trim());
    if (!isChecked) continue;
    for (const { needle, keys } of HABIT_MAP) {
      if (needle.test(line)) keys.forEach((k) => ticked.add(k));
    }
  }
  return ticked;
}

function parseVaultTop3(content) {
  const lines = sectionLines(content, "🎯 Top 3 today");
  return lines
    .map((l) => l.replace(/^- \[[ x]\]\s?/i, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 3);
}

// Rewrite the native Habits checklist to reflect the merged (union) state —
// only ever adds checkmarks, never removes one.
function applyHabitsToVault(content, merged) {
  const re = /(## 💪 Habits[^\n]*\n)([\s\S]*?)(?=\n## |$)/;
  return content.replace(re, (full, heading, body) => {
    const newBody = body.split("\n").map((line) => {
      if (!/^- \[ \]/i.test(line.trim())) return line;
      const shouldCheck = HABIT_MAP.some(({ needle, keys }) => needle.test(line) && keys.some((k) => merged[k]));
      return shouldCheck ? line.replace(/^(\s*- )\[ \]/i, "$1[x]") : line;
    }).join("\n");
    return heading + newBody;
  });
}

// ── Learning Hub → vault project notes ────────────────────────────────
// Each active topic gets/updates a note in "30 Areas/Learning/Projects/<title>.md"
// (created from the Learning Project Template shape if missing). Only the
// Retrieval log / Weak spots / Brain dumps sections are regenerated each run —
// fully derived from Supabase, source of truth = the app. The Tree, Goal/Why,
// and Roadmap sections are hand-authored and NEVER touched by this sync.
function replaceSection(content, heading, newBody) {
  const re = new RegExp(`(## ${heading}[^\\n]*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (re.test(content)) return content.replace(re, (full, h) => h + newBody);
  return content.trimEnd() + `\n\n## ${heading}\n${newBody}`;
}

async function syncLearningTopics(token, userId) {
  const topics = await api(token, `learning_topics?user_id=eq.${userId}&status=eq.active`);
  const projectsDir = path.join(VAULT, "30 Areas", "Learning", "Projects");
  if (!fs.existsSync(projectsDir)) return;

  for (const t of topics ?? []) {
    const file = path.join(projectsDir, `${t.title}.md`);
    let content;
    if (fs.existsSync(file)) {
      content = fs.readFileSync(file, "utf8");
    } else {
      content = `---\ntype: learning\nstatus: active\ntopic: "${t.title}"\nstarted: ${today}\nnext: \ntags: [area/learning]\ncssclasses: [game]\n---\n\n# 🌳 ${t.title}\n\n> [!note] Built on [[The 3C Protocol (Learning System)]]. Synced from the Daily app.\n> **Goal:** ${t.goal || ""}\n> **Why:** ${t.why || ""}\n\n## 🌳 The Tree (first principles)\n- **Trunk:** ${t.trunk || ""}\n- **Branches:**\n${(t.branches ?? []).map((b) => `  - ${b}`).join("\n") || "  - "}\n- **Leaves:** ${t.leaves || ""}\n\n## 🗺️ Roadmap (90-min blocks)\n- [ ] Block 1 — \n\n## 🔁 Retrieval log (free recall, no peeking)\n\n## ⚠️ Weak spots (loop these back until they stick)\n\n## 🧠 Brain dumps\n\n## ▶️ Where I am / next\n- \n\n→ [[Learning Hub]]\n`;
    }

    const [retrieval, weakSpots, sessions] = await Promise.all([
      api(token, `learning_retrieval?topic_id=eq.${t.id}&order=created_at.desc&limit=30`),
      api(token, `learning_weak_spots?topic_id=eq.${t.id}&resolved=eq.false`),
      api(token, `learning_sessions?topic_id=eq.${t.id}&order=created_at.desc&limit=10`),
    ]);

    const rlBody = (retrieval ?? []).length
      ? "| Date | Question | Got it? |\n|------|----------|---------|\n" +
        retrieval.map((r) => `| ${r.created_at.slice(0, 10)} | ${r.question.replace(/\|/g, "/")} | ${r.got_it ? "✅" : "❌"} |`).join("\n") + "\n"
      : "| Date | Question | Got it? |\n|------|----------|---------|\n|      |          |         |\n";
    content = replaceSection(content, "🔁 Retrieval log", rlBody);

    const wsBody = (weakSpots ?? []).length
      ? weakSpots.map((w) => `- [ ] ${w.text}`).join("\n") + "\n"
      : "- [ ] \n";
    content = replaceSection(content, "⚠️ Weak spots", wsBody);

    const dumps = (sessions ?? []).filter((s) => s.brain_dump?.trim());
    const bdBody = dumps.length
      ? dumps.map((s) => `**${s.day}:** ${s.brain_dump}`).join("\n\n") + "\n"
      : "- \n";
    content = replaceSection(content, "🧠 Brain dumps", bdBody);

    fs.writeFileSync(file, content);
  }
  if ((topics ?? []).length) console.log(`[sync] learning: ${topics.length} topic(s) synced to vault`);
}

async function main() {
  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json());
  const token = auth.access_token;
  if (!token) throw new Error("login failed: " + JSON.stringify(auth));
  const userId = auth.user?.id;

  const file = path.join(VAULT, "10 Daily", `${today}.md`);
  const vaultExists = fs.existsSync(file);
  const vaultContent = vaultExists ? fs.readFileSync(file, "utf8") : "";

  // ── VAULT → APP ──────────────────────────────────────────────────
  const [dayArr, nightArr] = await Promise.all([
    api(token, `days?day=eq.${today}`),
    api(token, `nights?day=eq.${today}`),
  ]);
  const currentDay = dayArr[0] || {};
  const currentNight = nightArr[0] || {};

  const vaultTicked = parseVaultHabits(vaultContent);
  const merged = { ...currentDay };
  let changed = false;
  for (const key of ["ws_lift", "ws_chinese", "ws_vocab", "ws_meds", "ws_water"]) {
    const union = !!currentDay[key] || vaultTicked.has(key);
    if (union !== !!currentDay[key]) changed = true;
    merged[key] = union;
  }
  if (changed) {
    await api(token, "days", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: currentDay.user_id, day: today, ...merged }),
    });
  }

  const vaultTop3 = parseVaultTop3(vaultContent);
  if (vaultTop3.length > 0 && JSON.stringify(vaultTop3) !== JSON.stringify(currentNight.top3 ?? [])) {
    await api(token, "nights", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: currentDay.user_id ?? currentNight.user_id, day: today, top3: vaultTop3, items: currentNight.items ?? [], notes: currentNight.notes ?? "" }),
    });
  }

  // ── APP → VAULT (re-read post-merge so the vault shows the true state) ──
  const [dayFinalArr, meals, lifts, nightFinalArr] = await Promise.all([
    api(token, `days?day=eq.${today}`),
    api(token, `meals?day=eq.${today}&order=created_at`),
    api(token, `lift_sets?day=eq.${today}&order=slot`),
    api(token, `nights?day=eq.${today}`),
  ]);
  const day = dayFinalArr[0] || {};
  const night = nightFinalArr[0] || {};

  const wins = [
    ["💊 Meds", day.ws_meds], ["💧 Water", day.ws_water], ["🍽️ Ate clean + logged", day.ws_eat],
    ["🏋️ Lifts", day.ws_lift], ["🧘 Stretch", day.ws_stretch], ["😴 Slept 7+", day.ws_sleep],
    ["✍️ Vocab", day.ws_vocab], ["🐼 Chinese", day.ws_chinese], ["📚 School", day.ws_school],
    ["💼 BookCrew / research", day.ws_work],
  ];
  const score = wins.filter(([, v]) => v).length;

  let block = `<!-- APP-SYNC:START (auto from Daily app — two-way, do not edit by hand) -->\n`;
  block += `## 📲 From the Daily app\n`;
  block += `> Synced ${new Date().toLocaleString()} · **Win Stack ${score}/${wins.length}**\n\n`;
  block += wins.map(([l, v]) => `- [${v ? "x" : " "}] ${l}`).join("\n") + "\n\n";
  block += `**🔥 Calories:** ${day.calories ?? 0} · **💪 Protein:** ${day.protein ?? 0} g`;
  if (day.bodyweight) block += ` · **⚖️ Weight:** ${day.bodyweight} lb`;
  if (day.vocab_count) block += ` · **✍️ Vocab words:** ${day.vocab_count}`;
  block += `\n`;
  if (night.top3?.some((t) => t?.trim())) {
    block += `\n**🎯 Top 3 (from the app)**\n` + night.top3.filter((t) => t?.trim()).map((t) => `- ${t}`).join("\n") + "\n";
  }
  if (meals.length) {
    block += `\n**🍎 Meals**\n` + meals.map((m) => `- ${m.name} — ${m.calories} kcal, ${m.protein}g`).join("\n") + "\n";
  }
  if (lifts.length) {
    const w = lifts[0].workout;
    block += `\n**🏋️ ${w}**\n` + lifts.map((s) => `- [${s.done ? "x" : " "}] ${s.exercise}${s.weight != null ? ` — ${s.weight} lb × ${s.reps ?? "?"}` : ""}`).join("\n") + "\n";
  }
  block += `<!-- APP-SYNC:END -->\n`;

  let content;
  if (vaultExists) {
    content = vaultContent;
    if (content.includes("<!-- APP-SYNC:START")) {
      content = content.replace(/<!-- APP-SYNC:START[\s\S]*?<!-- APP-SYNC:END -->\n?/, block);
    } else {
      content = content.trimEnd() + "\n\n" + block;
    }
    content = applyHabitsToVault(content, day);
  } else {
    content = `---\ntype: daily\ndate: ${today}\nxp: 0\ncreated: ${today}\ncssclasses:\n  - game\n---\n\n# 🗓️ ${today}\n\n` + block;
  }
  fs.writeFileSync(file, content);
  console.log(`[sync] ${today}: wins ${score}/${wins.length}, ${meals.length} meals, ${lifts.length} lifts, vault-habits merged: ${changed} → ${file}`);

  if (userId) await syncLearningTopics(token, userId);
}

main().catch((e) => { console.error("[sync] FAILED", e); process.exit(1); });
