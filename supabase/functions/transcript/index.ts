// Free YouTube transcript fetcher — reads YouTube's own public caption tracks,
// same technique as the open-source youtube-transcript-api project. No API key.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return await r.json();
}

function extractVideoId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{11}$/.test(url.trim()) ? url.trim() : null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchTranscript(videoId: string): Promise<{ text: string; title: string }> {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "Accept-Language": "en-US,en;q=0.9", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  const html = await pageRes.text();

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(" - YouTube", "")) : videoId;

  const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!tracksMatch) throw new Error("No captions found — this video may have them disabled, or be age/region restricted.");
  const tracks = JSON.parse(tracksMatch[1]) as { baseUrl: string; languageCode: string }[];
  const track = tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
  if (!track) throw new Error("No caption track available for this video.");

  const capRes = await fetch(track.baseUrl + "&fmt=json3");
  const data = await capRes.json();
  const text = (data.events ?? [])
    .flatMap((e: { segs?: { utf8: string }[] }) => e.segs ?? [])
    .map((s: { utf8: string }) => s.utf8)
    .join("")
    .replace(/\n+/g, " ")
    .trim();
  if (!text) throw new Error("Transcript came back empty.");
  return { text, title };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const { url = "" } = await req.json();
    const videoId = extractVideoId(url);
    if (!videoId) return new Response(JSON.stringify({ error: "Couldn't find a YouTube video ID in that link." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

    const { text, title } = await fetchTranscript(videoId);
    return new Response(JSON.stringify({ text, title }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
