import { processCommand } from "@/lib/max/engine";

export const dynamic = "force-dynamic";

type CommandRequestBody = {
  transcript?: string;
  sourceDeviceKey?: string;
  sessionId?: number;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CommandRequestBody;

    if (!body.transcript || !body.transcript.trim()) {
      return Response.json({ ok: false, error: "transcript is required" }, { status: 400 });
    }

    const response = await processCommand({
      transcript: body.transcript,
      sourceDeviceKey: body.sourceDeviceKey,
      sessionId: body.sessionId,
    });

    return Response.json({ ok: true, response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
