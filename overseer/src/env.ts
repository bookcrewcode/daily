// Bindings and vars come from wrangler.jsonc via `wrangler types` (Cloudflare.Env);
// the secrets below are set with `wrangler secret put` and never live in the config.
export interface OverseerEnv extends Cloudflare.Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  // shared secret for the overseer-db proxy (its SHA-256 sits in the Supabase vault)
  OVERSEER_DB_SECRET: string;
  OPENROUTER_API_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
