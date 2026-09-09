import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEAGUE, comboKey, draftTeams, replacementTeam, rankTiers, teamName, poolStanding, deathLine, sessionDue, leagueSettings, isPassive, rankScore, type TeamLike } from "./league";

test("the draft deals nine unique teams, four distinct workers each, every worker used about equally, tiers interleaved", () => {
  const teams = draftTeams(DEFAULT_LEAGUE);
  assert.equal(teams.length, 9);
  assert.equal(new Set(teams.map((t) => t.combo)).size, 9);
  assert.equal(new Set(teams.map((t) => t.frontier)).size, 9);
  for (const t of teams) { assert.equal(t.workers.length, 4); assert.equal(new Set(t.workers).size, 4); assert.equal(t.combo, comboKey(t.frontier, t.workers)); }
  const use = new Map<string, number>();
  for (const t of teams) for (const w of t.workers) use.set(w, (use.get(w) ?? 0) + 1);
  for (const [, n] of use) assert.ok(n >= 2 && n <= 3, `a worker sits ${n} times`);
  assert.deepEqual(teams.map((t) => t.tier).filter((x) => x === "diamond").length, 3);
  assert.deepEqual(teams.map((t) => t.tier).filter((x) => x === "bronze").length, 3);
});

test("a replacement never repeats a set and does not hand the seat straight back to the frontier that just died", () => {
  const drafted = draftTeams(DEFAULT_LEAGUE);
  const teams: TeamLike[] = drafted.map((t, i) => ({ id: `t${i}`, frontier: t.frontier, workers: t.workers, status: "live", return_pct: i === 8 ? -5.2 : 0.4 }));
  teams[8].status = "dead";
  const r = replacementTeam(DEFAULT_LEAGUE, teams);
  assert.ok(r);
  assert.ok(!teams.some((t) => comboKey(t.frontier, t.workers) === r!.combo));
  assert.notEqual(r!.frontier, teams[8].frontier);
  assert.equal(r!.workers.length, 4);
  assert.equal(new Set(r!.workers).size, 4);
});

test("tiers follow percent return, three per tier", () => {
  const teams: TeamLike[] = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, frontier: `f/${i}`, workers: [], status: "live", return_pct: i - 4 }));
  const ranked = rankTiers(teams, 3);
  assert.equal(ranked[0].id, "t8"); assert.equal(ranked[0].tier, "diamond");
  assert.equal(ranked[3].tier, "gold"); assert.equal(ranked[8].tier, "bronze"); assert.equal(ranked[8].id, "t0");
});

test("names, standing, the death line, session windows, settings ranges", () => {
  assert.equal(teamName("openai/gpt-6-astra", 2), "Astra II");
  assert.equal(teamName("some-lab/new-model-9000", 4), "New Model 9000 IV");
  const teams: TeamLike[] = [{ frontier: "a/x", workers: ["b/y"], status: "dead", return_pct: -5 }, { frontier: "a/z", workers: ["b/y"], status: "live", return_pct: 3 }];
  assert.equal(poolStanding("a/x", teams), -5);
  assert.equal(poolStanding("b/y", teams), -1); // (0.5·−5 + 0.5·3) / 1
  assert.equal(poolStanding("nobody", teams), null);
  assert.equal(deathLine(100000, 5), 95000);
  assert.equal(sessionDue(8, 46, ["08:45", "15:15"]), "08:45");
  assert.equal(sessionDue(8, 51, ["08:45"]), null);
  const s = leagueSettings({ death_pct: 99, risk_max_pct: 0, frontier_pool: ["bad id"], research: "off" });
  assert.equal(s.death_pct, 50); assert.equal(s.risk_max_pct, 0.5); assert.equal(s.frontier_pool, DEFAULT_LEAGUE.frontier_pool); assert.equal(s.research, "off");
});

test("playing to survive is penalised in the ranking: a passive day docks the ranked return and the score orders the tiers", () => {
  const s = leagueSettings({});
  assert.equal(isPassive(1, 2, s), true);   // one take, 2% at risk
  assert.equal(isPassive(2, 2, s), false);  // enough takes
  assert.equal(isPassive(0, 5, s), false);  // enough at risk
  assert.equal(rankScore(0.8, 2, s), -1.2);
  const teams: TeamLike[] = [
    { id: "hides", frontier: "f/a", workers: [], status: "live", return_pct: 0.8, score: rankScore(0.8, 2, s) },
    { id: "plays", frontier: "f/b", workers: [], status: "live", return_pct: -0.5, score: rankScore(-0.5, 0, s) },
  ];
  assert.equal(rankTiers(teams, 1)[0].id, "plays");
});
