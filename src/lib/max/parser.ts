import type { ParsedIntent } from "@/lib/max/types";
import { WAKE_PHRASES } from "@/lib/max/types";

function detectLanguage(input: string): "english" | "mixed" | "unknown" {
  const lower = input.toLowerCase();
  const mixedHints = ["maadu", "khol", "alli", "pe"];
  if (mixedHints.some((token) => lower.includes(token))) {
    return "mixed";
  }
  if (/[a-z]/.test(lower)) {
    return "english";
  }
  return "unknown";
}

function detectTargetDevice(input: string): "laptop" | "phone" | undefined {
  const lower = input.toLowerCase();
  if (/(on my laptop|on laptop|on pc|on my pc|laptop)/.test(lower)) {
    return "laptop";
  }
  if (/(on my phone|on phone|android|mobile)/.test(lower)) {
    return "phone";
  }
  return undefined;
}

export function parseIntent(transcript: string): ParsedIntent {
  const original = transcript.trim();
  const lower = original.toLowerCase();
  const language = detectLanguage(original);
  const targetDeviceHint = detectTargetDevice(original);

  if (WAKE_PHRASES.some((phrase) => lower === phrase || lower.startsWith(`${phrase},`) || lower.startsWith(`${phrase} `))) {
    return {
      type: "WAKE",
      confidence: 0.99,
      language,
      targetDeviceHint,
      entities: {},
    };
  }

  if (/(go to sleep|sleep max|sleep now)/.test(lower)) {
    return { type: "SLEEP", confidence: 0.97, language, targetDeviceHint, entities: {} };
  }

  if (/(disable yourself|disable max|max disable|stop listening)/.test(lower)) {
    return { type: "DISABLE", confidence: 0.98, language, targetDeviceHint, entities: {} };
  }

  if (/(enable max|enable yourself|resume listening|turn on max)/.test(lower)) {
    return { type: "ENABLE", confidence: 0.97, language, targetDeviceHint, entities: {} };
  }

  if (/(max,? stop|stop max|interrupt)/.test(lower)) {
    return { type: "INTERRUPT", confidence: 0.99, language, targetDeviceHint, entities: {} };
  }

  const volumeMatch = lower.match(/volume\s+(\d{1,3})/);
  if (volumeMatch) {
    return {
      type: "SET_VOLUME",
      confidence: 0.9,
      language,
      targetDeviceHint,
      entities: { level: Number(volumeMatch[1]) },
    };
  }

  if (/(take a screenshot|capture screenshot|screenshot)/.test(lower)) {
    return { type: "TAKE_SCREENSHOT", confidence: 0.93, language, targetDeviceHint, entities: {} };
  }

  const urlMatch = original.match(/https?:\/\/\S+/i);
  if (urlMatch || /(open url|open website|launch website)/.test(lower)) {
    return {
      type: "OPEN_URL",
      confidence: 0.9,
      language,
      targetDeviceHint,
      entities: { url: urlMatch?.[0] ?? "https://example.com" },
    };
  }

  const deleteMatch = original.match(/delete\s+([\w\-.\\/]+)/i);
  if (deleteMatch) {
    return {
      type: "DELETE_SANDBOX_FILE",
      confidence: 0.88,
      language,
      targetDeviceHint,
      entities: { filePath: deleteMatch[1] },
    };
  }

  const openFolderMatch = original.match(/open (?:folder|directory)\s+(.+)/i);
  if (openFolderMatch) {
    return {
      type: "OPEN_FOLDER",
      confidence: 0.86,
      language,
      targetDeviceHint,
      entities: { path: openFolderMatch[1].trim() },
    };
  }

  const openFileMatch = original.match(/open file\s+(.+)/i);
  if (openFileMatch) {
    return {
      type: "OPEN_FILE",
      confidence: 0.86,
      language,
      targetDeviceHint,
      entities: { path: openFileMatch[1].trim() },
    };
  }

  const closeAppMatch = original.match(/close\s+([\w\s.+-]+)/i);
  if (closeAppMatch) {
    return {
      type: "CLOSE_APPLICATION",
      confidence: 0.87,
      language,
      targetDeviceHint,
      entities: { application: closeAppMatch[1].trim() },
    };
  }

  const openAppMatch = original.match(/open\s+([\w\s.+-]+)/i);
  if (openAppMatch) {
    return {
      type: "OPEN_APPLICATION",
      confidence: 0.89,
      language,
      targetDeviceHint,
      entities: { application: openAppMatch[1].trim() },
    };
  }

  return {
    type: "UNKNOWN",
    confidence: 0.4,
    language,
    targetDeviceHint,
    entities: {},
  };
}
