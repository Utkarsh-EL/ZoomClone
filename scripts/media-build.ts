import { build } from "esbuild";
await build({ entryPoints: ["client/media-lab.js"], bundle: true, format: "esm", platform: "browser", outfile: ".local/media-lab.js", sourcemap: false });
