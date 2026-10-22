// Cloudflare Workers throw "Illegal invocation" when the global fetch is called
// as a method of another object (`this.f(...)` with `f = fetch`). Clients
// that keep a fetch default to this plain wrapper instead.
export const plainFetch: typeof fetch = (input, init) => fetch(input, init);
