import type { SttBenchmarkResult } from "@dictex/shared";

/**
 * Guards the two terminal conditions of a tracked STT run before an append-only
 * event can claim that meaningful work happened.
 */
export function requireNonEmptySttBenchmarkSnapshot(snapshot: readonly unknown[]): void {
  if (snapshot.length === 0) {
    throw new Error("Cannot start an STT benchmark run with no evaluable audio segment");
  }
}

/**
 * An optional provider may be unavailable, but a segment only succeeds when at
 * least one launched candidate actually logged an output. Otherwise the caller
 * records a normal per-segment failure in the terminal run event.
 */
export function requireSttBenchmarkOutput(
  results: readonly SttBenchmarkResult[],
  diagnostics: readonly string[],
): void {
  if (results.length > 0) {
    return;
  }

  const detail = diagnostics.length > 0 ? ` ${diagnostics.join("; ")}` : "";
  throw new Error(`No STT candidate produced an output for this segment.${detail}`);
}
