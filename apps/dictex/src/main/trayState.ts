import type { DictationStatus } from "./overlayState.js";
import type { WorkerLifecycleState } from "./overlayState.js";

export type TrayState = "ready" | "recording" | "error";

export function deriveTrayState(input: {
  dictationStatus: DictationStatus;
  workerState: WorkerLifecycleState | null;
}): TrayState {
  if (input.dictationStatus === "error" || input.workerState === "error") {
    return "error";
  }

  return input.dictationStatus === "recording" ? "recording" : "ready";
}
