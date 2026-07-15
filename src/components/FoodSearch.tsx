"use client";

import { useState } from "react";
import { Card } from "./ui";

type Result = { description: string; kcal100: number; protein100: number; carb100: number; fat100: number; dataType: string };

const USDA_KEY = "DEMO_KEY"; // works out of the box; swap for a free key at fdc.nal.usda.gov if you hit rate limits

async function searchFoods(query: string): Promise<Result[]> {
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=8&api_key=${USDA_KEY}`);
  const json = await res.json();
  return (json.foods ?? []).map((f: { description: string; dataType: string; foodNutrients: { nutrientName: string; unitName: string; value: number }[] }) => {
    const kcal = f.foodNutrients.find((n) => n.nutrientName === "Energy" && n.unitName === "KCAL")?.value ?? 0;
    const protein = f.foodNutrients.find((n) => n.nutrientName === "Protein")?.value ?? 0;
    const carbs = f.foodNutrients.find((n) => n.nutrientName === "Carbohydrate, by difference")?.value ?? 0;
    const fat = f.foodNutrients.find((n) => n.nutrientName === "Total lipid (fat)")?.value ?? 0;
    return { description: f.description, kcal100: kcal, protein100: protein, carb100: carbs, fat100: fat, dataType: f.dataType };
  }).filter((r: Result) => r.kcal100 > 0);
}

export default function FoodSearch({ onAdd }: { onAdd: (name: string, calories: number, protein: number, carbs: number, fat: number) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Result | null>(null);
  const [grams, setGrams] = useState("100");

  async function search() {
    if (!query.trim() || busy) return;
    setBusy(true); setError(""); setResults([]); setSelected(null);
    try {
      const r = await searchFoods(query.trim());
      if (r.length === 0) setError("No matches — try a simpler search, or add it manually below.");
      setResults(r);
    } catch {
      setError("Couldn't reach the food database. Add it manually below.");
    } finally {
      setBusy(false);
    }
  }

  const g = Number(grams) || 0;
  const previewCal = selected ? Math.round((selected.kcal100 / 100) * g) : 0;
  const previewPro = selected ? Math.round((selected.protein100 / 100) * g * 10) / 10 : 0;
  const previewCarb = selected ? Math.round((selected.carb100 / 100) * g) : 0;
  const previewFat = selected ? Math.round((selected.fat100 / 100) * g) : 0;

  function add() {
    if (!selected) return;
    onAdd(`${selected.description} (${g}g)`, previewCal, previewPro, previewCarb, previewFat);
    setQuery(""); setResults([]); setSelected(null); setGrams("100");
  }

  return (
    <div>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="search a food — e.g. chicken breast"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <button onClick={search} disabled={busy} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">
          {busy ? "…" : "🔍"}
        </button>
      </div>

      {error && <p className="text-xs opacity-50 mt-2">{error}</p>}

      {results.length > 0 && !selected && (
        <div className="space-y-1.5 mt-2 max-h-64 overflow-y-auto">
          {results.map((r, i) => (
            <button key={i} onClick={() => setSelected(r)} className="w-full text-left">
              <Card padded={false} className="p-3">
                <p className="text-sm font-medium">{r.description}</p>
                <p className="text-xs opacity-50 mt-0.5">{r.kcal100} kcal · {r.protein100}g protein / 100g · <span className="opacity-40">{r.dataType}</span></p>
              </Card>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <Card tone="neon" className="mt-2">
          <p className="text-sm font-bold">{selected.description}</p>
          <div className="flex items-center gap-3 mt-2">
            <input value={grams} onChange={(e) => setGrams(e.target.value)} inputMode="numeric"
              className="w-20 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-center" />
            <span className="text-sm opacity-60">grams →</span>
            <span className="text-sm font-semibold flex-1">{previewCal} kcal · {previewPro}g protein</span>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setSelected(null)} className="flex-1 rounded-xl bg-white/10 py-2.5 active:scale-95">Back</button>
            <button onClick={add} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Add to log</button>
          </div>
        </Card>
      )}
    </div>
  );
}
