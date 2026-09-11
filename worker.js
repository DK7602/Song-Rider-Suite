export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        const row = await env.DB.prepare("SELECT 1 AS ok").first();
        return Response.json({
          ok: row?.ok === 1,
          app: "Chord Rider Pro",
          database: "connected"
        });
      } catch (error) {
        return Response.json(
          {
            ok: false,
            app: "Chord Rider Pro",
            database: "error",
            error: String(error?.message || error)
          },
          { status: 500 }
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { ok: false, error: "API route not found" },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
