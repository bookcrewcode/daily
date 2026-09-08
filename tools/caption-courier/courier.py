#!/usr/bin/env python3
"""Caption courier for Daily's Learn section.

YouTube walls the Supabase edge function's datacenter IP behind "Sign in to
confirm you're not a bot", so caption tracks cannot be fetched server-side.
This script runs on Ben's Mac (a home IP) from launchd every 10 minutes:

  1. caption_jobs(secret)  -> video ids referenced by live chapters whose
                              transcript is missing or unusable
  2. fetch the English captions straight from YouTube's player endpoint
     (IOS client first, then ANDROID; no watch page, no API key; via curl,
     because YouTube gates Python's TLS fingerprint long before curl's),
     youtube-transcript-api as the last resort
  3. caption_done(secret, …) -> writes video_transcripts and flips the
                              chapters' clips_ready; unstudied runs without
                              clips are cleared so the prep cron rebuilds them

Both RPCs are gated by the vault secret CAPTION_COURIER_SECRET; the script
holds no user JWT and no service key. Env: SUPABASE_URL, SUPABASE_ANON_KEY,
CAPTION_COURIER_SECRET (set in the launchd plist, never in this repo).

DEPLOYED COPY: launchd agents cannot read ~/Downloads (macOS TCC), so the
running copy lives in ~/Projects/daily-courier/ (courier.py, venv, courier.log)
with ~/Library/LaunchAgents/com.bengarnet.captioncourier.plist. After editing
this file: cp it there, then `launchctl kickstart -k gui/$(id -u)/com.bengarnet.captioncourier`.
"""
import html
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_ANON_KEY"]
SECRET = os.environ["CAPTION_COURIER_SECRET"]
PACE_S = 7  # polite spacing between YouTube requests
PER_RUN = 12  # per 10-minute tick; the queue drains over a few ticks

# contexts from yt-dlp's INNERTUBE_CLIENTS; IOS has never been rate-gated in tests
CLIENTS = [
    {"name": "IOS", "num": 5, "ua": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
     "ctx": {"clientName": "IOS", "clientVersion": "20.10.4", "deviceMake": "Apple", "deviceModel": "iPhone16,2", "osName": "iPhone", "osVersion": "18.3.2.22D82"}},
    {"name": "ANDROID", "num": 3, "ua": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
     "ctx": {"clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 30, "osName": "Android", "osVersion": "11"}},
]


class Blocked(Exception):
    """YouTube is refusing this IP right now — stop the tick, retry later."""


def http(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def yt(url, data=None, headers=None, timeout=20):
    """YouTube calls go through curl: YouTube's bot gate buckets by client
    fingerprint, and Python's old LibreSSL stack gets gated while curl from
    the same Mac, same minute, sails through."""
    cmd = ["curl", "-s", "-S", "-m", str(timeout), "--fail-with-body", url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if data is not None:
        cmd += ["-X", "POST", "--data-binary", "@-"]
    r = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout + 5)
    if r.returncode != 0:
        raise RuntimeError(f"curl {r.returncode}: {r.stderr.decode(errors='replace')[:120]}")
    return r.stdout


def rpc(name, body):
    try:
        raw = http(f"{URL}/rest/v1/rpc/{name}", data=json.dumps(body).encode(),
                   headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}, timeout=60)
        return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{name} -> HTTP {e.code}: {e.read()[:200]!r}")


def player(video_id, c):
    body = {"videoId": video_id, "contentCheckOk": True, "racyCheckOk": True,
            "context": {"client": {**c["ctx"], "hl": "en", "gl": "US"}}}
    raw = yt("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "User-Agent": c["ua"], "X-YouTube-Client-Name": str(c["num"]),
        "X-YouTube-Client-Version": c["ctx"]["clientVersion"], "Origin": "https://www.youtube.com", "Accept-Language": "en-US,en;q=0.9",
    })
    return json.loads(raw)


def pick_track(tracks):
    en = [t for t in tracks if str(t.get("languageCode", "")).lower().startswith("en")]
    for pool in (en, tracks):
        for t in pool:
            if t.get("kind") != "asr":
                return t
        if pool:
            return pool[0]
    return None


def parse_captions(raw):
    """json3 events or timedtext XML (<p>/<text>) -> [{s, d, text}]"""
    text = raw.strip()
    segs = []
    if text.startswith("{"):
        for e in json.loads(text).get("events", []):
            t = " ".join("".join(s.get("utf8", "") for s in e.get("segs", [])).split())
            if t:
                segs.append({"s": round(e.get("tStartMs", 0) / 1000, 1), "d": round(e.get("dDurationMs", 0) / 1000, 1), "text": t})
        return segs
    for m in re.finditer(r"<(?:p|text)\b([^>]*)>(.*?)</(?:p|text)>", text, re.S):
        attrs, inner = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
        t = " ".join(html.unescape(inner).split())
        ms = re.search(r'\bt="([^"]*)"', attrs)
        start = float(ms.group(1)) / 1000 if ms else float((re.search(r'\bstart="([^"]*)"', attrs) or [None, "nan"])[1])
        dm = re.search(r'\bd="([^"]*)"', attrs)
        dur = float(dm.group(1)) / 1000 if dm else float((re.search(r'\bdur="([^"]*)"', attrs) or [None, "0"])[1])
        if t and start == start:  # not NaN
            segs.append({"s": round(start, 1), "d": round(dur, 1), "text": t})
    return segs


def fetch_direct(video_id):
    """-> (segs, error). Raises Blocked when every client hits the bot gate."""
    gated = 0
    for c in CLIENTS:
        try:
            j = player(video_id, c)
        except Exception as e:  # noqa: BLE001
            print(f"    {c['name']}: request failed ({type(e).__name__})")
            continue
        ps = j.get("playabilityStatus", {}) or {}
        status, reason = ps.get("status", ""), str(ps.get("reason", ""))
        if status == "LOGIN_REQUIRED" and "bot" in reason.lower():
            gated += 1
            continue
        if status == "LOGIN_REQUIRED":
            return [], "AgeRestricted"
        if status not in ("OK", ""):
            return [], f"{status}: {reason[:120]}"
        tracks = (j.get("captions", {}) or {}).get("playerCaptionsTracklistRenderer", {}).get("captionTracks", []) or []
        track = pick_track(tracks)
        if not track or not track.get("baseUrl"):
            return [], "TranscriptsDisabled"
        for url in (track["baseUrl"] + "&fmt=json3", track["baseUrl"]):
            try:
                segs = parse_captions(yt(url, headers={"User-Agent": c["ua"], "Accept-Language": "en-US,en;q=0.9"}).decode("utf-8", "replace"))
            except Exception:  # noqa: BLE001
                continue
            if segs:
                return segs, ""
        return [], "caption track was empty"
    if gated and gated == len(CLIENTS):
        raise Blocked()
    return [], "no client answered"


def fetch_library(video_id):
    """Last resort: youtube-transcript-api (scrapes the watch page first)."""
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import IpBlocked, NoTranscriptFound, RequestBlocked, TranscriptsDisabled, VideoUnavailable
    try:
        tl = YouTubeTranscriptApi().list(video_id)
        try:
            t = tl.find_transcript(["en", "en-US", "en-GB"])
        except NoTranscriptFound:
            t = next((x.translate("en") for x in tl if x.is_translatable), None)
        if t is None:
            return [], "no English captions and nothing translatable"
        segs = [{"s": round(x.start, 1), "d": round(x.duration, 1), "text": " ".join(x.text.split())} for x in t.fetch() if x.text.strip()]
        return segs, "" if segs else "caption track was empty"
    except (IpBlocked, RequestBlocked):
        raise Blocked()
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable) as e:
        return [], type(e).__name__
    except Exception as e:  # noqa: BLE001
        return [], f"{type(e).__name__}: {str(e)[:200]}"


def main():
    jobs = rpc("caption_jobs", {"p_secret": SECRET}) or []
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    if not jobs:
        print(f"{stamp} nothing to fetch")
        return
    print(f"{stamp} {len(jobs)} video(s) need captions")
    random.shuffle(jobs)  # a flaky video must not sit first every tick
    gated_in_a_row = 0
    for j in jobs[:PER_RUN]:
        vid = j["video_id"]
        try:
            try:
                segs, err = fetch_direct(vid)
            except Blocked:
                # the gate flickers for a minute or so: one patient retry before giving the tick up
                time.sleep(45)
                segs, err = fetch_direct(vid)
            if not segs and err in ("no client answered", "caption track was empty"):
                segs, err = fetch_library(vid)
        except Blocked:
            gated_in_a_row += 1
            print(f"  {vid} YouTube refused it ({gated_in_a_row} in a row); the next tick retries")
            if gated_in_a_row >= 3:
                print("  stopping this run: the IP is gated right now")
                break
            time.sleep(PACE_S)
            continue
        gated_in_a_row = 0
        duration = int(segs[-1]["s"] + segs[-1]["d"]) if segs else 0
        res = rpc("caption_done", {
            "p_secret": SECRET, "p_video_id": vid, "p_title": j.get("title") or "", "p_channel": j.get("channel") or "",
            "p_duration_s": duration, "p_segments": segs, "p_error": err,
        })
        print(f"  {vid} {len(segs)} cues" if segs else f"  {vid} FAILED {err}", "->", json.dumps(res))
        time.sleep(PACE_S)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(e, file=sys.stderr)
        sys.exit(1)
