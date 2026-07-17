import { useEffect, useState } from "react";
import type { DictexApi, SttWorkerStatus } from "../api.js";

/**
 * Tracks the persistent STT worker's lifecycle (#114/#115/#116): an initial
 * read plus live push notifications, so Home can show `Preparing` / `Ready` /
 * `Busy` / `Restarting` / `Error` without polling.
 */
export function useSttWorkerStatus({ api }: { api: DictexApi }): SttWorkerStatus | null {
  const [sttWorkerStatus, setSttWorkerStatus] = useState<SttWorkerStatus | null>(null);

  useEffect(() => {
    if (typeof api.getSttWorkerStatus === "function") {
      void api.getSttWorkerStatus().then(setSttWorkerStatus).catch(() => {
        // The live notification still updates the status once the worker changes state.
      });
    }

    const removeListener = api.onSttWorkerStatus?.(setSttWorkerStatus);
    return () => {
      removeListener?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return sttWorkerStatus;
}
