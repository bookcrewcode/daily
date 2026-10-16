// OpenRouter chat-completions shapes. Task 10 adds the client and the tool loop.

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type LlmResult = { text: string; tool_calls: ToolCall[]; cost: number; tin: number; tout: number; error: string | null };

export interface LlmPort {
  chat(model: string, messages: Msg[], tools?: ToolSpec[], maxTokens?: number): Promise<LlmResult>;
}

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
// OpenRouter needs max_tokens above the reasoning budget, or a thinking model
// spends the whole allowance thinking and returns nothing (Learn v50 lesson).
const REASON = 1024;

export function openRouter(key: string, f: typeof fetch = fetch): LlmPort {
  return {
    async chat(model, messages, tools, maxTokens = 600) {
      const empty = { text: "", tool_calls: [] as ToolCall[], cost: 0, tin: 0, tout: 0 };
      try {
        const r = await f(OR_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Overseer" },
          body: JSON.stringify({
            model, messages, ...(tools?.length ? { tools } : {}),
            max_tokens: REASON + maxTokens, reasoning: { max_tokens: REASON, exclude: true }, usage: { include: true },
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (r.status === 402) return { ...empty, error: "out_of_credit" };
        if (!r.ok) return { ...empty, error: `http_${r.status}` };
        const j = (await r.json()) as any;
        const m = j?.choices?.[0]?.message ?? {};
        const u = j?.usage ?? {};
        return {
          text: typeof m.content === "string" ? m.content : "",
          tool_calls: Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCall[]) : [],
          cost: Number(u.cost) || 0, tin: Number(u.prompt_tokens) || 0, tout: Number(u.completion_tokens) || 0, error: null,
        };
      } catch (e) {
        return { ...empty, error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network" };
      }
    },
  };
}

export async function runAgentLoop(a: {
  llm: LlmPort; model: string; messages: Msg[]; tools: ToolSpec[];
  exec: (name: string, args: Record<string, unknown>) => Promise<string>; maxSteps?: number; maxTokens?: number;
}): Promise<{ text: string; cost: number; tin: number; tout: number; error: string | null }> {
  const msgs = [...a.messages];
  let cost = 0, tin = 0, tout = 0, last = "";
  for (let i = 0; i < (a.maxSteps ?? 4); i++) {
    const r = await a.llm.chat(a.model, msgs, a.tools, a.maxTokens ?? 400);
    cost += r.cost; tin += r.tin; tout += r.tout;
    if (r.error) return { text: "", cost, tin, tout, error: r.error };
    last = r.text;
    if (!r.tool_calls.length) return { text: r.text, cost, tin, tout, error: null };
    msgs.push({ role: "assistant", content: r.text || null, tool_calls: r.tool_calls });
    for (const call of r.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        const p = JSON.parse(call.function.arguments || "{}");
        if (p && typeof p === "object") args = p as Record<string, unknown>;
      } catch {
        // broken arguments: run the tool with none, it answers with what it needs
      }
      msgs.push({ role: "tool", tool_call_id: call.id, content: await a.exec(call.function.name, args) });
    }
  }
  return { text: last, cost, tin, tout, error: null };
}

export function parseJson(text: string): any {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}
