import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEAGUE, teamKey, draftTeams, rankTiers, teamName, poolStanding, deathLine, sessionDue, leagueSettings, isPassive, rankScore, inHours, type TeamLike } from "./league";

test("the draft deals one team per frontier, every team on the same crew, tiers interleaved, keys unique", () => {
  const teams = draftTeams(DEFAULT_LEAGUE);
  assert.equal(teams.length, 9);
  assert.equal(new Set(teams.map((t) => t.frontier)).size, 9);
  assert.equal(new Set(teams.map((t) => t.key)).size, 9);
  for (const t of teams) { assert.deepEqual(t.workers, DEFAULT_LEAGUE.worker_pool); assert.equal(t.key, teamKey(t.frontier, t.ordinal)); assert.equal(t.ordinal, 1); }
  assert.equal(teams.filter((t) => t.tier === "diamond").length, 3);
  assert.equal(teams.filter((t) => t.tier === "bronze").length, 3);
});

test("a frontier pool smaller than the league gives a frontier a second team with its own life", () => {
  const teams = draftTeams(leagueSettings({ frontier_pool: ["a/x", "b/y"], teams_per_tier: 1 }));
  assert.deepEqual(teams.map((t) => t.key), ["a/x#1", "b/y#1", "a/x#2"]);
  assert.equal(teamName("a/x", 2), "X II");
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
  assert.equal(teamName("x-ai/grok-4.3", 1), "Grok 4.3 I");
  const teams: TeamLike[] = [
    { frontier: "a/x", workers: [], status: "dead", return_pct: -5 },
    { frontier: "a/x", workers: [], status: "live", return_pct: 3 },
    { frontier: "a/z", workers: [], status: "live", return_pct: 1, score: -1 },
  ];
  assert.equal(poolStanding("a/x", teams), -1); // (−5 + 3) / 2: a frontier is judged on every team it has led, dead ones included
  assert.equal(poolStanding("a/z", teams), -1); // the ranked return when the team has one
  assert.equal(poolStanding("nobody", teams), null);
  assert.equal(deathLine(100000, 5), 95000);
  assert.equal(sessionDue(9, 36, ["09:35", "15:15"]), "09:35");
  assert.equal(sessionDue(9, 41, ["09:35"]), null);
  const s = leagueSettings({ death_pct: 99, risk_max_pct: 0, frontier_pool: ["bad id"], research: "off", worker_lookups: 9, hours: { stocks: ["9", "17:00"], crypto: ["10:00", "23:00"] } });
  assert.equal(s.death_pct, 50); assert.equal(s.risk_max_pct, 0.5); assert.equal(s.frontier_pool, DEFAULT_LEAGUE.frontier_pool); assert.equal(s.research, "off");
  assert.equal(s.worker_lookups, 2);
  assert.deepEqual(s.hours.stocks, DEFAULT_LEAGUE.hours.stocks); // a malformed pair falls back on its own
  assert.deepEqual(s.hours.crypto, ["10:00", "23:00"]);
  assert.equal(leagueSettings({}).budget_usd_day, 5);
});

test("the trading hours: stocks 09:00 to 17:00, crypto 09:00 to 22:00, start in, end out, a window may cross midnight", () => {
  const s = leagueSettings({});
  assert.equal(inHours("robinhood", 9, 0, s), true);
  assert.equal(inHours("robinhood", 16, 59, s), true);
  assert.equal(inHours("robinhood", 17, 0, s), false);
  assert.equal(inHours("blofin", 21, 59, s), true);
  assert.equal(inHours("blofin", 22, 0, s), false);
  assert.equal(inHours("blofin", 3, 0, s), false);
  const night = leagueSettings({ hours: { stocks: ["09:00", "17:00"], crypto: ["20:00", "02:00"] } });
  assert.equal(inHours("blofin", 1, 0, night), true);
  assert.equal(inHours("blofin", 12, 0, night), false);
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
