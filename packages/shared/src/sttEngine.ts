import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Shared local-STT-engine invocation, used by both apps/dictex (dictation +
 * benchmark) and apps/lab (benchmark only) so the Python sidecar contract
 * (venv/DICTEX_PYTHON resolution, env vars, stdout JSON shape,
 * ProviderUnavailableError signal) never diverges between the two apps. See
 * AGENTS.md "Benchmark Vision" / docs/development.md "Second STT provider
 * (Vosk)" for the provider contract this wraps.
 */

export type SttConfig = {
  engine: string;
  model: string;
  language: string;
  device: string;
  computeType: string;
};

export type EngineTranscriptionResult = {
  transcript: string;
  sttEngine: string;
  sttModel: string;
  sttLanguage: string;
  audioDurationSeconds: number | null;
};

export type PythonInvocation = {
  command: string;
  argsPrefix: string[];
};

/**
 * Thrown when a benchmark provider's dependencies or local model files are
 * absent. The sidecar reports this as an `{"available": false}` result; the
 * caller should catch this to skip the candidate with a quiet diagnostic
 * instead of failing the segment. Never raised on the faster-whisper
 * dictation path, whose dependency is required.
 */
export class ProviderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Resolves which Python interpreter to invoke: an explicit `DICTEX_PYTHON`
 * env var wins, then the repo-root `.venv` (Windows `Scripts/python.exe`,
 * else `bin/python`) when present, else a platform default (`py -3.11` on
 * Windows, `python3` elsewhere). `repoRoot` must be the monorepo root (the
 * directory containing `.venv` and `packages/engine`), resolved by the
 * caller relative to its own built output location.
 */
export function getPythonInvocation(repoRoot: string): PythonInvocation {
  if (process.env.DICTEX_PYTHON) {
    return {
      command: process.env.DICTEX_PYTHON,
      argsPrefix: [],
    };
  }

  const venvPython =
    process.platform === "win32"
      ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
      : path.join(repoRoot, ".venv", "bin", "python");

  if (existsSync(venvPython)) {
    return {
      command: venvPython,
      argsPrefix: [],
    };
  }

  if (process.platform === "win32") {
    return {
      command: "py",
      argsPrefix: ["-3.11"],
    };
  }

  return {
    command: "python3",
    argsPrefix: [],
  };
}

/**
 * Spawns `packages/engine/transcribe.py` against one audio file and parses its
 * stdout JSON contract. `enginePath` and `repoRoot` are resolved by the caller
 * (they differ per app because each Electron main process's built output sits
 * at a different depth under the repo root).
 */
export function transcribeWithPython(
  enginePath: string,
  repoRoot: string,
  audioPath: string,
  config: SttConfig,
): Promise<EngineTranscriptionResult> {
  return new Promise((resolve, reject) => {
    const python = getPythonInvocation(repoRoot);
    const child = spawn(python.command, [...python.argsPrefix, enginePath, audioPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        PYTHONIOENCODING: "utf-8",
        DICTEX_STT_PROVIDER: config.engine,
        DICTEX_STT_MODEL: config.model,
        DICTEX_STT_LANGUAGE: config.language,
        DICTEX_STT_DEVICE: config.device,
        DICTEX_STT_COMPUTE_TYPE: config.computeType,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Transcription process exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          available?: unknown;
          reason?: unknown;
          transcript?: unknown;
          stt_engine?: unknown;
          stt_model?: unknown;
          stt_language?: unknown;
          stt_duration?: unknown;
        };
        if (parsed.available === false) {
          // Optional provider with absent deps/model files. Signal the caller to
          // skip this candidate quietly rather than treating it as a failure.
          reject(
            new ProviderUnavailableError(
              typeof parsed.reason === "string" ? parsed.reason : "provider unavailable",
            ),
          );
          return;
        }
        if (typeof parsed.transcript !== "string") {
          reject(new Error("Transcription process returned no transcript"));
          return;
        }
        resolve({
          transcript: parsed.transcript,
          sttEngine: typeof parsed.stt_engine === "string" ? parsed.stt_engine : "unknown",
          sttModel: typeof parsed.stt_model === "string" ? parsed.stt_model : "unknown",
          sttLanguage: typeof parsed.stt_language === "string" ? parsed.stt_language : "unknown",
          audioDurationSeconds: typeof parsed.stt_duration === "number" ? parsed.stt_duration : null,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

const defaultSttBenchmarkModels = ["tiny", "base", "small"];

/**
 * faster-whisper benchmark candidate model names, configurable via
 * `DICTEX_STT_BENCHMARK_MODELS` (comma-separated). Shared so apps/dictex's STT
 * model selector and apps/lab's benchmark candidate list read the exact same
 * env var the exact same way.
 */
export function getSttBenchmarkModels(): string[] {
  const envValue = process.env.DICTEX_STT_BENCHMARK_MODELS;
  if (!envValue) {
    return defaultSttBenchmarkModels;
  }

  const parsed = envValue
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  const unique = Array.from(new Set(parsed));

  return unique.length > 0 ? unique : defaultSttBenchmarkModels;
}
