#!/usr/bin/env python3
"""Caption courier for Daily's Learn section.

YouTube walls the Supabase edge function's datacenter IP behind "Sign in to
confirm you're not a bot", so caption tracks cannot be fetched server-side.
This script runs on Ben's Mac (a home IP) from launchd every 10 minutes:

  1. caption_jobs(secret)  -> video ids referenced by live chapters whose
                              transcript is missing or unusable
  2. fetch the English captions with youtube-transcript-api
  3. caption_done(secret, …) -> writes video_transcripts and flips the
                              chapters' clips_ready; unstudied runs without
                              clips are cleared so the prep cron rebuilds them

Both RPCs are gated by the vault secret CAPTION_COURIER_SECRET; the script
holds no user JWT and no service key. Env: SUPABASE_URL, SUPABASE_ANON_KEY,
CAPTION_COURIER_SECRET (set in the launchd plist, never in this repo).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import IpBlocked, NoTranscriptFound, RequestBlocked, TranscriptsDisabled, VideoUnavailable

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_ANON_KEY"]
SECRET = os.environ["CAPTION_COURIER_SECRET"]
PACE_S = 7  # YouTube rate-limits a home IP after ~20 quick caption fetches; keep it slow
PER_RUN = 12  # per 10-minute tick; the queue drains over a few ticks


def rpc(name, body):
    req = urllib.request.Request(
        f"{URL}/rest/v1/rpc/{name}",
        data=json.dumps(body).encode(),
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{name} -> HTTP {e.code}: {e.read()[:200]!r}")


def english_transcript(api, video_id):
    """Manual English first, then auto-generated English, then a translation."""
    tl = api.list(video_id)
    try:
        return tl.find_transcript(["en", "en-US", "en-GB"])
    except NoTranscriptFound:
        pass
    for t in tl:
        if t.is_translatable:
            return t.translate("en")
    return None


def main():
    jobs = rpc("caption_jobs", {"p_secret": SECRET}) or []
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    if not jobs:
        print(f"{stamp} nothing to fetch")
        return
    print(f"{stamp} {len(jobs)} video(s) need captions")
    api = YouTubeTranscriptApi()
    for j in jobs[:PER_RUN]:
        vid = j["video_id"]
        segs, err = [], ""
        try:
            t = english_transcript(api, vid)
            if t is None:
                err = "no English captions and nothing translatable"
            else:
                for x in t.fetch():
                    text = " ".join(x.text.split())
                    if text:
                        segs.append({"s": round(x.start, 1), "d": round(x.duration, 1), "text": text})
                if not segs:
                    err = "caption track was empty"
        except (IpBlocked, RequestBlocked) as e:
            # YouTube is throttling this IP: stop for this tick rather than dig in deeper
            print(f"  {vid} {type(e).__name__}: stopping this run; the next tick retries")
            break
        except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable) as e:
            err = type(e).__name__
        except Exception as e:  # noqa: BLE001 — anything else is reported, never hidden
            err = f"{type(e).__name__}: {str(e)[:200]}"
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
