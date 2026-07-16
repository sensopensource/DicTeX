import "./domEnvironment.js";

export type FakeAudioPlayer = {
  readonly src: string;
  paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
};

export type AudioPlaybackStub = {
  /** Object URLs handed out and not yet revoked. Must be empty once playback stops. */
  liveObjectUrls: () => string[];
  /** Every player constructed, oldest first. */
  players: () => FakeAudioPlayer[];
  /** Makes the next `play()` reject, as a browser does when it cannot decode. */
  failNextPlay: (message: string) => void;
  restore: () => void;
};

/**
 * Stubs the two browser globals jsdom does not implement: object URLs and media
 * playback.
 *
 * They are replaced on `globalThis` rather than injected into the hook, so the
 * hook under test keeps calling `URL.createObjectURL` and `new Audio(...)`
 * exactly as it does in Electron — no test-only seam in production code. Object
 * URLs are tracked so a test can assert the hook revokes every one it mints.
 */
export function stubAudioPlayback(): AudioPlaybackStub {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousAudio = globals.Audio;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;

  const live = new Set<string>();
  const players: FakeAudioPlayer[] = [];
  let nextUrl = 0;
  let playFailure: string | null = null;

  URL.createObjectURL = () => {
    const url = `blob:test/${(nextUrl += 1)}`;
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    live.delete(url);
  };

  class StubAudio implements FakeAudioPlayer {
    readonly src: string;
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(src: string) {
      this.src = src;
      players.push(this);
    }

    async play(): Promise<void> {
      if (playFailure !== null) {
        const message = playFailure;
        playFailure = null;
        throw new Error(message);
      }
      this.paused = false;
    }

    pause(): void {
      this.paused = true;
    }
  }

  globals.Audio = StubAudio;

  return {
    liveObjectUrls: () => [...live],
    players: () => [...players],
    failNextPlay: (message: string) => {
      playFailure = message;
    },
    restore: () => {
      globals.Audio = previousAudio;
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
    },
  };
}
