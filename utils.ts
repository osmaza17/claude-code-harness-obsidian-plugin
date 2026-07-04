// Small pure/module-level helpers with no plugin state.

// Electron exposes Node's require on the window in the renderer. We use it to
// reach child_process without esbuild trying to bundle it.
export const nodeRequire: NodeRequire = (window as any).require;

/** Remove diacritics (á→a, ñ→n) so the [[ note picker matches accent-insensitively
 *  (Obsidian's prepareFuzzySearch is accent-sensitive by default). */
export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");
}

// Fresh UUID for a Claude Code conversation (--session-id / --resume). Prefers the
// Web Crypto global (present in Electron's renderer); falls back to Node's crypto.
export function newConversationId(): string {
  try {
    if (typeof crypto !== "undefined" && (crypto as any).randomUUID)
      return (crypto as any).randomUUID();
  } catch {
    /* fall through */
  }
  try {
    return nodeRequire("crypto").randomUUID();
  } catch {
    /* last-resort RFC4122-ish */
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
