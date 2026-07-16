# Daily — Grading System

Every release is graded section-by-section by independent review agents before it counts
as done. A section **passes** when it has **zero confirmed critical or major defects**
and earns **B+ or higher**. The app ships only when every section passes.

## Severity

- **Critical** — data loss, XP corruption, a write that silently fails while the UI
  celebrates, a crash, or a bricked flow (e.g. a chat thread that 400s forever).
- **Major** — wrong numbers shown or banked, midnight/rollover corruption, a race that
  drops user input, dedupe that can double-pay XP, a broken primary action.
- **Minor** — visual glitches, awkward copy, missed edge cases with easy workarounds.

## The rubric (what graders check)

1. **Write-first, celebrate-second.** Every XP toast, confetti burst, or "saved ✓" must
   happen only AFTER the insert/update resolved without `{error}`. On failure, the
   user's input stays put with a retry note. (This is the #1 recurring defect class.)
2. **supabase-js v2 resolves errors** — it never throws on DB errors. Any `await` on a
   query that ignores `{error}` and then acts as if it succeeded is a defect.
3. **Midnight rollover.** Every date-keyed component (anything using todayStr/dateStr)
   must survive a PWA left open across midnight: visibilitychange + interval guards,
   no stale day writes.
4. **XP economy sync.** The client (`src/lib/gamification.ts` + `useGameData.ts`) and
   the advisor edge function's `context()` math must award identical XP. New XP
   sources must appear in BOTH, or be quest_claims-based (which both sides sum).
   Bonus-row quest keys (`sweep`, `weekly_review`, `chest_*`, `boss_*`, `gstep_*`,
   `month_*`) must stay excluded from the daily-quest achievement counter.
5. **Dedupe discipline.** Anything claimable must have DB-level dedupe (unique
   constraints), not just UI state: quests per day, boss per week (day=Monday),
   monthly review per month, achievements per key.
6. **Races and stale closures.** Serialized triage, ref-guards on async replies
   landing after tab switches, effects reading fresh state not captured state.
7. **ADHD fit (product bar, not just code).** One bolded next action per screen, 2-minute
   starters, urgency framed as countdowns not shame, RSD-safe copy (never "you failed"),
   friction ≤ 2 taps for daily-loop actions.
8. **Design consistency.** Tokens (`--neon`, `--font-display`), Card/SectionTitle
   patterns, active:scale feedback, dark-first.
9. **Fixed/fullscreen UI** must portal to document.body — Cards with backdrop-filter
   are containing blocks that trap `position: fixed` children.
10. **Honest reporting.** Partial failures say exactly what happened (e.g. calendar
    push "3 of 5 landed — check before retrying"); never claim success on partial writes.

## Sections graded

Today (page shell, Scoreboard, Quests, UrgencyCard, BriefingCard, Overseer, BossCard) ·
Plan (+ MonthlyReview, NowScreen) · Food (+ FoodSearch) · Lifts · Goals (+ steps) ·
Learning (+ TutorChat) · Affirmations · Night (+ calendar push) · Tools · Board (AI chat,
memory) · Game core (gamification.ts, useGameData.ts) · Advisor edge function.

## Process

1. One grader agent per section reads the actual source and grades against this rubric.
2. Every critical/major finding goes to adversarial verification (independent agents try
   to refute it against the code).
3. Confirmed findings get fixed; the section is re-graded.
4. Repeat until every section passes. Findings that don't survive verification are noted
   but don't block.
