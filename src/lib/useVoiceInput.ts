"use client";

// Browser-native dictation (Web Speech API) — free, no key, no backend.
// Works on iOS Safari 14.5+, desktop Safari 14.1+, and Chromium browsers.
import { useCallback, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRecognition = any;

export function useVoiceInput(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<AnyRecognition>(null);
  const g = typeof window !== "undefined" ? (window as unknown as Record<string, AnyRecognition>) : {};
  const Ctor = g.SpeechRecognition || g.webkitSpeechRecognition;
  const supported = !!Ctor;

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    const rec: AnyRecognition = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e: AnyRecognition) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onResult(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }, [Ctor, onResult]);

  const toggle = useCallback(() => { if (listening) stop(); else start(); }, [listening, start, stop]);

  return { supported, listening, toggle };
}
