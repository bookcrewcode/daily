import { createClient } from "@supabase/supabase-js";

// Publishable key is designed to be exposed in the browser; the fallback keeps
// the deployed build working even without Vercel env vars configured.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pciljeqsrricybdnhvsu.supabase.co";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_pUix6c1Cx2GaJ1ZUzXJ32w_rJgGUYtZ";

export const supabase = createClient(
  URL,
  KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }
);

export type DayRow = {
  day: string;
  ws_meds: boolean;
  ws_eat: boolean;
  ws_lift: boolean;
  ws_stretch: boolean;
  ws_vocab: boolean;
  ws_chinese: boolean;
  ws_work: boolean;
  calories: number;
  protein: number;
  bodyweight: number | null;
  vocab_count: number;
};

export const WIN_KEYS = [
  "ws_meds",
  "ws_eat",
  "ws_lift",
  "ws_stretch",
  "ws_vocab",
  "ws_chinese",
  "ws_work",
] as const;
