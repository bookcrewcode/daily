"use client";

// Learn — the desk as a course. The Journal (every trade broken down, on the
// chart, with everything it used and its micro review), the macro review (what
// is working across trades, strategies and models, and how to proceed), the
// strategies (the coded rules, explained) and the lessons (rules the reviews
// keep proposing, counted not believed). Every trading word is followed by its
// plain meaning until Ben taps "got it".

import { useState } from "react";
import { Segmented } from "../ui";
import Journal from "./Journal";
import MacroReview from "./MacroReview";
import Strategies from "./Strategies";
import Lessons from "./Lessons";
import { GLOSSARY, resetLearned, useLearned } from "./Term";
import type { Account } from "@/lib/desk/api";
import type { LiveMarks } from "./DeskSpace";

type View = "journal" | "review" | "strategies" | "lessons";

export default function Learn({ uid, account, live, onSaved }: { uid: string; account: Account; live: LiveMarks | null; onSaved: () => void }) {
  const [view, setView] = useState<View>("journal");
  const learned = useLearned();
  const total = Object.keys(GLOSSARY).length;
  return (
    <div className="pt-3">
      <p className="text-[11px] text-[var(--text-3)] leading-relaxed mb-2">
        Every trading word is followed by what it means until you tap got it.
        <span className="mono text-[9.5px] text-[var(--text-4)]"> {learned.size} of {total} learned</span>
        {learned.size > 0 && (
          <>
            {" "}
            <button onClick={resetLearned} className="mono text-[9.5px] text-[var(--neon)] active:scale-95">show every meaning again</button>
          </>
        )}
      </p>
      <Segmented value={view} onChange={setView} options={[{ key: "journal", label: "Journal" }, { key: "review", label: "Macro review" }, { key: "strategies", label: "Strategies" }, { key: "lessons", label: "Lessons" }]} />
      <div key={view} className="tab-enter">
        {view === "journal" && <Journal uid={uid} live={live} />}
        {view === "review" && <MacroReview uid={uid} onChanged={onSaved} />}
        {view === "strategies" && <Strategies uid={uid} account={account} onSaved={onSaved} />}
        {view === "lessons" && <Lessons uid={uid} />}
      </div>
    </div>
  );
}
