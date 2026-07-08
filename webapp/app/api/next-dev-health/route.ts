/*
 * Exports:
 * - runtime: run the Next dev health probe route in the Node.js runtime. Keywords: next, health, nodejs.
 * - dynamic: force dynamic handling so watchdog probes are never statically cached. Keywords: no-store, health.
 * - GET: return a tiny no-store health payload for orchestrator-side Next dev watchdog polling. Keywords: watchdog, turbopack, 500.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
