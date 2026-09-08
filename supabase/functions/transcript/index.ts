// YouTube transcript fetcher.
//
// WHY A CLIENT LADDER: YouTube walls datacenter IPs (a Supabase edge function
// is one) behind "Sign in to confirm you're not a bot" — the ANDROID and WEB
// InnerTube clients answer LOGIN_REQUIRED with no caption tracks, and the
// watch page is a consent shell. Other first-party clients are not walled the
// same way, so the player call is tried across clients (order and contexts
// taken from yt-dlp 2025.10 INNERTUBE_CLIENTS) until one returns tracks:
//   ANDROID_VR → IOS → TVHTML5 → WEB_EMBEDDED_PLAYER → MWEB → WEB → ANDROID
// then the legacy api/timedtext endpoint, then the watch-page scrape.
//
// Caption payloads come back as timedtext XML (<p> / <text>) even when
// fmt=json3 is requested, so BOTH shapes are parsed.
//
// CALLERS: the app (user JWT), studio prep (the service key as bearer), and a
// test path {secret} matched against the vault so the fetch can be exercised
// from SQL without any key leaving the server.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UA_WEB = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Track = { baseUrl: string; languageCode?: string; kind?: string };
type Client = { name: string; num: number; ua: string; ctx: Record<string, unknown>; embed?: boolean };
// contexts verbatim from yt-dlp; no API key (the endpoint no longer needs one)
const CLIENTS: Client[] = [
  { name: "ANDROID_VR", num: 28, ua: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    ctx: { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" } },
  { name: "IOS", num: 5, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" } },
  { name: "TVHTML5", num: 7, ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version", ctx: { clientName: "TVHTML5", clientVersion: "7.20250923.13.00" } },
  { name: "WEB_EMBEDDED_PLAYER", num: 56, ua: UA_WEB, ctx: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250923.21.00" }, embed: true },
  { name: "MWEB", num: 2, ua: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
    ctx: { clientName: "MWEB", clientVersion: "2.20250925.01.00" } },
  { name: "WEB", num: 1, ua: UA_WEB, ctx: { clientName: "WEB", clientVersion: "2.20250925.01.00" } },
  { name: "ANDROID", num: 3, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, osName: "Android", osVersion: "11" } },
];

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return await r.json();
}

// vault secret via the service-role-only get_secret RPC; missing = "" and can never match
async function secretOf(name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name }),
    });
    return r.ok ? ((await r.json()) as string | null) ?? "" : "";
  } catch { return ""; }
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

// One InnerTube /player call for one client. null = the request itself failed.
async function innertube(videoId: string, c: Client): Promise<{ tracks: Track[]; title: string; status: string } | null> {
  const body = {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: { ...c.ctx, hl: "en", gl: "US", userAgent: c.ua },
      ...(c.embed ? { thirdParty: { embedUrl: "https://www.youtube.com/" } } : {}),
    },
  };
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": c.ua,
        "X-YouTube-Client-Name": String(c.num),
        "X-YouTube-Client-Version": String(c.ctx.clientVersion),
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
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
      signal: AbortSignal.timeout(8000),
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

async function fetchCaptionText(baseUrl: string, ua = UA_WEB): Promise<Captions | null> {
  for (const url of [`${baseUrl}&fmt=json3`, baseUrl]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const parsed = parseCaptions(await r.text());
      const cleaned = oneLine(parsed.text);
      if (cleaned) return { text: cleaned, segments: parsed.segments };
    } catch { /* try the next form */ }
  }
  return null;
}

type Result = { text: string; title: string; segments: Seg[]; client: string };

async function fetchTranscript(videoId: string): Promise<Result> {
  const attempts: string[] = [];
  let title = "";
  let lastStatus = "";

  for (const c of CLIENTS) {
    const res = await innertube(videoId, c);
    if (!res) { attempts.push(`${c.name}: request failed`); continue; }
    if (res.title && !title) title = res.title;
    if (res.status && res.status !== "OK") lastStatus = res.status;
    if (!res.tracks.length) { attempts.push(`${c.name}: 0 tracks (${res.status})`); continue; }
    const track = pickTrack(res.tracks);
    if (!track?.baseUrl) { attempts.push(`${c.name}: no usable track`); continue; }
    const got = await fetchCaptionText(track.baseUrl, c.ua);
    if (got) return { ...got, title: title || videoId, client: c.name };
    attempts.push(`${c.name}: track found but the caption body was empty`);
  }

  // legacy endpoint: still answers for some videos with creator captions
  for (const q of ["", "&kind=asr"]) {
    const got = await fetchCaptionText(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=en${q}`);
    if (got) return { ...got, title: title || videoId, client: `timedtext${q}` };
  }
  attempts.push("timedtext: empty");

  const scraped = await scrapeHtml(videoId);
  if (scraped) {
    if (scraped.title && !title) title = scraped.title;
    const track = pickTrack(scraped.tracks);
    if (track?.baseUrl) {
      const got = await fetchCaptionText(track.baseUrl);
      if (got) return { ...got, title: title || videoId, client: "html" };
      attempts.push("html: track found but empty");
    } else {
      attempts.push("html: 0 tracks");
    }
  } else {
    attempts.push("html: request failed");
  }

  // Honest failure: say what was tried, and separate "video can't be played for
  // us" from "we couldn't get captions" — never blame captions that do exist.
  if (lastStatus) {
    throw new Error(`YouTube wouldn't serve this video to the server (${lastStatus}) — it may be private, age-restricted, or region-locked. [tried: ${attempts.join("; ")}]`);
  }
  throw new Error(`Couldn't pull captions right now — YouTube may be rate-limiting this server. Try again in a minute. [tried: ${attempts.join("; ")}]`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const body = await req.json().catch(() => ({}));
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    // studio's prep runs in service mode and passes the service key itself; the
    // vault secret path exists so the fetch can be tested from SQL
    const svc = (token && SERVICE_KEY && token === SERVICE_KEY) ||
      (typeof body.secret === "string" && body.secret && body.secret === await secretOf("learn_prep_secret"));
    const user = svc ? { id: "service" } : await getUser(token);
    if (!user?.id) return json({ error: "unauthorized" }, 401);

    const videoId = extractVideoId(body.url ?? "");
    if (!videoId) return json({ error: "Couldn't find a YouTube video ID in that link." });

    const { text, title, segments, client } = await fetchTranscript(videoId);
    console.error(`[transcript] ${videoId} via ${client}: ${segments.length} cues`);
    return json({ text, title, segments, client });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[transcript] failed: ${msg.slice(0, 300)}`);
    return json({ error: msg });
  }
});
