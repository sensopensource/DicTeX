import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@dictex/shared/styles.css";
import "./styles.css";

import { api } from "./api.js";
import { useDictation } from "./hooks/useDictation.js";
import { useHistory } from "./hooks/useHistory.js";
import { useNormalizerSetting } from "./hooks/useNormalizerSetting.js";
import { useOpenLab } from "./hooks/useOpenLab.js";
import { useSegmentAudio } from "./hooks/useSegmentAudio.js";
import { useSttConfig } from "./hooks/useSttConfig.js";
import { useSttWorkerStatus } from "./hooks/useSttWorkerStatus.js";
import { HomeView } from "./views/HomeView.js";

/**
 * Assembles DicTeX's single Home view: which hook feeds which piece of state.
 *
 * Every piece of state and every non-trivial effect lives in a hook under
 * `./hooks`; `App` holds only what is genuinely shared across them — the
 * one-line notice — and wires the one place where a concern must tell another
 * that something changed: a finished dictation refreshes the recent-segments
 * history. This mirrors the Lab's renderer split (`docs/development.md`
 * §"Structure du renderer du Lab").
 *
 * `api` is injected here rather than imported by each hook: `api.ts` reads
 * `window.dictex` while it is evaluated, so a hook importing it directly could
 * not be rendered outside Electron. Passing it from this one composition root
 * keeps every hook testable.
 */
function App(): React.ReactElement {
  const [notice, setNotice] = useState("");

  const history = useHistory({ api, onNotice: setNotice });
  const dictation = useDictation({ api, onNotice: setNotice, onTranscribed: () => void history.loadRecentSegments() });
  const sttConfig = useSttConfig({ api, onNotice: setNotice });
  const sttWorkerStatus = useSttWorkerStatus({ api });
  const normalizer = useNormalizerSetting({ api, onNotice: setNotice });
  const audio = useSegmentAudio({ api });
  const openLab = useOpenLab({ api, onNotice: setNotice });

  return (
    <HomeView
      dictation={dictation}
      sttConfig={sttConfig.sttConfig}
      availableSttModels={sttConfig.availableSttModels}
      isSettingSttModel={sttConfig.isSettingSttModel}
      canChangeSttModel={sttConfig.canChangeSttModel}
      changeSttModel={sttConfig.changeSttModel}
      sttWorkerStatus={sttWorkerStatus}
      normalizerEnabled={normalizer.normalizerEnabled}
      isSettingNormalizer={normalizer.isSettingNormalizer}
      canChangeNormalizerEnabled={normalizer.canChangeNormalizerEnabled}
      changeNormalizerEnabled={normalizer.changeNormalizerEnabled}
      recentSegments={history.recentSegments}
      historyError={history.historyError}
      isLoadingHistory={history.isLoadingHistory}
      loadRecentSegments={() => void history.loadRecentSegments()}
      audioError={audio.audioError}
      loadingAudioSegmentKey={audio.loadingAudioSegmentKey}
      playingAudioSegmentKey={audio.playingAudioSegmentKey}
      playHistoryAudio={(segment) => void audio.playHistoryAudio(segment)}
      copyHistoryTranscript={(segment, mode) => void history.copyHistoryTranscript(segment, mode)}
      isOpeningLab={openLab.isOpeningLab}
      openLab={() => void openLab.openLab()}
      openDataFolder={() => void api.openDataFolder()}
      openEventsLog={() => void api.openEventsLog()}
      openDictionaryFile={() => void api.openDictionaryFile()}
      openRulesFile={() => void api.openRulesFile()}
      notice={notice}
    />
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
