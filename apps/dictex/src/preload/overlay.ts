import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import type { OverlayView } from "../main/overlayState.js";

/**
 * The HUD window's bridge (#166). Deliberately tiny: the overlay only receives a
 * derived view and asks for click-through to be lifted while the pointer is over
 * its one interactive control. It can read no dictation data and change no
 * setting — everything it shows was already decided by its owner.
 *
 * `OverlayView` is imported as a type from the main-process module that derives
 * it. The import is erased at build time (no runtime dependency crosses the
 * bridge); it exists so the view's shape cannot drift between the process that
 * produces it and the one that draws it.
 */
contextBridge.exposeInMainWorld("dictexOverlay", {
  onView: (callback: (view: OverlayView) => void) => {
    const listener = (_event: IpcRendererEvent, view: OverlayView) => callback(view);
    ipcRenderer.on("overlay:view", listener);
    return () => ipcRenderer.removeListener("overlay:view", listener);
  },
  /** Ask the main process to lift or restore click-through. Fire-and-forget. */
  setInteractive: (interactive: boolean) => ipcRenderer.send("overlay:set-interactive", interactive),
});
