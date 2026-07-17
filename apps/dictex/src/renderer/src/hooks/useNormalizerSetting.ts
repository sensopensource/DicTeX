import { useEffect, useState } from "react";
import type { DictexApi } from "../api.js";

export type NormalizerSetting = {
  normalizerEnabled: boolean | null;
  isSettingNormalizer: boolean;
  canChangeNormalizerEnabled: boolean;
  changeNormalizerEnabled: (enabled: boolean) => Promise<void>;
};

/**
 * The persistent `Normalizer` On/Off switch (#105). `null` while the initial
 * read is in flight, so the UI can show a neutral "loading" state instead of
 * guessing a default.
 */
export function useNormalizerSetting({
  api,
  onNotice,
}: {
  api: DictexApi;
  onNotice: (message: string) => void;
}): NormalizerSetting {
  const [normalizerEnabled, setNormalizerEnabled] = useState<boolean | null>(null);
  const [isSettingNormalizer, setIsSettingNormalizer] = useState(false);

  useEffect(() => {
    if (typeof api.getNormalizerEnabled === "function") {
      void api
        .getNormalizerEnabled()
        .then(setNormalizerEnabled)
        .catch(() => onNotice("Could not read normalizer setting"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeNormalizerEnabled(enabled: boolean): Promise<void> {
    if (typeof api.setNormalizerEnabled !== "function") {
      onNotice("Restart DicTeX to load the normalizer settings API");
      return;
    }

    setIsSettingNormalizer(true);
    onNotice("");
    try {
      const nextEnabled = await api.setNormalizerEnabled(enabled);
      setNormalizerEnabled(nextEnabled);
      onNotice(
        nextEnabled
          ? "Normalizer enabled (math rules and command words apply to the next dictation)"
          : "Normalizer disabled (raw STT and literal command words apply to the next dictation)",
      );
    } catch (normalizerError) {
      onNotice(normalizerError instanceof Error ? normalizerError.message : "Could not change normalizer setting");
    } finally {
      setIsSettingNormalizer(false);
    }
  }

  return {
    normalizerEnabled,
    isSettingNormalizer,
    canChangeNormalizerEnabled: typeof api.setNormalizerEnabled === "function",
    changeNormalizerEnabled,
  };
}
