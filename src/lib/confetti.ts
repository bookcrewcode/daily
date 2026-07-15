"use client";

// Tiny dependency-free canvas confetti. One burst ≈ 2s, self-cleaning.
const COLORS = ["#a78bfa", "#fbbf24", "#60a5fa", "#f472b6", "#a78bfa", "#edf2ef"];

export function burstConfetti(power: "small" | "big" = "big") {
  if (typeof document === "undefined") return;
  let canvas = document.getElementById("confetti-canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "confetti-canvas";
    document.body.appendChild(canvas);
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const W = window.innerWidth;
  const n = power === "big" ? 140 : 60;
  const parts = Array.from({ length: n }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.5,
    y: window.innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -6 - Math.random() * 10,
    size: 5 + Math.random() * 6,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rot: Math.random() * Math.PI,
    vrot: (Math.random() - 0.5) * 0.3,
    life: 1,
  }));

  const started = performance.now();
  function frame(t: number) {
    const elapsed = (t - started) / 1000;
    ctx!.clearRect(0, 0, W, window.innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.life = Math.max(0, 1 - elapsed / 2);
      ctx!.save();
      ctx!.globalAlpha = p.life;
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.rot);
      ctx!.fillStyle = p.color;
      ctx!.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx!.restore();
    }
    if (elapsed < 2.1) requestAnimationFrame(frame);
    else canvas!.remove();
  }
  requestAnimationFrame(frame);

  if ("vibrate" in navigator) navigator.vibrate(power === "big" ? [30, 40, 60] : 20);
}
