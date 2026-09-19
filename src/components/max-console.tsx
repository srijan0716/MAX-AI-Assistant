"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandResponse } from "@/lib/max/types";

type OverviewResponse = {
  ok: boolean;
  overview?: {
    identity: {
      name: string;
      mission: string;
      executionMode: string;
      safety: {
        confirmationModel: string;
        sandboxRoot: string;
        llmExecutionPolicy: string;
      };
    };
    phases: string[];
    devices: Array<{
      id: number;
      deviceKey: string;
      name: string;
      platform: string;
      isOnline: boolean;
      capabilities: string[];
      lastSeenAt: string;
    }>;
    sessions: Array<{
      id: number;
      state: string;
      sourceDeviceKey: string;
      startedAt: string;
      updatedAt: string;
    }>;
    recentLogs: Array<{
      id: number;
      transcript: string;
      proposedTool: string | null;
      permissionTier: number;
      success: boolean;
      stateBefore: string;
      stateAfter: string;
      resultMessage: string;
      createdAt: string;
      latencyMs: number;
    }>;
  };
  error?: string;
};

type SelfTestResponse = {
  ok: boolean;
  summary?: { total: number; passed: number; failed: number };
  results?: Array<{ name: string; passed: boolean; details: string }>;
  error?: string;
};

const QUICK_COMMANDS = [
  "MAX",
  "MAX, open Chrome",
  "MAX, open WhatsApp on my phone",
  "MAX, open VS Code on my laptop",
  "MAX, take a screenshot",
  "MAX, delete test.txt",
  "confirm delete",
  "MAX, go to sleep",
  "MAX, disable yourself",
  "enable MAX",
];

const PIPELINE_STAGES = ["Wake", "STT", "Intent", "Model", "Validate", "Permission", "Execute", "TTS"] as const;
type StageName = (typeof PIPELINE_STAGES)[number];
type StageStatus = "idle" | "active" | "done" | "error";

type WebkitSpeechRecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type BrowserWindow = Window & {
  webkitSpeechRecognition?: WebkitSpeechRecognitionCtor;
  SpeechRecognition?: WebkitSpeechRecognitionCtor;
};

function formatTime(input: string): string {
  const date = new Date(input);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getStateTone(state: string): string {
  switch (state) {
    case "ACTIVE":
      return "text-emerald-300";
    case "THINKING":
    case "EXECUTING":
      return "text-cyan-300";
    case "SPEAKING":
      return "text-violet-300";
    case "DISABLED":
      return "text-red-300";
    case "INTERRUPTED":
      return "text-amber-300";
    default:
      return "text-slate-300";
  }
}

function initialPipeline(): Record<StageName, StageStatus> {
  return PIPELINE_STAGES.reduce(
    (acc, stage) => {
      acc[stage] = "idle";
      return acc;
    },
    {} as Record<StageName, StageStatus>,
  );
}

export function MaxConsole() {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewResponse["overview"]>();
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("MAX");
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [sourceDeviceKey, setSourceDeviceKey] = useState("laptop-main");
  const [lastResponse, setLastResponse] = useState<CommandResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [pipeline, setPipeline] = useState<Record<StageName, StageStatus>>(initialPipeline());
  const [isListening, setIsListening] = useState(false);
  const [micArmed, setMicArmed] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [selfTest, setSelfTest] = useState<SelfTestResponse | null>(null);
  const [runningTest, setRunningTest] = useState(false);

  const recognitionRef = useRef<{
    start: () => void;
    stop: () => void;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
  } | null>(null);
  const manualStopRef = useRef(false);
  const restartBlockedUntilRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micArmedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const sendingRef = useRef(false);
  const voiceSupportedRef = useRef(false);
  const isListeningRef = useRef(false);

  async function loadOverview() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/max/overview", { cache: "no-store" });
    const data = (await res.json()) as OverviewResponse;

    if (!data.ok || !data.overview) {
      setError(data.error ?? "Failed to load MAX overview");
      setLoading(false);
      return;
    }

    setOverview(data.overview);
    setLoading(false);
  }

  function clearRestartTimer() {
    if (!restartTimerRef.current) return;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
  }

  function canListenNow() {
    return (
      micArmedRef.current &&
      voiceSupportedRef.current &&
      !sendingRef.current &&
      !isSpeakingRef.current &&
      Date.now() >= restartBlockedUntilRef.current
    );
  }

  function maybeStartListening(delayMs = 0) {
    if (!recognitionRef.current || isListeningRef.current) return;

    clearRestartTimer();
    restartTimerRef.current = setTimeout(() => {
      if (!recognitionRef.current || isListeningRef.current || !canListenNow()) return;
      try {
        manualStopRef.current = false;
        recognitionRef.current.start();
        isListeningRef.current = true;
        setIsListening(true);
      } catch {
        // Browser may throw if recognition is already starting/stopping.
      }
    }, delayMs);
  }

  function stopListening(manual = false) {
    if (!recognitionRef.current) return;
    manualStopRef.current = manual;
    clearRestartTimer();
    try {
      recognitionRef.current.stop();
    } catch {
      // Ignore stop errors from stale browser state.
    }
    isListeningRef.current = false;
    setIsListening(false);
  }

  useEffect(() => {
    micArmedRef.current = micArmed;
    isSpeakingRef.current = isSpeaking;
    sendingRef.current = sending;
    voiceSupportedRef.current = voiceSupported;
    isListeningRef.current = isListening;
  }, [micArmed, isSpeaking, sending, voiceSupported, isListening]);

  useEffect(() => {
    loadOverview().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      loadOverview().catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!micArmed) {
      stopListening(true);
      return;
    }

    if (!voiceSupported || sending || isSpeaking) return;

    if (!isListening) {
      maybeStartListening(100);
    }
  }, [micArmed, voiceSupported, sending, isSpeaking, isListening]);

  useEffect(() => {
    const w = window as BrowserWindow;
    const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceSupported(false);
      return;
    }

    setVoiceSupported(true);
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      const clean = transcript.trim();
      if (!clean) return;

      setCommand(clean);
      stopListening(false);
      runCommand(clean).catch(() => undefined);
    };

    recognition.onerror = () => {
      isListeningRef.current = false;
      setIsListening(false);
      if (canListenNow()) {
        maybeStartListening(350);
      }
    };

    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);
      if (!manualStopRef.current && canListenNow()) {
        maybeStartListening(250);
      }
      manualStopRef.current = false;
    };

    recognitionRef.current = recognition;

    return () => {
      clearRestartTimer();
      try {
        recognition.stop();
      } catch {
        // no-op
      }
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!lastResponse) return;
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    restartBlockedUntilRef.current = Date.now() + 1200;
    setIsSpeaking(true);
    isSpeakingRef.current = true;
    stopListening(false);

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(lastResponse.assistantReply);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 0.9;
    utterance.onend = () => {
      setIsSpeaking(false);
      isSpeakingRef.current = false;
      if (micArmedRef.current) {
        maybeStartListening(400);
      }
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      isSpeakingRef.current = false;
      if (micArmedRef.current) {
        maybeStartListening(400);
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [lastResponse]);

  const latestState = useMemo(() => {
    if (lastResponse) return lastResponse.stateAfter;
    return overview?.sessions?.[0]?.state ?? "SLEEP";
  }, [lastResponse, overview?.sessions]);

  const wakeCounters = useMemo(() => {
    const logs = overview?.recentLogs ?? [];
    const activations = logs.filter((l) => /^max$|wake up/i.test(l.transcript.trim())).length;
    const rejected = logs.filter((l) => l.resultMessage.toLowerCase().includes("sleeping") || l.resultMessage.toLowerCase().includes("disabled")).length;
    return { activations, rejected, missed: 0 };
  }, [overview?.recentLogs]);

  const memoryPreview = useMemo(() => {
    const logs = overview?.recentLogs ?? [];
    const browser = logs.find((l) => l.transcript.toLowerCase().includes("chrome"))?.transcript ?? "No browser preference learned yet.";
    const project = logs.find((l) => l.transcript.toLowerCase().includes("project"))?.transcript ?? "No project memory yet.";
    const action = logs[0]?.resultMessage ?? "No stored tasks.";
    return { browser, project, action };
  }, [overview?.recentLogs]);

  function markStage(stage: StageName, status: StageStatus) {
    setPipeline((prev) => ({ ...prev, [stage]: status }));
  }

  async function runCommand(commandText?: string) {
    const transcript = (commandText ?? command).trim();
    if (!transcript) return;

    restartBlockedUntilRef.current = Date.now() + 500;
    stopListening(false);

    setSending(true);
    setError(null);
    setPipeline(initialPipeline());

    markStage("Wake", "done");
    markStage("STT", "active");
    await new Promise((r) => setTimeout(r, 100));
    markStage("STT", "done");
    markStage("Intent", "active");

    const res = await fetch("/api/max/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, sourceDeviceKey, sessionId }),
    });

    const data = (await res.json()) as { ok: boolean; response?: CommandResponse; error?: string };

    if (!data.ok || !data.response) {
      markStage("Intent", "error");
      markStage("Model", "error");
      markStage("Validate", "error");
      markStage("Permission", "error");
      markStage("Execute", "error");
      markStage("TTS", "error");
      setError(data.error ?? "Command failed");
      setSending(false);
      return;
    }

    markStage("Intent", "done");
    markStage("Model", "done");
    markStage("Validate", "done");
    markStage("Permission", "done");
    markStage("Execute", data.response.execution?.success ?? true ? "done" : "error");
    markStage("TTS", "active");

    setLastResponse(data.response);
    setSessionId(data.response.sessionId);
    setCommand("");
    setSending(false);

    await loadOverview();
    markStage("TTS", "done");
  }

  async function runSelfTest() {
    setRunningTest(true);
    setSelfTest(null);
    setError(null);

    const res = await fetch("/api/max/self-test", { method: "POST" });
    const data = (await res.json()) as SelfTestResponse;

    if (!data.ok) {
      setError(data.error ?? "Self test failed");
      setRunningTest(false);
      return;
    }

    setSelfTest(data);
    setRunningTest(false);
    await loadOverview();
  }

  function toggleListening() {
    if (!voiceSupported || !recognitionRef.current) return;

    if (micArmed) {
      setMicArmed(false);
      stopListening(true);
      return;
    }

    restartBlockedUntilRef.current = 0;
    setMicArmed(true);
    maybeStartListening(80);
  }

  const orbStateLabel = isSpeaking
    ? "Speaking"
    : isListening
      ? "Listening"
      : sending
        ? "Thinking"
        : micArmed
          ? "Armed"
          : "Standby";

  return (
    <main className="min-h-screen bg-[#07090f] text-slate-200">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#07090f]/95 backdrop-blur">
        <div className="mx-auto flex h-20 w-full max-w-[1600px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <p className="text-3xl font-semibold tracking-tight text-white">MAX</p>
            <p className={`text-sm uppercase tracking-[0.3em] ${getStateTone(latestState)}`}>{latestState}</p>
            <p className="text-sm text-slate-500">model router: auto</p>
          </div>

          <div className="flex items-center gap-3">
            <p className="hidden text-2xl text-slate-400 sm:block">System</p>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-1">
              <button
                onClick={() => setSourceDeviceKey("laptop-main")}
                className={`rounded-xl px-5 py-2 text-sm ${sourceDeviceKey === "laptop-main" ? "bg-white/10 text-white" : "text-slate-400"}`}
              >
                Laptop
              </button>
              <button
                onClick={() => setSourceDeviceKey("phone-main")}
                className={`rounded-xl px-5 py-2 text-sm ${sourceDeviceKey === "phone-main" ? "bg-white/10 text-white" : "text-slate-400"}`}
              >
                Phone
              </button>
            </div>
            <button onClick={toggleListening} className="rounded-lg border border-white/10 px-3 py-2 text-slate-300">
              {micArmed ? (isListening ? "◉" : "◎") : "◌"}
            </button>
            <button onClick={() => setSessionId(undefined)} className="rounded-lg border border-white/10 px-4 py-2 font-medium text-white">
              Reset lab
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1600px] gap-4 px-4 py-5 sm:px-6 xl:grid-cols-[280px_1fr_380px]">
        <aside className="space-y-4">
          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-6">
            <div className="mx-auto grid h-64 w-64 place-items-center rounded-full border border-white/10">
              <div className="grid h-52 w-52 place-items-center rounded-full border border-white/10">
                <div className="grid h-36 w-36 place-items-center rounded-full border border-white/10 bg-[#0b0d12] text-5xl font-semibold text-white">
                  MAX
                </div>
              </div>
            </div>
            <p className="mt-5 text-center text-sm uppercase tracking-[0.35em] text-slate-400">{latestState}</p>
            <p className="mt-2 text-center text-xl text-slate-200">Wake phrase armed</p>
            <p className="mt-5 text-center text-2xl text-slate-500">Awaiting a command.</p>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-6">
            <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Capture</p>
            <p className="mt-3 text-[30px] leading-tight text-slate-300">Type a command. Arm the microphone only if you want voice.</p>
            <button onClick={toggleListening} className="mt-6 rounded-2xl border border-white/15 bg-[#151923] px-6 py-3 text-2xl font-semibold text-white">
              {micArmed ? "Disarm microphone" : "Arm microphone"}
            </button>
            <p className="mt-4 text-xl text-slate-500">
              {voiceSupported
                ? isListening
                  ? "● listening"
                  : micArmed
                    ? "◎ armed (auto-restart on)"
                    : "⚡ echo gate closed"
                : "⚠ browser voice API unavailable"}
            </p>
          </section>
        </aside>

        <section className="space-y-4">
          <article className="rounded-[32px] border border-white/10 bg-[#111319] p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between px-1">
              <div>
                <p className="text-sm uppercase tracking-[0.25em] text-slate-400">Laptop</p>
                <p className="text-3xl text-slate-200">Windows agent · lab</p>
              </div>
              <p className="text-xl text-slate-500">42</p>
            </div>

            <div className="rounded-3xl border border-white/5 bg-[linear-gradient(transparent_39px,rgba(255,255,255,0.03)_40px),linear-gradient(90deg,transparent_39px,rgba(255,255,255,0.03)_40px)] bg-[size:40px_40px] p-4">
              <div className="grid min-h-[290px] place-items-end rounded-2xl border border-white/10 bg-[#1a1f2b]/70 p-4">
                <div className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-[#090c12] px-4 py-3">
                  <div className="flex items-center gap-4 text-xl text-slate-300 sm:text-2xl">
                    <p className="text-4xl font-semibold text-white">MAX</p>
                    <span>◎</span>
                    <span>&lt;&gt;</span>
                    <span>♫</span>
                    <span>⌂</span>
                    <span>›_</span>
                    <span>⚙</span>
                  </div>
                  <p className="text-xl text-slate-500">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            </div>

            <p className="mt-3 text-2xl text-slate-500">No windows open. Ask MAX, or use the taskbar.</p>
          </article>

          <article className="rounded-[32px] border border-white/10 bg-[#111319] p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between px-1">
              <div>
                <p className="text-sm uppercase tracking-[0.25em] text-slate-400">Phone</p>
                <p className="text-3xl text-slate-200">Android agent · lab</p>
              </div>
              <p className="text-xl text-slate-500">55</p>
            </div>

            <div className="grid place-items-center rounded-3xl border border-white/5 bg-[#0e1016] p-5">
              <div className="w-[300px] rounded-[42px] border border-white/10 bg-[#080b12] p-5">
                <div className="mb-4 flex items-center justify-between text-lg text-slate-400">
                  <span>10:56 AM</span>
                  <span>55</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center text-sm text-slate-300">
                  {["WhatsApp", "YouTube", "Chrome", "Settings", "Photos", "Phone", "Camera"].map((app) => (
                    <div key={app} className="space-y-1">
                      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/5">◌</div>
                      <p>{app}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-[1fr_auto] gap-2 rounded-3xl border border-white/10 bg-[#0e1016] p-2">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runCommand().catch(() => undefined);
                  }
                }}
                placeholder="Command MAX..."
                className="w-full rounded-2xl bg-transparent px-4 py-3 text-2xl text-slate-200 outline-none placeholder:text-slate-500"
              />
              <button
                onClick={() => runCommand().catch(() => undefined)}
                disabled={sending || loading}
                className="rounded-2xl bg-slate-500/70 px-6 py-3 text-2xl text-black transition hover:bg-slate-400 disabled:opacity-50"
              >
                {sending ? "..." : "Send"}
              </button>
            </div>

            <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
              {QUICK_COMMANDS.map((sample) => (
                <button
                  key={sample}
                  onClick={() => setCommand(sample)}
                  className="whitespace-nowrap rounded-full border border-white/10 bg-[#0b0d13] px-4 py-2 text-2xl text-slate-300"
                >
                  {sample}
                </button>
              ))}
            </div>

            {lastResponse ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-[#0d1118] p-3">
                <p className="text-xl text-slate-200">{lastResponse.assistantReply}</p>
                <p className="mt-1 text-lg text-slate-500">
                  {lastResponse.intent.type} · {lastResponse.latencyMs}ms · {lastResponse.stateBefore} → {lastResponse.stateAfter}
                </p>
              </div>
            ) : null}

            {error ? <p className="mt-3 text-lg text-red-300">{error}</p> : null}
          </article>

          <p className="px-1 text-xl text-slate-500">
            Lab agents execute against a virtual laptop and phone. They do not control the machine in your hands yet.
            Native Windows and Android daemons plug into this same action engine later.
          </p>
        </section>

        <aside className="space-y-4">
          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-4xl font-semibold text-white">Pipeline</p>
              <span className="text-xl text-slate-500">_</span>
            </div>
            <div className="space-y-2 text-2xl">
              {PIPELINE_STAGES.map((stage) => {
                const status = pipeline[stage];
                const tone =
                  status === "done"
                    ? "text-emerald-300"
                    : status === "active"
                      ? "text-cyan-300"
                      : status === "error"
                        ? "text-red-300"
                        : "text-slate-400";
                return (
                  <div key={stage} className="flex items-center justify-between">
                    <span className={tone}>• {stage}</span>
                    <span className={tone}>{status}</span>
                  </div>
                );
              })}
              <p className="pt-2 text-slate-500">total _</p>
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-4xl font-semibold text-white">Session log</p>
              <span className="text-2xl text-slate-500">{overview?.recentLogs.length ?? 0}</span>
            </div>
            <div className="max-h-56 space-y-2 overflow-auto text-lg text-slate-300">
              {(overview?.recentLogs ?? []).slice(0, 8).map((log) => (
                <div key={log.id} className="rounded-xl border border-white/10 bg-[#0d1118] p-2">
                  <p>{log.transcript}</p>
                  <p className="text-slate-500">
                    {log.proposedTool ?? "none"} · T{log.permissionTier} · {log.success ? "ok" : "fail"} · {formatTime(log.createdAt)}
                  </p>
                </div>
              ))}
              {(overview?.recentLogs.length ?? 0) === 0 ? <p className="text-slate-500">No turns yet.</p> : null}
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <p className="text-4xl font-semibold text-white">Wake</p>
            <p className="mt-2 text-2xl text-slate-300">
              activations {wakeCounters.activations} · rejected {wakeCounters.rejected} · missed {wakeCounters.missed}
            </p>
            <p className="mt-2 text-xl text-slate-500">CPU of local wake model is not measured here — this preview uses transcript matching.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {["max", "wake up", "wake up daddys home"].map((w) => (
                <span key={w} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xl text-slate-300">
                  {w}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <p className="text-4xl font-semibold text-white">Memory</p>
            <p className="mt-2 text-2xl text-slate-300">Browser · {memoryPreview.browser}</p>
            <p className="text-2xl text-slate-300">Project · {memoryPreview.project}</p>
            <p className="mt-2 text-xl text-slate-500">{memoryPreview.action}</p>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-4xl font-semibold text-white">Diagnostics</p>
              <button
                onClick={() => runSelfTest().catch(() => undefined)}
                disabled={runningTest}
                className="rounded-xl border border-white/10 px-3 py-1 text-xl text-white disabled:opacity-50"
              >
                {runningTest ? "Running..." : "Run self-test"}
              </button>
            </div>
            {selfTest?.summary ? (
              <p className="text-xl text-slate-300">
                total {selfTest.summary.total} · passed {selfTest.summary.passed} · failed {selfTest.summary.failed}
              </p>
            ) : (
              <p className="text-xl text-slate-500">No diagnostic run yet.</p>
            )}
            <div className="mt-2 max-h-40 space-y-1 overflow-auto text-sm">
              {selfTest?.results?.map((r) => (
                <div key={r.name} className={`rounded-lg border px-2 py-1 ${r.passed ? "border-emerald-400/30 text-emerald-300" : "border-red-400/30 text-red-300"}`}>
                  {r.name}: {r.passed ? "pass" : "fail"}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[28px] border border-white/10 bg-[#111319] p-5">
            <p className="mb-3 text-4xl font-semibold text-white">Tools</p>
            <div className="max-h-72 space-y-1 overflow-auto text-2xl text-slate-200">
              {Array.from(new Set(overview?.devices.flatMap((device) => device.capabilities).concat(["delete_sandbox_file"]) ?? ["open_app"])).map((tool) => {
                const tier = tool.includes("delete") ? "T3" : tool.includes("close") || tool.includes("volume") ? "T2" : "T1";
                return (
                  <div key={tool} className="flex items-center justify-between border-b border-white/5 pb-1">
                    <span>{tool}</span>
                    <span className="text-slate-500">{tier}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      <button
        onClick={() => {
          if (micArmed) {
            toggleListening();
            return;
          }

          if (command.trim()) {
            runCommand().catch(() => undefined);
            return;
          }

          toggleListening();
        }}
        className="fixed bottom-7 right-7 z-30 grid h-20 w-20 place-items-center rounded-full border border-cyan-300/50 bg-cyan-500/10 text-2xl text-cyan-200 shadow-[0_0_45px_rgba(34,211,238,0.4)] backdrop-blur transition hover:scale-105"
        title="MAX floating assistant"
      >
        {isListening ? "◉" : isSpeaking ? "◍" : sending ? "⋯" : micArmed ? "◎" : "◌"}
      </button>

      <div className="pointer-events-none fixed bottom-7 right-32 z-30 rounded-full border border-white/10 bg-[#0f131d]/85 px-4 py-2 text-sm text-slate-300 backdrop-blur">
        MAX {orbStateLabel}
      </div>
    </main>
  );
}
