import { createClient } from "@supabase/supabase-js";

// Publishable key is designed to be exposed in the browser; the fallback keeps
// the deployed build working even without Vercel env vars configured.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pciljeqsrricybdnhvsu.supabase.co";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "sb_publishable_pUix6c1Cx2GaJ1ZUzXJ32w_rJgGUYtZ";

export const SUPABASE_URL = URL;
export const SUPABASE_ANON = KEY;
export const ADVISOR_FN = `${URL}/functions/v1/advisor`;

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
  ws_water: boolean;
  ws_sleep: boolean;
  ws_school: boolean;
  ws_affirmations: boolean;
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
  "ws_water",
  "ws_sleep",
  "ws_school",
  "ws_affirmations",
] as const;

export type Meal = {
  id: string;
  day: string;
  name: string;
  calories: number;
  protein: number;
};

export type LiftSet = {
  id: string;
  day: string;
  workout: string;
  exercise: string;
  slot: number;
  weight: number | null;
  reps: number | null;
  done: boolean;
};

export type ScheduleItem = { time: string; what: string };
export type Night = {
  day: string;
  items: ScheduleItem[];
  top3: string[];
  notes: string;
  calendar_synced_at: string | null;
};

// Ben's real 5-day split (from the vault Workout note)
export const SPLIT: { name: string; exercises: string[] }[] = [
  { name: "Day 1 — Chest/Tris/Side Delts", exercises: ["Incline Smith Press", "Chest Press Machine", "Pec Dec", "Lateral Raises", "JM Press", "Tricep Pushdown"] },
  { name: "Day 2 — Back/Bis/Traps", exercises: ["Weighted Pull-ups", "ISO Lateral Pulldown", "Barbell Row", "Reverse Pec Dec", "Shrugs", "Preacher Curl", "Hammer Curls"] },
  { name: "Day 3 — Legs", exercises: ["Leg Press", "RDLs", "Hamstring Curls", "Leg Extension"] },
  { name: "Day 5 — Shoulders/Chest/Tris", exercises: ["Machine Lateral Raises", "Incline Press", "Pec Dec", "Overhead Tricep Extension"] },
  { name: "Day 6 — Back/Bis/Traps", exercises: ["Weighted Pull-ups", "ISO Lateral Pull", "Cable Row", "Reverse Pec Dec", "Shrugs", "Preacher Curls"] },
];

export type Goal = {
  id: string;
  title: string;
  why: string;
  due: string | null;
  priority: number;
  status: string;
};

export type Asset = {
  id: string;
  name: string;
  kind: "asset" | "liability";
  value: number;
};

export type Subscription = {
  id: string;
  name: string;
  cost: number;
  cycle: "monthly" | "yearly";
  renews_on: string | null;
  active: boolean;
};

export type VocabWord = {
  id: string;
  word: string;
  definition: string;
  sentence: string;
  mnemonic: string;
  added: string;
};

export type UserSettings = {
  calorie_goal: number;
  protein_goal: number;
  affirmation_video_url: string;
};

export type LearningTopic = {
  id: string;
  title: string;
  goal: string;
  why: string;
  trunk: string;
  branches: string[];
  leaves: string;
  status: string;
  created_at: string;
};

export type LearningRetrieval = { id: string; topic_id: string; question: string; got_it: boolean; created_at: string };
export type LearningWeakSpot = { id: string; topic_id: string; text: string; resolved: boolean };
export type Affirmation = { id: string; day: string; period: "morning" | "night"; text: string; created_at: string };

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
