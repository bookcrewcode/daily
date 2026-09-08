"use client";

// Error boundary around the whole Learn space. A render crash anywhere inside
// (a malformed cached run, a card shape the renderer never saw) would otherwise
// blank the entire tab with no way back — the worst possible screen for someone
// who already suspects the app is broken. This says what happened and offers
// the one action that always works.

import { Component, type ReactNode } from "react";

type State = { broken: boolean };

export default class LearnBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { broken: false };

  static getDerivedStateFromError(): State { return { broken: true }; }

  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    console.error("Learn crashed", error, info?.componentStack);
  }

  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <button onClick={() => window.location.reload()}
        className="mt-6 w-full rounded-2xl border border-orange-400/40 bg-orange-500/10 px-4 py-4 text-left active:scale-[0.99]">
        <p className="text-sm font-semibold text-orange-200">Something broke in Learn — tap to reload</p>
        <p className="text-[11px] opacity-70 mt-0.5 leading-relaxed">Answers save every few taps — you&apos;ll pick up close to where you were.</p>
      </button>
    );
  }
}
