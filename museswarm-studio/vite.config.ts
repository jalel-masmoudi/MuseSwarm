import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "path";

/** Studio is ESM; src/scenarios.js is CommonJS. Wrap it so the fallback can import the live presets. */
function scenariosEsm(): Plugin {
  return {
    name: "scenarios-esm",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0] ?? id;
      if (!file.endsWith(`${path.sep}src${path.sep}scenarios.js`)) return null;
      const source = fs.readFileSync(file, "utf8");
      return `const module = { exports: {} };\nconst exports = module.exports;\n${source}\nexport default module.exports;\n`;
    },
  };
}

export default defineConfig({
  plugins: [scenariosEsm(), react(), tailwindcss(), tsconfigPaths()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4321",
        changeOrigin: true,
      },
      "/preview": {
        target: "http://localhost:4321",
        changeOrigin: true,
      },
    },
  },
});
