// Test runner: bundles test/tests.ts with esbuild (aliasing "obsidian" to a
// local stub, since plugin modules import it) into a temp file and imports it.
// Any failed assert throws on import → non-zero exit. Run with `npm test`.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cch-tests-"));
const out = join(dir, "tests.mjs");
try {
  await build({
    entryPoints: [join(here, "tests.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    alias: { obsidian: join(here, "obsidian-stub.mjs") },
    logLevel: "silent",
  });
  await import(pathToFileURL(out).href);
  console.log("All tests passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
