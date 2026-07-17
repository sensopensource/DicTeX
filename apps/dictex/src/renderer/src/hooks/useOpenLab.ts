import { useState } from "react";
import type { DictexApi } from "../api.js";

export type OpenLab = {
  isOpeningLab: boolean;
  openLab: () => Promise<void>;
};

/** Launches DicTeX Lab from the `Open Lab` button. */
export function useOpenLab({ api, onNotice }: { api: DictexApi; onNotice: (message: string) => void }): OpenLab {
  const [isOpeningLab, setIsOpeningLab] = useState(false);

  async function openLab(): Promise<void> {
    if (typeof api.openLab !== "function") {
      onNotice("Restart DicTeX to load the Open Lab API");
      return;
    }

    setIsOpeningLab(true);
    onNotice("");
    try {
      const result = await api.openLab();
      onNotice(result.ok ? "Opening DicTeX Lab…" : (result.error ?? "Could not open DicTeX Lab"));
    } catch (labError) {
      onNotice(labError instanceof Error ? labError.message : "Could not open DicTeX Lab");
    } finally {
      setIsOpeningLab(false);
    }
  }

  return { isOpeningLab, openLab };
}
