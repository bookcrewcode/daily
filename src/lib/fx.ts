"use client";

// Juice layer: tiny WebAudio synth (no audio files), imperative XP toasts,
// haptics. Celebration hierarchy: micro (pop + float) → meso (coin/confetti)
// → macro (fanfare/level-up). Sounds respect a device-level toggle.

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!soundOn()) return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function soundOn(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("daily.sound") !== "off";
}
export function setSoundOn(on: boolean) {
  localStorage.setItem("daily.sound", on ? "on" : "off");
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.12) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}

export const sfx = {
  pop() { tone(880, 0, 0.08, "triangle", 0.08); },                     // habit tap
  coin() { tone(988, 0, 0.07, "square", 0.06); tone(1319, 0.07, 0.12, "square", 0.06); }, // quest claim / XP
  chest() { [659, 784, 988, 1319].forEach((f, i) => tone(f, i * 0.06, 0.1, "triangle", 0.07)); }, // bonus drop
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.22, "triangle", 0.1)); }, // day won
  levelup() { [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.08, 0.25, "triangle", 0.1)); },
  pr() { tone(587, 0, 0.1, "sawtooth", 0.05); tone(880, 0.08, 0.18, "triangle", 0.09); }, // lift PR
};

export function buzz(pattern: number | number[] = 15) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
}

// Floating "+N XP" toast, imperative so any component can fire it without
// plumbing state. Stacks gracefully if several fire at once.
let toastCount = 0;
export function xpToast(xp: number, label?: string) {
  if (typeof document === "undefined") return;
  sfx.coin();
  buzz(15);
  const el = document.createElement("div");
  el.textContent = `+${xp} XP${label ? ` · ${label}` : ""}`;
  const offset = (toastCount++ % 3) * 34;
  el.style.cssText = `position:fixed;top:${64 + offset}px;left:50%;transform:translateX(-50%);z-index:90;
    background:rgba(11,15,14,0.92);border:1px solid rgba(52,211,153,0.5);color:#34d399;
    font-weight:800;font-size:13px;padding:6px 14px;border-radius:999px;pointer-events:none;
    box-shadow:0 0 18px rgba(52,211,153,0.25);animation:xpToastUp 1.4s ease forwards;`;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); toastCount = Math.max(0, toastCount - 1); }, 1450);
}
