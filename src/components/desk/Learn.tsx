"use client";

// Learn — the desk as a course. The Journal (every trade, its thesis and its
// micro review), the macro review (what is working across trades, strategies
// and jurors, and how to proceed), the strategies (the coded rules, explained)
// and the lessons (rules the reviews keep proposing, counted not believed).

import { useState } from "react";
import { Segmented } from "../ui";
import Journal from "./Journal";
import MacroReview from "./MacroReview";
import Strategies from "./Strategies";
import Lessons from "./Lessons";
import type { Account } from "@/lib/desk/api";
import type { LiveMarks } from "./DeskSpace";

type View = "journal" | "review" | "strategies" | "lessons";

export default function Learn({ uid, account, live, onSaved }: { uid: string; account: Account; live: LiveMarks | null; onSaved: () => void }) {
  const [view, setView] = useState<View>("journal");
  return (
    <div className="pt-3">
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
