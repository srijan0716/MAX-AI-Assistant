import { processCommand } from "@/lib/max/engine";

export const dynamic = "force-dynamic";

type TestResult = {
  name: string;
  passed: boolean;
  details: string;
};

export async function POST() {
  const results: TestResult[] = [];

  try {
    const wake = await processCommand({ transcript: "MAX", sourceDeviceKey: "laptop-main" });
    const sessionId = wake.sessionId;
    results.push({
      name: "wake",
      passed: wake.stateAfter === "ACTIVE",
      details: `stateAfter=${wake.stateAfter}`,
    });

    const openLaptop = await processCommand({
      transcript: "MAX, open VS Code on my laptop",
      sourceDeviceKey: "phone-main",
      sessionId,
    });
    results.push({
      name: "cross-device-laptop-route",
      passed: openLaptop.execution?.device === "laptop-main" && openLaptop.execution.success,
      details: `device=${openLaptop.execution?.device ?? "none"}`,
    });

    const openPhone = await processCommand({
      transcript: "MAX, open WhatsApp on my phone",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "cross-device-phone-route",
      passed: openPhone.execution?.device === "phone-main" && openPhone.execution.success,
      details: `device=${openPhone.execution?.device ?? "none"}`,
    });

    const deletePrompt = await processCommand({
      transcript: "MAX, delete test.txt",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "tier3-confirmation-required",
      passed: deletePrompt.assistantReply.toLowerCase().includes("confirm delete"),
      details: deletePrompt.assistantReply,
    });

    const deleteConfirm = await processCommand({
      transcript: "confirm delete",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "tier3-confirmation-executes",
      passed: deleteConfirm.execution?.success === true,
      details: deleteConfirm.assistantReply,
    });

    const sleep = await processCommand({ transcript: "MAX, go to sleep", sourceDeviceKey: "laptop-main", sessionId });
    results.push({
      name: "sleep-state",
      passed: sleep.stateAfter === "SLEEP",
      details: `stateAfter=${sleep.stateAfter}`,
    });

    const blockedInSleep = await processCommand({
      transcript: "MAX, open Chrome",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "sleep-gating",
      passed: blockedInSleep.assistantReply.toLowerCase().includes("sleeping"),
      details: blockedInSleep.assistantReply,
    });

    const wakeAgain = await processCommand({ transcript: "MAX", sourceDeviceKey: "laptop-main", sessionId });
    results.push({
      name: "wake-after-sleep",
      passed: wakeAgain.stateAfter === "ACTIVE",
      details: `stateAfter=${wakeAgain.stateAfter}`,
    });

    const disable = await processCommand({
      transcript: "MAX, disable yourself",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "disable-state",
      passed: disable.stateAfter === "DISABLED",
      details: `stateAfter=${disable.stateAfter}`,
    });

    const blockedWhenDisabled = await processCommand({
      transcript: "MAX, take a screenshot",
      sourceDeviceKey: "laptop-main",
      sessionId,
    });
    results.push({
      name: "disabled-gating",
      passed: blockedWhenDisabled.assistantReply.toLowerCase().includes("disabled"),
      details: blockedWhenDisabled.assistantReply,
    });

    const enable = await processCommand({ transcript: "enable MAX", sourceDeviceKey: "laptop-main", sessionId });
    results.push({
      name: "enable-state",
      passed: enable.stateAfter === "ACTIVE",
      details: `stateAfter=${enable.stateAfter}`,
    });

    const passedCount = results.filter((r) => r.passed).length;

    return Response.json({
      ok: true,
      summary: {
        total: results.length,
        passed: passedCount,
        failed: results.length - passedCount,
      },
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message, results }, { status: 500 });
  }
}
