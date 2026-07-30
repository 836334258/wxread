import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
  logLevel: "info"
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching 微信读书阅读器...");
} else {
  await esbuild.build(options);
}
