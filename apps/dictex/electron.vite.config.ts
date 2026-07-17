import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // @dictex/shared is a workspace package shipped as TS source (no build
    // step), so it must be bundled (transpiled) into main's output rather than
    // externalized to a runtime `require("@dictex/shared")`, which Node could
    // not resolve to a .ts file.
    plugins: [externalizeDepsPlugin({ exclude: ["@dictex/shared"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two bridges: Home's full API, and the HUD's receive-only one (#166).
        // Naming the inputs keeps `out/preload/index.mjs` where the main window
        // already expects it.
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          overlay: resolve(__dirname, "src/preload/overlay.ts"),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        // Two windows, two HTML entries. Both sit at the renderer root, so they
        // build to `out/renderer/index.html` and `out/renderer/overlay.html`.
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          overlay: resolve(__dirname, "src/renderer/overlay.html"),
        },
      },
    },
  },
});
