// OpenRouter chat-completions shapes. Task 10 adds the client and the tool loop.

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type LlmResult = { text: string; tool_calls: ToolCall[]; cost: number; tin: number; tout: number; error: string | null };

export interface LlmPort {
  chat(model: string, messages: Msg[], tools?: ToolSpec[], maxTokens?: number): Promise<LlmResult>;
}
