import { useEffect, useState } from "react";
import type { DictexApi, SttConfig } from "../api.js";

export type SttConfigState = {
  sttConfig: SttConfig | null;
  availableSttModels: string[];
  isSettingSttModel: boolean;
  canChangeSttModel: boolean;
  changeSttModel: (model: string) => Promise<void>;
};

/**
 * Reads the active STT engine/model and the model catalog once at mount, and
 * applies a model change for subsequent dictations. In-flight transcriptions
 * are unaffected by a change (see `docs/development.md`, "Selecting the STT
 * model from the UI").
 */
export function useSttConfig({ api, onNotice }: { api: DictexApi; onNotice: (message: string) => void }): SttConfigState {
  const [sttConfig, setSttConfig] = useState<SttConfig | null>(null);
  const [availableSttModels, setAvailableSttModels] = useState<string[]>([]);
  const [isSettingSttModel, setIsSettingSttModel] = useState(false);

  useEffect(() => {
    void api.getSttConfig().then(setSttConfig).catch(() => {
      onNotice("Could not read STT config");
    });
    if (typeof api.getSttModels === "function") {
      void api.getSttModels().then(setAvailableSttModels).catch(() => {
        // Selector is optional; without the list the visible config line still shows the active model.
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeSttModel(model: string): Promise<void> {
    if (typeof api.setSttModel !== "function") {
      onNotice("Restart DicTeX to load the STT model settings API");
      return;
    }

    setIsSettingSttModel(true);
    onNotice("");
    try {
      const nextConfig = await api.setSttModel(model);
      setSttConfig(nextConfig);
      onNotice(`STT model set to ${nextConfig.model} (applies to next dictation)`);
    } catch (modelError) {
      onNotice(modelError instanceof Error ? modelError.message : "Could not change STT model");
    } finally {
      setIsSettingSttModel(false);
    }
  }

  return {
    sttConfig,
    availableSttModels,
    isSettingSttModel,
    canChangeSttModel: typeof api.setSttModel === "function",
    changeSttModel,
  };
}
