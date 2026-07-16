import "./domEnvironment.js";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export type RenderedHook<TProps, TValue> = {
  /** The hook's latest return value. Re-read it after every action — it changes identity on each render. */
  readonly current: TValue;
  /** Renders again with new props, flushing effects. */
  rerender: (props: TProps) => Promise<void>;
  unmount: () => Promise<void>;
};

/**
 * Renders one hook in isolation and returns its value plus the controls a test
 * needs to drive it.
 *
 * Everything is wrapped in React's `act`, so state updates and effects (including
 * the microtasks an async handler resolves through) are flushed before the call
 * returns: a test can `await` a hook action and then assert on the settled state
 * without polling.
 *
 * Deliberately written without JSX: the test runner compiles this file with its
 * own defaults rather than the app's Vite config, so `createElement` keeps the
 * harness independent of which JSX transform is active.
 */
export async function renderHook<TProps, TValue>(
  useHook: (props: TProps) => TValue,
  initialProps: TProps,
): Promise<RenderedHook<TProps, TValue>> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  let latest!: TValue;
  let root!: Root;

  function Probe({ hookProps }: { hookProps: TProps }): null {
    latest = useHook(hookProps);
    return null;
  }

  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Probe, { hookProps: initialProps }));
  });

  return {
    get current() {
      return latest;
    },
    async rerender(props: TProps) {
      await act(async () => {
        root.render(createElement(Probe, { hookProps: props }));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Runs a hook callback (or any state-changing code) and flushes what it starts.
 *
 * `await flush(() => hook.current.save())` leaves React idle: the promise the
 * handler returned has settled and every resulting render has been committed.
 */
export async function flush(run: () => unknown): Promise<void> {
  await act(async () => {
    await run();
  });
}
