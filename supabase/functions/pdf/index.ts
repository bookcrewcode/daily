// 📄 PDF text extraction for notebook sources.
//
// Runs server-side with unpdf (a Deno/serverless build of pdf.js) so the client
// bundle stays light and weird PDFs are handled by a real parser. verify_jwt is
// false at the gateway so the CORS preflight works; we validate the Supabase JWT
// manually below, so only a logged-in user can call it.

import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// base64 → bytes without blowing the stack on large inputs
function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // require + validate a real session token
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in." }, 200);
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!who.ok) return json({ error: "Session expired — sign in again." }, 200);

    const body = await req.json().catch(() => ({}));
    const b64 = String(body?.pdf ?? "");
    if (!b64) return json({ error: "No PDF received." }, 200);
    // ~9M base64 chars ≈ 6.7 MB file — past this, ask him to split it
    if (b64.length > 9_000_000) return json({ error: "That PDF is too big to read here — split it or paste the key pages as text." }, 200);

    let bytes: Uint8Array;
    try { bytes = b64ToBytes(b64); } catch { return json({ error: "Couldn't decode that file — try re-uploading." }, 200); }

    try {
      const pdf = await getDocumentProxy(bytes);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      // strip stray NUL bytes pdf.js can leak, collapse runaway blank lines — KEEP spaces
      const clean = String(text ?? "").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!clean) return json({ error: "No selectable text in that PDF — it may be scanned images. Paste the text instead." }, 200);
      return json({ text: clean, pages: totalPages ?? 0 });
    } catch {
      return json({ error: "Couldn't read that PDF — it may be encrypted or corrupted. Paste the text instead." }, 200);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Something went wrong reading that PDF." }, 200);
  }
});
