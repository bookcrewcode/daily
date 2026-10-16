// Bindings and vars come from wrangler.jsonc via `wrangler types` (Cloudflare.Env);
// the secrets below are set with `wrangler secret put` and never live in the config.
export interface OverseerEnv extends Cloudflare.Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
