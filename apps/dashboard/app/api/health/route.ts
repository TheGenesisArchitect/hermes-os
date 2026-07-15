import { NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/queries";

// Lightweight health surface for the top-right pin drawer. Kept off the main SSR
// path (it runs live feed-reachability probes) so the dashboard render stays fast;
// the drawer polls this on its own cadence while open.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const health = await getSystemHealth();
    return NextResponse.json(health, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "health check failed" },
      { status: 500 },
    );
  }
}
