import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // xterm + addon-fit are pure JS and get bundled. Everything below stays
  // external: provided by Obsidian/Electron at runtime, or loaded dynamically.
  external: [
    "obsidian",
    "electron",
    "node-pty",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "main.js",
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
