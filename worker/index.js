// Cloudflare Worker for parkbor.uz: only /b/<id> runs here (see wrangler.jsonc run_worker_first).
// Every booking link serves the same static helper page; the page validates the id itself.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/b/') && url.pathname !== '/b/') {
      return env.ASSETS.fetch(new Request(new URL('/b/', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
