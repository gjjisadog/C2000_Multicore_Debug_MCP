import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "dist/src/index.js";

await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  define: {
    __C2000_RUNTIME_BUNDLED__: "true"
  }
});

await chmod(outfile, 0o755);
