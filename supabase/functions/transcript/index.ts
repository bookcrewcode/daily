// YouTube transcript fetcher.
//
// Why this is not just "scrape the watch page": YouTube no longer reliably
// serves ytInitialPlayerResponse (and its captionTracks) to datacenter IPs —
// which is exactly what a Supabase edge function is. It returns a consent /
// bot-check shell instead, so the old regex found nothing and we reported
// "no captions found" for videos that plainly have them.
//
// Strategy order (first one that yields text wins):
//   1. InnerTube ANDROID client  — most resilient server-side, no cookies
//   2. InnerTube WEB client      — fallback
//   3. watch-page HTML scrape    — last resort (works from residential IPs)
//
// Caption payloads come back as timedtext XML (<p> / <text> nodes) even when
// fmt=json3 is requested, so BOTH shapes are parsed — the old code assumed
// JSON and threw on the XML it actually received.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA_ANDROID = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
const UA_WEB = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// public InnerTube keys — these ship inside YouTube's own clients
const KEY_ANDROID = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w";
const KEY_WEB = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

type Track = { baseUrl: string; languageCode?: string; kind?: string };

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return await r.json();
}

function extractVideoId(raw: unknown): string | null {
  const url = typeof raw === "string" ? raw : "";
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{11}$/.test(url.trim()) ? url.trim() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// One InnerTube /player call. Returns tracks + title, or null if the request
// itself failed (network / non-200).
async function innertube(videoId: string, client: "ANDROID" | "WEB"): Promise<{ tracks: Track[]; title: string; status: string } | null> {
  const isAndroid = client === "ANDROID";
  const body = {
    videoId,
    context: {
      client: isAndroid
        ? { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" }
        : { clientName: "WEB", clientVersion: "2.20240401.00.00", hl: "en", gl: "US" },
    },
  };
  try {
    const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${isAndroid ? KEY_ANDROID : KEY_WEB}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": isAndroid ? UA_ANDROID : UA_WEB,
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      tracks: (j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []) as Track[],
      title: (j?.videoDetails?.title ?? "") as string,
      status: (j?.playabilityStatus?.status ?? "UNKNOWN") as string,
    };
  } catch {
    return null;
  }
}

// Last resort: the original HTML scrape (still works from residential IPs).
async function scrapeHtml(videoId: string): Promise<{ tracks: Track[]; title: string } | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { "Accept-Language": "en-US,en;q=0.9", "User-Agent": UA_WEB, Cookie: "CONSENT=YES+1" },
    });
    const html = await res.text();
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch ? decodeEntities(titleMatch[1].replace(" - YouTube", "")) : "";
    const tracksMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!tracksMatch) return { tracks: [], title };
    return { tracks: JSON.parse(tracksMatch[1]) as Track[], title };
  } catch {
    return null;
  }
}

// Prefer a human-written English track, then any English, then any non-auto, then any.
function pickTrack(tracks: Track[]): Track | null {
  if (!tracks.length) return null;
  const en = tracks.filter((t) => (t.languageCode ?? "").toLowerCase().startsWith("en"));
  return en.find((t) => t.kind !== "asr") ?? en[0] ?? tracks.find((t) => t.kind !== "asr") ?? tracks[0];
}

// One caption cue: start + duration in seconds (1 decimal). Learn picks video
// clips by matching a quoted sentence against the cues inside a time window,
// so timing has to survive alongside the flat text.
type Seg = { s: number; d: number; text: string };
type Captions = { text: string; segments: Seg[] };
const tenth = (n: number) => Math.round(n * 10) / 10;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// timedtext returns JSON (events/segs) OR XML (<p>/<text>) regardless of the
// fmt param, so sniff the payload and parse whichever actually arrived.
// `text` is built exactly as before (NotebookSources reads it); `segments`
// carries the same words with timing.
function parseCaptions(raw: string): Captions {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
      const events = (data.events ?? []).filter((e) => e.segs?.length);
      const text = events.flatMap((e) => e.segs ?? []).map((s) => s.utf8 ?? "").join("");
      if (text.trim()) {
        const segments = events
          .map((e) => ({ s: tenth((e.tStartMs ?? 0) / 1000), d: tenth((e.dDurationMs ?? 0) / 1000), text: oneLine((e.segs ?? []).map((s) => s.utf8 ?? "").join("")) }))
          .filter((g) => g.text);
        return { text, segments };
      }
    } catch { /* fall through to XML */ }
  }
  // <p t="ms" d="ms"> (json3-era XML) or <text start="s" dur="s"> (classic)
  const nodes = [...trimmed.matchAll(/<(?:p|text)\b([^>]*)>([\s\S]*?)<\/(?:p|text)>/g)];
  const attr = (attrs: string, name: string) => { const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? Number(m[1]) : NaN; };
  const cues = nodes.map((m) => {
    const ms = attr(m[1], "t"), secs = attr(m[1], "start");
    const s = Number.isFinite(ms) ? ms / 1000 : secs;
    const d = Number.isFinite(ms) ? attr(m[1], "d") / 1000 : attr(m[1], "dur");
    return { s, d, text: decodeEntities(m[2].replace(/<[^>]+>/g, "")) };
  });
  return {
    text: cues.map((c) => c.text).join(" "),
    segments: cues.filter((c) => Number.isFinite(c.s) && oneLine(c.text)).map((c) => ({ s: tenth(c.s), d: tenth(Number.isFinite(c.d) ? c.d : 0), text: oneLine(c.text) })),
  };
}

async function fetchCaptionText(baseUrl: string): Promise<Captions | null> {
  for (const url of [`${baseUrl}&fmt=json3`, baseUrl]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA_WEB, "Accept-Language": "en-US,en;q=0.9" } });
      if (!r.ok) continue;
      const parsed = parseCaptions(await r.text());
      const cleaned = oneLine(parsed.text);
      if (cleaned) return { text: cleaned, segments: parsed.segments };
    } catch { /* try the next form */ }
  }
  return null;
}

async function fetchTranscript(videoId: string): Promise<{ text: string; title: string; segments: Seg[] }> {
  const attempts: string[] = [];
  let title = "";
  let lastStatus = "";

  for (const client of ["ANDROID", "WEB"] as const) {
    const res = await innertube(videoId, client);
    if (!res) { attempts.push(`${client}: request failed`); continue; }
    if (res.title && !title) title = res.title;
    lastStatus = res.status;
    if (!res.tracks.length) { attempts.push(`${client}: 0 tracks (${res.status})`); continue; }
    const track = pickTrack(res.tracks);
    if (!track?.baseUrl) { attempts.push(`${client}: no usable track`); continue; }
    const got = await fetchCaptionText(track.baseUrl);
    if (got) return { ...got, title: title || videoId };
    attempts.push(`${client}: track found but empty`);
  }

  const scraped = await scrapeHtml(videoId);
  if (scraped) {
    if (scraped.title && !title) title = scraped.title;
    const track = pickTrack(scraped.tracks);
    if (track?.baseUrl) {
      const got = await fetchCaptionText(track.baseUrl);
      if (got) return { ...got, title: title || videoId };
      attempts.push("html: track found but empty");
    } else {
      attempts.push("html: 0 tracks");
    }
  } else {
    attempts.push("html: request failed");
  }

  // Honest failure: say what was tried, and separate "video can't be played for
  // us" from "we couldn't get captions" — never blame captions that do exist.
  if (lastStatus && lastStatus !== "OK") {
    throw new Error(`YouTube wouldn't serve this video to the server (${lastStatus}) — it may be private, age-restricted, or region-locked. [tried: ${attempts.join("; ")}]`);
  }
  throw new Error(`Couldn't pull captions right now — YouTube may be rate-limiting this server. Try again in a minute. [tried: ${attempts.join("; ")}]`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    // studio's nightly prep runs in service mode (no user JWT) and passes the
    // service key itself — that key is the authorisation, so skip the user lookup
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const user = token && svcKey && token === svcKey ? { id: "service" } : await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const { url = "" } = await req.json();
    const videoId = extractVideoId(url);
    if (!videoId) return new Response(JSON.stringify({ error: "Couldn't find a YouTube video ID in that link." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

    const { text, title, segments } = await fetchTranscript(videoId);
    return new Response(JSON.stringify({ text, title, segments }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
