// Small pure/module-level helpers with no plugin state.

// Electron exposes Node's require on the window in the renderer. We use it to
// reach child_process without esbuild trying to bundle it.
export const nodeRequire: NodeRequire = (window as any).require;

/** Remove diacritics (á→a, ñ→n) so the [[ note picker matches accent-insensitively
 *  (Obsidian's prepareFuzzySearch is accent-sensitive by default). */
export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");
}

/** Fresh UUID for a Claude Code conversation (--session-id / --resume). */
export function newConversationId(): string {
  return crypto.randomUUID();
}
