import { JSDOM } from "jsdom";

/**
 * Installs a DOM on `globalThis` for hook tests.
 *
 * DicTeX's renderer hooks are plain React hooks, but `react-dom/client` reads
 * `document` while it is being evaluated. This module therefore has to run
 * BEFORE `react-dom/client` is imported: `renderHook.ts` imports it first, and
 * ES modules are evaluated in import order, so the DOM exists by the time React
 * DOM looks for it.
 *
 * Only the globals a hook can reach are installed. `Audio` and
 * `URL.createObjectURL` are deliberately left to each test to stub: jsdom does
 * not implement media playback or object URLs, and stubbing them per test keeps
 * the hooks free of test-only seams (they call the same globals the browser
 * gives them at runtime).
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
globals.Node = dom.window.Node;
globals.Event = dom.window.Event;
globals.MessageChannel = dom.window.MessageChannel;

// Node ships a read-only `navigator` global, so it needs a redefinition rather
// than an assignment.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

// React's `act` refuses to run outside an environment that opts in explicitly.
globals.IS_REACT_ACT_ENVIRONMENT = true;

export {};
