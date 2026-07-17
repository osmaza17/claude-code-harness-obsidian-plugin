// Regression tests for the pure logic that historically breaks silently:
// the best-effort TUI regexes, the schedule windows and the .jsonl handling.
// Run with `npm test` (test/run.mjs builds this file with esbuild and imports it).
// No framework: plain asserts, the import throws on the first failure.

import { strict as assert } from "assert";
import {
  looksLikePrompt,
  LIMIT_STOP_RE,
  AUTH_FAIL_RE,
  DEFAULT_USAGE_RE,
} from "../constants";
import { parseHM, timeBlockedAt, stripDiacritics } from "../utils";
import { encodeProjectSlug, parseConversation } from "../exporter";

// ---------- parseHM ----------
assert.equal(parseHM("09:30"), 570);
assert.equal(parseHM("9:05"), 545);
assert.equal(parseHM("23:59"), 1439);
assert.equal(parseHM("00:00"), 0);
assert.equal(parseHM("24:00"), null);
assert.equal(parseHM("12:60"), null);
assert.equal(parseHM("9h30"), null);
assert.equal(parseHM(""), null);

// ---------- timeBlockedAt ----------
// A Date on a given JS weekday (0=Sun … 6=Sat) at h:m, self-checked.
function onDay(day: number, h: number, m: number): Date {
  const d = new Date(2026, 6, 1, h, m);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);
  assert.equal(d.getDay(), day);
  return d;
}
const MON = 1, TUE = 2, SUN = 0;

const sameDay = [{ start: "09:00", end: "17:00", days: [MON] }];
assert.equal(timeBlockedAt(sameDay, onDay(MON, 10, 0)), true);
assert.equal(timeBlockedAt(sameDay, onDay(MON, 8, 59)), false);
assert.equal(timeBlockedAt(sameDay, onDay(MON, 17, 0)), false); // end exclusive
assert.equal(timeBlockedAt(sameDay, onDay(SUN, 10, 0)), false); // wrong day

// Overnight range: 22:00 Monday → 06:00 Tuesday belongs to MONDAY's entry.
const overnight = [{ start: "22:00", end: "06:00", days: [MON] }];
assert.equal(timeBlockedAt(overnight, onDay(MON, 23, 0)), true);
assert.equal(timeBlockedAt(overnight, onDay(TUE, 5, 59)), true); // yesterday was Mon
assert.equal(timeBlockedAt(overnight, onDay(TUE, 22, 30)), false); // Tue not in days
assert.equal(timeBlockedAt(overnight, onDay(MON, 5, 0)), false); // yesterday was Sun

// Fail-safe: no days / malformed / zero-length range never blocks.
assert.equal(timeBlockedAt([{ start: "09:00", end: "17:00", days: [] }], onDay(MON, 10, 0)), false);
assert.equal(timeBlockedAt([{ start: "junk", end: "17:00", days: [0, 1, 2, 3, 4, 5, 6] }], onDay(MON, 10, 0)), false);
assert.equal(timeBlockedAt([{ start: "09:00", end: "09:00", days: [MON] }], onDay(MON, 9, 0)), false);

// ---------- looksLikePrompt (awaiting-input detection) ----------
// Real permission/plan sentences fire on their own.
assert.equal(looksLikePrompt("Do you want to proceed?"), true);
assert.equal(looksLikePrompt("Do you want to make this edit to main.ts?"), true);
assert.equal(looksLikePrompt("2. No, and tell Claude what to do differently"), true);
// The multi-part menu footer fires (nav hint + act hint together)…
assert.equal(looksLikePrompt("Enter to select · Tab/Arrow keys to navigate · Esc to cancel"), true);
// …including the glyph variant some CLI versions print instead of "arrow keys".
assert.equal(looksLikePrompt("↑/↓ to navigate · Enter to select"), true);
// A single fragment in PROSE must NOT fire (the false-positive guard).
assert.equal(looksLikePrompt("Press Esc to cancel the current generation at any time."), false);
assert.equal(looksLikePrompt("Use the arrow keys to navigate the buffer."), false);
assert.equal(looksLikePrompt("I ran the tests and everything passed."), false);

// ---------- LIMIT_STOP_RE (red tab + auto-switch fallback trigger) ----------
assert.equal(LIMIT_STOP_RE.test("You've reached your usage limit"), true);
assert.equal(LIMIT_STOP_RE.test("5-hour limit reached · resets at 7pm"), true);
assert.equal(LIMIT_STOP_RE.test("Claude usage limit reached"), true);
assert.equal(LIMIT_STOP_RE.test("weekly limit exceeded"), true);
// The status bar's bare "resets at" must NOT fire — the old LIMIT_RE matched it
// and caused an account switch on every cooldown (documented regression).
assert.equal(LIMIT_STOP_RE.test("5h:[▓▓░░░] 47% · resets at 19:00"), false);
assert.equal(LIMIT_STOP_RE.test("resets at 3am"), false);

// ---------- AUTH_FAIL_RE ----------
assert.equal(AUTH_FAIL_RE.test("Please run /login"), true);
assert.equal(AUTH_FAIL_RE.test("Invalid OAuth token"), true);
assert.equal(AUTH_FAIL_RE.test("token has expired"), true);
assert.equal(AUTH_FAIL_RE.test("HTTP 401"), true);
assert.equal(AUTH_FAIL_RE.test("Logged in as someone@example.com"), false);

// ---------- DEFAULT_USAGE_RE (status-bar 5h % scrape, backup source) ----------
{
  const re = new RegExp(DEFAULT_USAGE_RE);
  const m = re.exec("5h:[▓▓░░] 23% (3h 31m)");
  assert.ok(m && m[1] === "23");
  // Real status-bar text as of CLI 2026-07 (space after the colon, 7d after):
  // the 5h % must be captured, not the 7d one.
  const real = re.exec(
    "oscar.martinez-zamora@socratiz.fr  5h: 5% (4h 54m)  7d: 12% (4d 10h)  Fable 5 [high]  ctx:15%  (main)"
  );
  assert.ok(real && real[1] === "5");
  assert.equal(re.test("just 23% of the file"), false); // needs the 5h: anchor
}

// ---------- encodeProjectSlug (must mirror the CLI's real folder names) ----------
assert.equal(
  encodeProjectSlug("C:\\Users\\oscar\\Music\\SECOND BRAIN"),
  "C--Users-oscar-Music-SECOND-BRAIN"
);
// Dot → dash, verified against real ~/.claude/projects folders.
assert.equal(
  encodeProjectSlug("C:\\Users\\oscar\\Music\\SECOND BRAIN\\.obsidian\\plugins\\claude-code-harness"),
  "C--Users-oscar-Music-SECOND-BRAIN--obsidian-plugins-claude-code-harness"
);
assert.equal(encodeProjectSlug("C:\\Users\\oscar\\.ade\\trh-kl"), "C--Users-oscar--ade-trh-kl");

// ---------- parseConversation (.jsonl → messages, for the note exporter) ----------
{
  const jsonl = [
    JSON.stringify({ type: "user", message: { content: "hola" } }),
    // Partial then final snapshot of the SAME assistant response (same message.id):
    // the final text must win while keeping the message's position.
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "parcial" }] } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "respuesta final" }] } }),
    // Noise that must be dropped: meta records, slash-command echoes,
    // tool-only assistant records, unparseable lines.
    JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
    JSON.stringify({ type: "user", message: { content: "<command-name>/model</command-name>" } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Bash" }] } }),
    "{not json",
    JSON.stringify({ type: "user", message: { content: "segunda pregunta" } }),
  ].join("\n");
  const msgs = parseConversation(jsonl);
  assert.deepEqual(msgs, [
    { role: "user", text: "hola" },
    { role: "assistant", text: "respuesta final" },
    { role: "user", text: "segunda pregunta" },
  ]);
}

// ---------- stripDiacritics ----------
assert.equal(stripDiacritics("canción"), "cancion");
assert.equal(stripDiacritics("Ñandú"), "Nandu");

console.log("tests.ts: all assertions passed");
