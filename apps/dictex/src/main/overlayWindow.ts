import { BrowserWindow, screen } from "electron";

import type { OverlayView } from "./overlayState.js";

/**
 * The floating HUD window (#166): a frameless, transparent, always-on-top pane
 * pinned to a corner of the work area, reflecting the live dictation state so
 * the notebook never has to be left.
 *
 * Two properties are load-bearing and must not be relaxed:
 *
 * - `focusable: false`. DicTeX pastes by sending Ctrl+V to whatever window is
 *   active. An overlay that could take focus would make itself the active window
 *   and swallow the paste, so the dictation would land in the HUD instead of the
 *   notebook. Non-focusable also means the HUD never steals the caret mid-typing.
 * - click-through by default, via `setIgnoreMouseEvents(true, { forward: true })`.
 *   The HUD sits on top of the notebook; it must not intercept a click meant for
 *   the text under it. `forward: true` still delivers mousemove to the renderer,
 *   which is what lets the "inserted" card opt into being clickable while the
 *   pointer is actually over it (see `setInteractive`).
 *
 * The window is never on dictation's critical path: it is created after the main
 * window, it only ever reads state, and every failure here is contained by the
 * caller so a broken overlay cannot stop a dictation.
 */

export const OVERLAY_WIDTH = 360;
export const OVERLAY_HEIGHT = 208;
const OVERLAY_MARGIN = 18;

export type OverlayWindowOptions = {
  preloadPath: string;
  /** electron-vite's dev server URL, when running `dev`. */
  rendererUrl: string | undefined;
  /** The built `overlay.html`, when running from `out/`. */
  rendererFile: string;
  /** Called once the renderer has loaded and can receive a view. */
  onReady: () => void;
};

function getCornerPosition(): { x: number; y: number } {
  // The work area excludes the taskbar, so the HUD sits above it rather than
  // under it. Bottom-right is the corner least likely to cover a document's
  // text or an editor's own toolbars.
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - OVERLAY_WIDTH - OVERLAY_MARGIN,
    y: workArea.y + workArea.height - OVERLAY_HEIGHT - OVERLAY_MARGIN,
  };
}

export function createOverlayWindow(options: OverlayWindowOptions): BrowserWindow {
  const { x, y } = getCornerPosition();

  const overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    // A transparent window must stay unresizable on Windows for the alpha
    // channel to behave; the HUD is a fixed-size pane anyway.
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    acceptFirstMouse: false,
    // Shown only once the renderer has painted, so the HUD never flashes an
    // empty transparent rectangle over the notebook.
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // "screen-saver" floats above ordinary always-on-top windows, which is what
  // keeps the HUD visible over a maximized notebook.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setInteractive(overlayWindow, false);

  if (options.rendererUrl) {
    void overlayWindow.loadURL(`${options.rendererUrl}/overlay.html`);
  } else {
    void overlayWindow.loadFile(options.rendererFile);
  }

  overlayWindow.webContents.on("did-finish-load", () => {
    if (!overlayWindow.isDestroyed()) {
      // `showInactive` rather than `show`: showing must not activate the window,
      // or the very first paint would steal focus from the notebook.
      overlayWindow.showInactive();
      options.onReady();
    }
  });

  return overlayWindow;
}

/**
 * Toggle whether the HUD accepts clicks. The renderer asks for this while the
 * pointer is over the "inserted" card's toggle, and gives it straight back on
 * leave, so the window is click-through at every other moment. Even while
 * interactive the window stays non-focusable, so a click can operate the toggle
 * without ever making the HUD the active window.
 */
export function setInteractive(overlayWindow: BrowserWindow, interactive: boolean): void {
  if (overlayWindow.isDestroyed()) {
    return;
  }

  if (interactive) {
    overlayWindow.setIgnoreMouseEvents(false);
    return;
  }

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

export function sendOverlayView(overlayWindow: BrowserWindow | null, view: OverlayView): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }
  overlayWindow.webContents.send("overlay:view", view);
}
