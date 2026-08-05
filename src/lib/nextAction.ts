// What should Ben actually do right now?
//
// This is the app's whole thesis in one function. The old app was a pile of
// trackers: it ASKED for input on every screen and gave nothing back. This
// gives first — it looks at the real data and names ONE next action, why it
// matters, and the 2-minute version for when he's stalling.
//
// Deliberately DETERMINISTIC — no AI call. The front door has to work even when
// the key is missing, offline, or the model is slow. AI can enrich it later; it
// must never be required for the app to be useful.

export type Signal = {
  streakAtRisk: boolean;      // wins logged today?
  winsToday: number;
  dueCards: number;           // spaced-repetition cards ready
  urgentGoal: { title: string; days: number } | null;
  coldRow: { name: string; rep: string; minVersion: string } | null;  // Engine row with no vote today
  constraint: string;         // the week's one bottleneck
  unloggedMeds: boolean;
  hour: number;               // local hour, for time-of-day judgement
};

export type Action = {
  key: string;
  title: string;              // the directive
  why: string;                // one line of context — never nagging
  micro: string;              // the 2-minute version
  tab: string;                // where the button goes
  tone: "urgent" | "normal" | "calm";
};

// Ordered by what actually matters, not by what's easiest to nag about.
export function pickAction(s: Signal): Action {
  // 1) A streak about to break, late enough in the day that it's real
  if (s.streakAtRisk && s.hour >= 17) {
    return {
      key: "streak",
      title: "Protect the streak — one win",
      why: `Nothing logged today, and it's ${s.hour >= 21 ? "late" : "getting late"}.`,
      micro: "Meds, or a glass of water. One box.",
      tab: "today",
      tone: "urgent",
    };
  }

  // 2) Retention: cards go stale fast, and this is the whole point of learning
  if (s.dueCards >= 1) {
    const mins = Math.max(1, Math.round(s.dueCards * 0.25));
    return {
      key: "review",
      title: `${s.dueCards} card${s.dueCards === 1 ? "" : "s"} ready to review`,
      why: `About ${mins} minute${mins === 1 ? "" : "s"}. This is the part that makes it stick.`,
      micro: "Do five and stop. Five still counts.",
      tab: "learning",
      tone: s.dueCards >= 20 ? "urgent" : "normal",
    };
  }

  // 3) A goal with a real deadline closing in
  if (s.urgentGoal && s.urgentGoal.days <= 14) {
    const d = s.urgentGoal.days;
    return {
      key: "goal",
      title: s.urgentGoal.title,
      why: d <= 0 ? "Due today." : `${d} day${d === 1 ? "" : "s"} left.`,
      micro: "Open it and do the smallest next step.",
      tab: "goals",
      tone: d <= 3 ? "urgent" : "normal",
    };
  }

  // 4) An identity rep not cast today — the Engine is his own framework
  if (s.coldRow) {
    return {
      key: "rep",
      title: s.coldRow.rep,
      why: `${s.coldRow.name} — no vote cast today.`,
      micro: s.coldRow.minVersion || "Do the 2-minute version.",
      tab: "today",
      tone: "normal",
    };
  }

  // 5) The week's constraint — the one bottleneck worth moving
  if (s.constraint) {
    return {
      key: "constraint",
      title: s.constraint,
      why: "This week's one bottleneck. Everything else is maintenance.",
      micro: "Fifteen minutes on it beats a perfect plan.",
      tab: "plan",
      tone: "normal",
    };
  }

  // 6) Nothing pressing — say so honestly instead of inventing a chore
  if (s.winsToday > 0) {
    return {
      key: "clear",
      title: "You're clear",
      why: `${s.winsToday} win${s.winsToday === 1 ? "" : "s"} logged, nothing overdue.`,
      micro: "Learn something, or genuinely stop.",
      tab: "learning",
      tone: "calm",
    };
  }

  return {
    key: "start",
    title: "Start the day with one box",
    why: "Momentum beats planning. Pick the easiest one.",
    micro: "Meds or water — ten seconds.",
    tab: "today",
    tone: "normal",
  };
}
