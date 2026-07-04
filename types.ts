// Shared type declarations for the plugin. Types only — no runtime code.

// Snapshot of a tab needed to reopen it later (Ctrl+Shift+Y) and recover its
// conversation via `claude --resume <sessionId>`. Persisted in settings so the
// reopen stack survives an Obsidian restart.
export type ClosedSessionInfo = {
  sessionId: string;
  skill: string;
  model: string;
  args: string;
  title: string;
  cols: number;
  rows: number;
  // When this tab was closed / last snapshotted (epoch ms). Optional so old
  // persisted entries (before this field existed) still load. Used by the
  // history menu to show a relative "closed 3h ago" subtitle.
  closedAt?: number;
  // Chrome-style pinned tab: rendered compact (dot only) and ALWAYS persisted /
  // restored across Obsidian restarts until the user closes it manually.
  pinned?: boolean;
  // The tab had no conversation yet when snapshotted (only possible for pinned
  // tabs — unpinned blank tabs aren't persisted). Restored with --session-id
  // instead of --resume, since there is no .jsonl to resume.
  blank?: boolean;
};

export interface HarnessSettings {
  // Command run inside the PTY when the session starts.
  command: string;
  // Path to a real node.exe. node-pty needs a true Node runtime (Obsidian's
  // binary ignores ELECTRON_RUN_AS_NODE), so we fork the system Node. Empty =
  // auto-detect.
  nodePath: string;
  // Path to a python.exe used to launch the bundled Token Dashboard. Empty =
  // auto-detect (settings -> known locations -> `where python` / `where py`).
  pythonPath: string;
  // Last fitted grid size. We spawn claude at this size so the first fit when
  // the panel opens doesn't change it (a resize makes claude repaint and stack
  // its banner). Persisted across sessions. Shared by all instances.
  cols: number;
  rows: number;
  // Terminal font size (px), adjustable with Ctrl +/-/0. Shared by all instances.
  fontSize: number;
  // Extra arguments appended to the claude command (e.g.
  // --append-system-prompt "Be concise" --model opus). Default for new sessions.
  args: string;
  // Active skill: the folder name (e.g. "second-brain-assistant") inside Claude
  // Code's skills folder (~/.claude/skills). It is invoked as /<name> when the
  // session starts. Default for new sessions; selectable per-session. Empty = none.
  skill: string;
  // Slash commands (one per line) run at session start, BEFORE the skill.
  // E.g. /remote-control.
  startupCommands: string;
  // Last model picked from the header menu (default for new sessions; the actual
  // model is owned by Claude per-session via /model).
  model: string;
  // Fire an Obsidian notice when the terminal rings the bell (\x07) — Claude
  // tends to ring it when a long task finishes / needs attention.
  notifyOnBell: boolean;
  // Turn coloured note references in Claude's output (and [[wikilinks]]) into
  // clickable links that open the matching .md note in the vault.
  linkifyNotes: boolean;
  // Typing [[ in the terminal opens Obsidian's native note suggester anchored at
  // the cursor (same candidates + fuzzy ranking as [[ in a note); picking one
  // replaces [[query with an @<path> reference (Claude Code's file-ref syntax).
  wikilinkPicker: boolean;
  // Remote control: which browser opens the session URL per Claude account. The
  // URL only works in the browser where that same account is logged in, so the
  // active account (read from ~/.claude.json) picks the browser. browser is one
  // of "chrome" | "firefox" | "edge" | "custom"; path is the .exe for "custom".
  browserMap: { email: string; browser: string; path: string }[];
  // Browser used when the active account isn't mapped (or can't be read).
  defaultBrowser: string;
  // Auto-switch to another saved account based on the 5h usage % (scraped from
  // the status line). Off by default. Two modes:
  //  - "threshold": switch when usage >= autoSwitchThreshold.
  //  - "rotate":   switch every time usage rises autoSwitchDelta points since the
  //                account became active, rotating to spread spend across accounts.
  autoSwitch: boolean;
  autoSwitchMode: string; // "threshold" | "rotate"
  autoSwitchThreshold: number;
  autoSwitchDelta: number;
  // Advanced: regex (source) used to scrape the 5h usage % from the status line.
  // Must have a capture group with the number. Empty = built-in default.
  autoSwitchUsageRegex: string;
  // Saved-account emails (lowercased) BLOCKED as auto-switch destinations — e.g.
  // accounts that belong to friends, so the plugin never spends their tokens on
  // its own. Manual switching from the menu is always allowed regardless.
  autoSwitchExcluded: string[];
  // Forbidden time windows per account. While "now" is inside one of a saved
  // account's ranges, that account is DISCARDED as an auto-switch destination
  // (shown red in the 👤 menu, but manual switching is still allowed), and if it
  // is the ACTIVE account the plugin jumps away from it (or stops Claude when
  // there is nowhere to go). days = JS weekday numbers (0=Sun … 6=Sat); start/end
  // = "HH:MM" (24h); start>end means the range crosses midnight. A range with no
  // days never blocks.
  accountSchedules: {
    email: string;
    ranges: { start: string; end: string; days: number[] }[];
  }[];
  // Read the real 5h/7d usage % from the Anthropic API (rate-limit headers)
  // instead of only scraping the status bar. Makes tiny per-account calls.
  usageProbe: boolean;
  usageProbeModel: string; // empty = USAGE_PROBE_MODEL
  // Header button visibility (Settings and Restart are always shown).
  btnSendNote: boolean;
  btnAccount: boolean;
  btnModel: boolean;
  btnSkill: boolean;
  btnSkillsFolder: boolean;
  btnRemote: boolean;
  btnAutoSwitch: boolean;
  btnTokenDashboard: boolean;
  btnHistory: boolean;
  btnReload: boolean;
  btnZoom: boolean;
  // Chrome-style "reopen closed tab" (Ctrl+Shift+Y), persisted across Obsidian
  // restarts. closedSessions = LIFO stack of reopenable tabs (closed with × or
  // folded in from the previous run's open tabs). openSessions = live snapshot of
  // the CURRENTLY open tabs; on the next launch it is folded into closedSessions
  // so tabs that were still open when Obsidian quit are reopenable too. Each entry
  // carries the deterministic sessionId, so reopening recovers the conversation
  // via `claude --resume <sessionId>` (the .jsonl survives on disk).
  closedSessions: ClosedSessionInfo[];
  openSessions: ClosedSessionInfo[];
}

// Per-account usage snapshot from a probe (or an error state). pct values are
// 0..100 (the headers give a 0..1 fraction; we ×100). reset5h is epoch seconds.
export interface AccountUsage {
  pct5h: number | null;
  reset5h: number | null;
  pct7d: number | null;
  reset7d: number | null;
  status: string | null;
  error: "auth" | "rate" | "net" | null;
  checkedAt: number;
}
