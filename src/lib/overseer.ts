import { supabase } from "./supabase";

// The Overseer agent's own API (a Cloudflare Worker). It answers only Ben's
// signed-in session; everything else on the Overseer page reads Supabase.
export const OVERSEER_URL = "https://overseer.<account>.workers.dev";

export type OverseerReply = { ok: boolean; error?: string; text?: string; url?: string; linked?: boolean; paused?: boolean; dry_run?: boolean; google?: boolean };

export async function overseer(op: string, body: Record<string, unknown> = {}): Promise<OverseerReply> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, error: "Sign in first." };
  try {
    const r = await fetch(`${OVERSEER_URL}/api/${op}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as OverseerReply;
    return r.ok ? { ...j, ok: j.ok !== false } : { ok: false, error: j.error ?? `The Overseer answered ${r.status}.` };
  } catch {
    return { ok: false, error: "Couldn't reach the Overseer." };
  }
}
