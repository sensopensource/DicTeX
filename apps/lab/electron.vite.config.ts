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
  },
  renderer: {
    plugins: [react()],
  },
});
