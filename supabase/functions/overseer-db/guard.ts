// Which requests the Overseer's database proxy forwards. Pure, so the agent's
// test suite pins it (overseer/test/dbproxy.test.ts); index.ts wraps it.
// Returns null to forward, or the reason it refuses.

export const TABLES = new Set([
  "nights", "game_days", "class_blocks", "goals", "goal_steps", "deadlines", "captures", "days",
  "user_settings", "study_sessions",
  "overseer_settings", "overseer_messages", "overseer_actions", "overseer_stakes_lines",
  "overseer_partners", "overseer_stakes_events", "overseer_spend",
]);

// the agent reads these but never writes them
const READ_ONLY = new Set(["user_settings", "study_sessions", "class_blocks"]);

const owned = (row: unknown, ben: string) => !!row && typeof row === "object" && (row as Record<string, unknown>).user_id === ben;

export function refusal(method: string, path: string, search: string, body: unknown, ben: string): string | null {
  const m = path.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (!m) return "path";
  const table = m[1];
  if (!TABLES.has(table)) return "table";
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) return "method";
  if (method !== "GET" && READ_ONLY.has(table)) return "read-only";
  if (method === "POST") {
    const rows = Array.isArray(body) ? body : [body];
    return rows.length > 0 && rows.every((r) => owned(r, ben)) ? null : "owner";
  }
  if (new URLSearchParams(search).get("user_id") !== `eq.${ben}`) return "owner";
  if (method === "PATCH" && body && typeof body === "object" && "user_id" in body && !owned(body, ben)) return "owner";
  return null;
}
