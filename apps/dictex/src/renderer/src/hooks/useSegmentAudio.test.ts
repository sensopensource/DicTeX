import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { stubAudioPlayback, type AudioPlaybackStub } from "./testing/audioPlaybackStub.js";
import { segmentFixture, stubDictexApi } from "./testing/dictexApiStub.js";
import { flush, renderHook } from "./testing/renderHook.js";
import { useSegmentAudio } from "./useSegmentAudio.js";

let audio: AudioPlaybackStub;

beforeEach(() => {
  audio = stubAudioPlayback();
});

afterEach(() => {
  audio.restore();
});

function playbackApi(overrides: { mimeType?: string } = {}) {
  return stubDictexApi({
    getSegmentAudio: async () => ({
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: overrides.mimeType ?? "audio/webm",
    }),
  });
}

test("without the preload API it reports a restart notice instead of throwing", async () => {
  const hook = await renderHook(useSegmentAudio, { api: stubDictexApi({}) });

  await flush(() => hook.current.playHistoryAudio(segmentFixture()));

  assert.equal(hook.current.audioError, "Restart DicTeX to load the audio playback API");
  assert.equal(hook.current.playingAudioSegmentKey, "");

  await hook.unmount();
});

test("playing a segment reports it playing and holds exactly one object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  assert.equal(hook.current.playingAudioSegmentKey, "");

  await flush(() => hook.current.playHistoryAudio(segmentFixture()));

  assert.equal(hook.current.playingAudioSegmentKey, "session_1::segment_1");
  assert.equal(hook.current.loadingAudioSegmentKey, "");
  assert.equal(hook.current.audioError, "");
  assert.equal(audio.liveObjectUrls().length, 1);
  assert.equal(audio.players().length, 1);
  assert.equal(audio.players()[0].paused, false);

  await hook.unmount();
});

test("playing the same segment again stops it and revokes its object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  const segment = segmentFixture();

  await flush(() => hook.current.playHistoryAudio(segment));
  await flush(() => hook.current.playHistoryAudio(segment));

  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);
  assert.equal(audio.players()[0].paused, true);
  assert.equal(audio.players().length, 1);

  await hook.unmount();
});

test("a failed read reports the error and leaves nothing playing or leaked", async () => {
  const api = stubDictexApi({
    getSegmentAudio: async () => {
      throw new Error("Audio file is missing from the data folder");
    },
  });
  const hook = await renderHook(useSegmentAudio, { api });

  await flush(() => hook.current.playHistoryAudio(segmentFixture()));

  assert.equal(hook.current.audioError, "Audio file is missing from the data folder");
  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);

  await hook.unmount();
});

test("unmounting stops playback and revokes the object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  await flush(() => hook.current.playHistoryAudio(segmentFixture()));
  assert.equal(audio.liveObjectUrls().length, 1);

  await hook.unmount();

  assert.deepEqual(audio.liveObjectUrls(), []);
  assert.equal(audio.players()[0].paused, true);
});
