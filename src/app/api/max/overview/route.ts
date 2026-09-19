import { getOverview } from "@/lib/max/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const overview = await getOverview();
    return Response.json({ ok: true, overview });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
