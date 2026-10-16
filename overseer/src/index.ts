import { getAgentByName } from "agents";
import { Overseer } from "./agent";
import type { OverseerEnv } from "./env";
import { route, type Stub } from "./router";

export { Overseer };

export default {
  async fetch(req: Request, env: OverseerEnv): Promise<Response> {
    return route(req, env, async () => (await getAgentByName(env.Overseer, "ben")) as unknown as Stub);
  },
} satisfies ExportedHandler<OverseerEnv>;
