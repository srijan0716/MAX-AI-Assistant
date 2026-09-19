import path from "path";

const SANDBOX_ROOT = "C:\\MAX_SANDBOX";

export function normalizeSandboxPath(inputPath: string): { ok: true; fullPath: string } | { ok: false; reason: string } {
  const cleanInput = inputPath.trim();
  const resolved = path.win32.resolve(SANDBOX_ROOT, cleanInput);
  const sandboxRootResolved = path.win32.resolve(SANDBOX_ROOT);

  if (!resolved.toLowerCase().startsWith(sandboxRootResolved.toLowerCase())) {
    return {
      ok: false,
      reason: `Path escapes MAX sandbox. Allowed root is ${SANDBOX_ROOT}`,
    };
  }

  return { ok: true, fullPath: resolved };
}

export function toConfirmationPhraseForDelete(filePath: string): string {
  return "confirm delete";
}

export const MAX_SANDBOX_ROOT = SANDBOX_ROOT;
