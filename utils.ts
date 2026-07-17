// Small pure/module-level helpers with no plugin state.

// Electron exposes Node's require on the window in the renderer. We use it to
// reach child_process without esbuild trying to bundle it. The optional chain
// keeps this module importable from plain Node (the test runner has no window).
export const nodeRequire: NodeRequire = (globalThis as any).window?.require;

/** Remove diacritics (á→a, ñ→n) so the [[ note picker matches accent-insensitively
 *  (Obsidian's prepareFuzzySearch is accent-sensitive by default). */
export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");
}

/** Fresh UUID for a Claude Code conversation (--session-id / --resume). */
export function newConversationId(): string {
  return crypto.randomUUID();
}

/** Parse "HH:MM" → minutes since midnight, or null if malformed. */
export function parseHM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  const h = +m[1], mn = +m[2];
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

export type ScheduleRange = { start: string; end: string; days: number[] };

/** True when `now` falls inside any forbidden window. Handles same-day ranges
 *  (S<E) and overnight ranges (S>E: the post-midnight portion belongs to the
 *  START day, so the t<E slice checks YESTERDAY's day membership).
 *  Fail-safe: no ranges / no days / malformed times → false. */
export function timeBlockedAt(ranges: ScheduleRange[], now: Date): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const prevDay = (day + 6) % 7;
  for (const r of ranges) {
    const s = parseHM(r.start);
    const en = parseHM(r.end);
    if (s == null || en == null || s === en) continue;
    const days = r.days || [];
    if (s < en) {
      if (t >= s && t < en && days.includes(day)) return true;
    } else {
      // overnight: [s..24h) on the start day, [0..en) on the next day
      if (t >= s && days.includes(day)) return true;
      if (t < en && days.includes(prevDay)) return true;
    }
  }
  return false;
}
