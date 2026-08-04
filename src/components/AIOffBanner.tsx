"use client";

// One honest, app-wide answer to "why isn't anything working?"
//
// When the AI key is missing or dead, this appears once at the top with a
// single tap to fix it — instead of every AI button spinning and then failing
// with its own error. The whole point is that the app never feels mysteriously
// broken; it tells you what's off and where to turn it on.

import { useAIStatus } from "@/lib/aiStatus";

export default function AIOffBanner({ onGoFix }: { onGoFix: () => void }) {
  const status = useAIStatus();
  if (status !== "off") return null;
  return (
    <button onClick={onGoFix}
      className="w-full text-left rounded-2xl border border-orange-400/40 bg-orange-500/10 px-4 py-3 mt-3 active:scale-[0.99] transition">
      <p className="text-sm font-semibold text-orange-200">⚡ AI is off — no key set</p>
      <p className="text-[11px] opacity-70 mt-0.5 leading-relaxed">
        Study guides, chapters, flashcards, the podcast and every chat need an Anthropic key.
        Everything else in the app works fine. <span className="underline">Tap to set it →</span>
      </p>
    </button>
  );
}
