import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { stubAudioPlayback, type AudioPlaybackStub } from "./testing/audioPlaybackStub.js";
import { segmentFixture, stubLabApi } from "./testing/labApiStub.js";
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
  return stubLabApi({
    getSegmentAudio: async () => ({
      audioBytes: new Uint8Array([1, 2, 3]),
      mimeType: overrides.mimeType ?? "audio/webm",
    }),
  });
}

test("playing a segment reports it playing and holds exactly one object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  assert.equal(hook.current.playingAudioSegmentKey, "");

  await flush(() => hook.current.playSegmentAudio(segmentFixture()));

  assert.equal(hook.current.playingAudioSegmentKey, "session_1/segment_1");
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

  await flush(() => hook.current.playSegmentAudio(segment));
  await flush(() => hook.current.playSegmentAudio(segment));

  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);
  assert.equal(audio.players()[0].paused, true);
  // The toggle must not fetch a second time, only stop the running player.
  assert.equal(audio.players().length, 1);

  await hook.unmount();
});

test("playing another segment releases the previous one before starting", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });

  await flush(() => hook.current.playSegmentAudio(segmentFixture()));
  await flush(() => hook.current.playSegmentAudio(segmentFixture({ segmentId: "segment_2" })));

  assert.equal(hook.current.playingAudioSegmentKey, "session_1/segment_2");
  // One player is left running, so exactly one URL may still be alive.
  assert.equal(audio.liveObjectUrls().length, 1);
  assert.equal(audio.players()[0].paused, true);
  assert.equal(audio.players()[1].paused, false);

  await hook.unmount();
});

test("a failed read reports the error and leaves nothing playing or leaked", async () => {
  const api = stubLabApi({
    getSegmentAudio: async () => {
      throw new Error("Audio file is missing from the data folder");
    },
  });
  const hook = await renderHook(useSegmentAudio, { api });

  await flush(() => hook.current.playSegmentAudio(segmentFixture()));

  assert.equal(hook.current.audioError, "Audio file is missing from the data folder");
  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.equal(hook.current.loadingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);

  await hook.unmount();
});

test("a player that fails to start reports the error and revokes its object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  audio.failNextPlay("The element has no supported sources");

  await flush(() => hook.current.playSegmentAudio(segmentFixture()));

  assert.equal(hook.current.audioError, "The element has no supported sources");
  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);

  await hook.unmount();
});

test("playback reaching its end clears the playing segment and revokes its URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  await flush(() => hook.current.playSegmentAudio(segmentFixture()));

  await flush(() => audio.players()[0].onended?.());

  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);

  await hook.unmount();
});

test("a decode error on the running player is reported and releases it", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  await flush(() => hook.current.playSegmentAudio(segmentFixture()));

  await flush(() => audio.players()[0].onerror?.());

  assert.equal(hook.current.audioError, "Could not play session_1 / segment_1");
  assert.equal(hook.current.playingAudioSegmentKey, "");
  assert.deepEqual(audio.liveObjectUrls(), []);

  await hook.unmount();
});

test("unmounting stops playback and revokes the object URL", async () => {
  const hook = await renderHook(useSegmentAudio, { api: playbackApi() });
  await flush(() => hook.current.playSegmentAudio(segmentFixture()));
  assert.equal(audio.liveObjectUrls().length, 1);

  await hook.unmount();

  assert.deepEqual(audio.liveObjectUrls(), []);
  assert.equal(audio.players()[0].paused, true);
});
