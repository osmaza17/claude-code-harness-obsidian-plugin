import {
  App,
  FileSystemAdapter,
  ItemView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  prepareFuzzySearch,
  setIcon,
  sortSearchResults,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { Terminal, ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import * as path from "path";

// Electron exposes Node's require on the window in the renderer. We use it to
// reach child_process without esbuild trying to bundle it.
const nodeRequire: NodeRequire = (window as any).require;

/** Remove diacritics (á→a, ñ→n) so the [[ note picker matches accent-insensitively
 *  (Obsidian's prepareFuzzySearch is accent-sensitive by default). */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").normalize("NFC");
}

export const VIEW_TYPE = "claude-code-harness-view";

interface HarnessSettings {
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
  btnZoom: boolean;
}

const DEFAULT_SETTINGS: HarnessSettings = {
  command: "claude",
  nodePath: "",
  pythonPath: "",
  cols: 100,
  rows: 30,
  fontSize: 14,
  args: "",
  skill: "second-brain-assistant",
  startupCommands: "",
  model: "opus",
  notifyOnBell: true,
  linkifyNotes: true,
  wikilinkPicker: true,
  browserMap: [],
  defaultBrowser: "chrome",
  autoSwitch: false,
  autoSwitchMode: "threshold",
  autoSwitchThreshold: 90,
  autoSwitchDelta: 10,
  autoSwitchUsageRegex: "",
  autoSwitchExcluded: [],
  usageProbe: true,
  usageProbeModel: "",
  btnSendNote: true,
  btnAccount: true,
  btnModel: true,
  btnSkill: true,
  btnSkillsFolder: true,
  btnRemote: true,
  btnAutoSwitch: true,
  btnTokenDashboard: true,
  btnZoom: true,
};

const MIN_FONT = 8;
const MAX_FONT = 40;

// Default pattern to scrape the 5h usage % from Claude's status line
// ("5h:[▓▓░] 23% (3 31m)"). Overridable via settings.autoSwitchUsageRegex.
const DEFAULT_USAGE_RE = "5h:[^\\n]{0,40}?(\\d{1,3})\\s*%";
// Hard ceiling: the active account must never go past this 5h usage % while there
// is somewhere with room to go. At ≥90% the plugin always tries to switch to the
// least-used eligible account that is still BELOW 90% (keeping a 10% margin),
// OVERRIDING the configured mode/threshold. The single exception is when every
// other account is already ≥90% (or none is eligible): then it stays on the
// current account and runs it to the limit, since switching would buy no margin.
const SWITCH_CEILING_PCT = 90;
// Weekly (7d) ceiling for the DESTINATION of an auto-switch: never jump TO an
// account whose 7d usage is already ≥ this %, so we don't land on a cuenta that
// is about to hit its weekly limit mid-response. Applies to candidate selection
// only (it filters destinations); it does not force the active account to move.
const WEEKLY_CEILING_PCT = 95;
// Best-effort patterns (the exact text Claude prints may change — tune if needed).
// LIMIT_RE: explicit "limit reached" message → fallback trigger to switch.
const LIMIT_RE =
  /(5-?hour|usage|rate).{0,20}limit (reached|exceeded)|limit reached|resets? at/i;
// AUTH_FAIL_RE: an auth problem after a swap (e.g. a saved token is dead).
const AUTH_FAIL_RE =
  /please (run )?\/login|invalid (oauth )?(token|credentials)|token (has )?expired|authentication (failed|error)|unauthorized|\b401\b/i;
// Generic email matcher (filtered against known accounts before use).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// --- Live usage probe (authoritative %, read from Anthropic's rate-limit
// response headers). Verified working with the OAuth token Claude Code stores.
// A minimal /v1/messages call (max_tokens:1) returns the 5h/7d utilisation in
// response headers; we read each account's token to probe it WITHOUT switching.
// Best-effort: the beta header value and model id may change over time.
const USAGE_API_URL = "https://api.anthropic.com/v1/messages";
const USAGE_PROBE_MODEL = "claude-haiku-4-5-20251001"; // cheapest; full id required
const OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";
// OAuth refresh-token grant (the same flow Claude Code uses internally to keep
// accounts alive). Endpoint + client_id were verified by extracting the strings
// from the Claude Code binary; both may change with future CLI versions.
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Only refresh a token when it's expired or within this window of expiring. The
// token endpoint rate-limits hard (observed 429), and refreshing a still-valid
// token would rotate the refresh token needlessly, so we keep each account's
// refresh rate near claude's own (~once per token lifetime) while still checking
// every account on each keep-alive tick.
const REFRESH_SKEW_MS = 30 * 60 * 1000;
// Response header names carrying the unified rate-limit utilisation (0..1).
const H_5H_UTIL = "anthropic-ratelimit-unified-5h-utilization";
const H_5H_RESET = "anthropic-ratelimit-unified-5h-reset";
const H_7D_UTIL = "anthropic-ratelimit-unified-7d-utilization";
// The 7d reset epoch. Expected name by symmetry with the 5h header, but not
// verified live (unlike H_5H_RESET); probeUsage also scans for any "7d…reset"
// header as a fallback so a renamed/variant header still works.
const H_7D_RESET = "anthropic-ratelimit-unified-7d-reset";
const H_5H_STATUS = "anthropic-ratelimit-unified-5h-status";
const USAGE_FRESH_MS = 6 * 60 * 1000; // a reading older than this is "stale"

// Per-account usage snapshot from a probe (or an error state). pct values are
// 0..100 (the headers give a 0..1 fraction; we ×100). reset5h is epoch seconds.
interface AccountUsage {
  pct5h: number | null;
  reset5h: number | null;
  pct7d: number | null;
  reset7d: number | null;
  status: string | null;
  error: "auth" | "rate" | "net" | null;
  checkedAt: number;
}

// Models offered in the header menu. `id` is the /model argument.
const MODELS: { id: string; label: string }[] = [
  { id: "haiku", label: "Haiku 4.5" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.8" },
];

// Known browsers for the remote-control "browser per account" mapping. `exes`
// are the usual install paths (PROGRAMFILES placeholders filled at runtime);
// `alias` is what Windows `start` resolves via its App Paths registry entry;
// `proc` is the process name (no .exe) used to focus + fullscreen the window.
const BROWSERS: Record<
  string,
  { label: string; exes: string[]; alias: string; proc: string }
> = {
  chrome: {
    label: "Chrome",
    exes: [
      "%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe",
      "%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    ],
    alias: "chrome",
    proc: "chrome",
  },
  firefox: {
    label: "Firefox",
    exes: [
      "%PROGRAMFILES%\\Mozilla Firefox\\firefox.exe",
      "%PROGRAMFILES(X86)%\\Mozilla Firefox\\firefox.exe",
    ],
    alias: "firefox",
    proc: "firefox",
  },
  edge: {
    label: "Edge",
    exes: [
      "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    alias: "msedge",
    proc: "msedge",
  },
  brave: {
    label: "Brave",
    exes: [
      "%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%PROGRAMFILES(X86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ],
    alias: "brave",
    proc: "brave",
  },
  // Opera and Opera GX both ship an opera.exe; the folder is what distinguishes
  // them, so the per-user install path is the authoritative selector.
  opera: {
    label: "Opera",
    exes: [
      "%LOCALAPPDATA%\\Programs\\Opera\\opera.exe",
      "%PROGRAMFILES%\\Opera\\opera.exe",
    ],
    alias: "opera",
    proc: "opera",
  },
  operagx: {
    label: "Opera GX",
    exes: [
      "%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe",
      "%PROGRAMFILES%\\Opera GX\\opera.exe",
    ],
    alias: "opera",
    proc: "opera",
  },
  zen: {
    label: "Zen",
    exes: [
      "%PROGRAMFILES%\\Zen Browser\\zen.exe",
      "%LOCALAPPDATA%\\Programs\\Zen Browser\\zen.exe",
      "%LOCALAPPDATA%\\zen\\zen.exe",
    ],
    alias: "zen",
    proc: "zen",
  },
  // Helium (by imput) is Chromium-based: its launcher keeps the chrome.exe name,
  // living in Application\ (the versioned subfolder only holds helper exes). The
  // running process is therefore chrome.exe, so proc collides with Chrome's.
  helium: {
    label: "Helium",
    exes: [
      "%LOCALAPPDATA%\\imput\\Helium\\Application\\chrome.exe",
      "%PROGRAMFILES%\\imput\\Helium\\Application\\chrome.exe",
    ],
    alias: "helium",
    proc: "chrome",
  },
  vivaldi: {
    label: "Vivaldi",
    exes: [
      "%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe",
      "%PROGRAMFILES%\\Vivaldi\\Application\\vivaldi.exe",
    ],
    alias: "vivaldi",
    proc: "vivaldi",
  },
  waterfox: {
    label: "Waterfox",
    exes: [
      "%PROGRAMFILES%\\Waterfox\\waterfox.exe",
      "%PROGRAMFILES(X86)%\\Waterfox\\waterfox.exe",
    ],
    alias: "waterfox",
    proc: "waterfox",
  },
  floorp: {
    label: "Floorp",
    exes: [
      "%PROGRAMFILES%\\Ablaze Floorp\\floorp.exe",
      "%PROGRAMFILES%\\Floorp\\floorp.exe",
    ],
    alias: "floorp",
    proc: "floorp",
  },
  // Mullvad Browser is Tor-Browser-based (Firefox/Gecko). Per-user install puts the
  // launcher in %LOCALAPPDATA%\Mullvad\MullvadBrowser\Release\mullvadbrowser.exe.
  mullvad: {
    label: "Mullvad Browser",
    exes: [
      "%LOCALAPPDATA%\\Mullvad\\MullvadBrowser\\Release\\mullvadbrowser.exe",
      "%PROGRAMFILES%\\Mullvad Browser\\mullvadbrowser.exe",
    ],
    alias: "mullvadbrowser",
    proc: "mullvadbrowser",
  },
};

// 16 ANSI colours for dark vs light surfaces (from the reference harness).
const ANSI_DARK = {
  black: "#241B2C", red: "#FF6B6B", green: "#6BCF7F", yellow: "#FFD93D",
  blue: "#4ECDC4", magenta: "#B197FC", cyan: "#4ECDC4", white: "#F3ECF7",
  brightBlack: "#857693", brightRed: "#FFB4B4", brightGreen: "#B4E5BD",
  brightYellow: "#FFEC99", brightBlue: "#A8E6E0", brightMagenta: "#D6C5FF",
  brightCyan: "#A8E6E0", brightWhite: "#FFFDF5",
};
const ANSI_LIGHT = {
  black: "#1A1320", red: "#D1453B", green: "#20904B", yellow: "#9C6B00",
  blue: "#2B6CB0", magenta: "#8A5CF0", cyan: "#1F9C94", white: "#3A2F44",
  brightBlack: "#6B5878", brightRed: "#E0584E", brightGreen: "#2E9E54",
  brightYellow: "#B8860B", brightBlue: "#3B7DC4", brightMagenta: "#9B72F2",
  brightCyan: "#2BA89F", brightWhite: "#1A1320",
};

// Monotonic id source for sessions (used for tab titles + identity).
let SESSION_SEQ = 0;

/**
 * One Claude Code instance: its own xterm Terminal, DOM host and forked pty-host
 * process (running `claude`). Several Sessions live on the plugin at once so the
 * user can run parallel workflows over the vault; only the active one is mounted
 * in the panel at any time, the rest keep running and buffering output in xterm.
 *
 * Per-session config (skill / model / args) lets each tab be a different
 * workflow. Account, usage and auto-switch are GLOBAL (shared credentials), so
 * they live on the plugin — the session just feeds its output to them.
 */
class Session {
  plugin: ClaudeCodeHarnessPlugin;
  id: number;
  title: string;
  // Per-session config (defaults copied from settings at creation).
  skill: string;
  model: string;
  args: string;

  term: Terminal | null = null;
  fit: FitAddon | null = null;
  host: HTMLElement | null = null; // element xterm renders into
  child: any = null; // forked pty-host process
  webgl: any = null; // WebglAddon, kept so it can be disposed on context loss
  opened = false; // whether term.open() has been called
  exited = false; // claude (the inner pty process) has exited — stop resizing
  // Last grid size sent to the pty. We only resize when it ACTUALLY changes:
  // every resize makes the Claude TUI repaint its whole screen and pushes the
  // previous frame into scrollback, so spurious resizes stack the boot banner.
  lastCols = 0;
  lastRows = 0;
  private resizeTimer: number | null = null;
  private rafFit: number | null = null; // pending per-frame display fit during a drag
  private initialSent = false; // whether the startup steps were inserted this session

  // Tab auto-title. Precedence: manual(3) > osc(2) > prompt(1) > default(0). A
  // higher-ranked source replaces a lower one; OSC also keeps updating itself
  // live as Claude changes the terminal title to reflect the current task.
  titleRank = 0;
  private firstPromptBuf = ""; // accumulates the first line you type (fallback)
  private firstPromptDone = false; // stop after the first committed prompt

  // Tab heartbeat: is Claude actively working in this session? Inferred from PTY
  // activity — Claude streams tokens / animates its spinner continuously while
  // thinking or responding, then goes silent when it hands control back. `busy`
  // drives the tab dot; the timer flips it back to idle after a quiet gap.
  busy = false;
  private busyTimer: number | null = null;
  private lastKeyAt = 0; // when the user last typed (to ignore keystroke echo)

  // Remote control toggle (/remote-control). remoteOn drives the button's green
  // state; while awaiting the menu we scrape the session URL to the clipboard.
  remoteOn = false;
  private awaitRemoteActive = false;
  private remoteActiveBuf = "";
  private remoteActiveDeadline = 0;
  // The menu (with the URL) only renders once the session is actually connected,
  // which can take longer than one early attempt. So we RETRY: reopen the menu
  // every few seconds until the URL shows up (bounded), instead of a single shot.
  private remoteMenuLoopActive = false; // a retry chain is running
  private remoteMenuAttempts = 0;
  private remoteUrlCaptured = false; // stop retrying once we have the URL
  private awaitRemoteUrl = false;
  private remoteUrlBuf = "";
  private remoteUrlDeadline = 0;

  // After a /model switch, Claude may show a "Switch model?" confirmation. We
  // watch the stream and auto-confirm (option 1 is pre-selected).
  private awaitModelConfirm = false;
  private modelConfirmBuf = "";
  private modelConfirmDeadline = 0;

  // Auto-switch: rolling buffer of recent output to scrape the 5h usage %. The
  // DECISION state (cooldown, baseline, verify) is global, on the plugin.
  autoSwitchBuf = "";

  // [[ note suggester (Obsidian-style). When you type [[ in the terminal we open
  // a floating picker anchored at the cursor and capture the query you type;
  // picking a note replaces "[[query" with an "@<path> " reference. The typed
  // text (the two brackets + the query) IS forwarded to Claude so it echoes
  // inline like Obsidian; on accept we erase it with backspaces (2 + query.length)
  // and send the @path. wlBracketRun counts consecutive "[" to detect "[[".
  private wlActive = false;
  private wlQuery = "";
  private wlBracketRun = 0;
  private wlPopup: HTMLElement | null = null;
  private wlCleanup: (() => void) | null = null;
  private wlItems: { path: string; basename: string }[] = [];
  private wlSel = 0;
  private wlSearchSeq = 0; // discard stale async OmniSearch responses

  constructor(
    plugin: ClaudeCodeHarnessPlugin,
    opts?: { skill?: string; model?: string; args?: string; title?: string }
  ) {
    this.plugin = plugin;
    this.id = ++SESSION_SEQ;
    const s = plugin.settings;
    this.skill = opts?.skill !== undefined ? opts.skill : s.skill;
    this.model = opts?.model !== undefined ? opts.model : s.model;
    this.args = opts?.args !== undefined ? opts.args : s.args;
    this.title = opts?.title || this.skill || "Claude";
    this.create();
  }

  /** Create the terminal and start the pty host. */
  private create() {
    // Terminal config replicated verbatim from the reference harness
    // (terminalPool.ts) so the rendering is identical.
    this.term = new Terminal({
      theme: this.plugin.termTheme(),
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: this.plugin.settings.fontSize || 14,
      lineHeight: 1.0,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
    });
    // Unicode 11 widths: Claude Code positions text with modern emoji widths
    // (emoji = 2 cells). Without this, glyphs overflow and merge.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.host = document.createElement("div");
    this.host.addClass("cch-term");

    // Forward keystrokes to the pty host (and sniff the first line for a title).
    this.term.onData((d: string) => {
      this.lastKeyAt = Date.now();
      this.captureFirstPrompt(d);
      // The [[ note suggester intercepts typed text: it forwards what should be
      // echoed (the brackets + query) itself and returns true to mean "handled,
      // don't forward again". Navigation/accept/cancel keys are caught earlier in
      // the key handler and never reach onData.
      if (this.feedWikilink(d, false)) return;
      this.send({ t: "input", d });
    });

    // Claude updates the terminal title (OSC) to describe the current task; use
    // it as the live tab name. This is the primary auto-title source.
    this.term.onTitleChange((t: string) => this.setTitleFrom(t, "osc"));

    // Claude rings the bell (\x07) when a long task finishes / needs attention.
    this.term.onBell(() => {
      if (this.plugin.settings.notifyOnBell) {
        new Notice("🔔 Claude Code needs your attention");
      }
    });

    // Turn coloured note references / [[wikilinks]] in the output into clickable
    // links that open the matching .md note (computed by the plugin on hover).
    this.term.registerLinkProvider({
      provideLinks: (y, callback) =>
        callback(this.plugin.computeNoteLinks(this.term as Terminal, y)),
    });

    this.setupClipboard();
    this.startHost();
  }

  /** Set the tab title from an automatic source, respecting precedence
   *  (manual > osc > prompt > default). Cleans control chars and truncates. */
  setTitleFrom(raw: string, source: "prompt" | "osc" | "manual") {
    const rank = source === "manual" ? 3 : source === "osc" ? 2 : 1;
    if (rank < this.titleRank) return; // a stronger source already owns the title
    let clean = raw
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (source === "osc") {
      // Claude prepends an animated status glyph (✳ ✶ ✻ …) to its terminal
      // title; the heartbeat dot already conveys that, so strip leading symbols.
      clean = clean.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      // Claude's terminal title is usually just a generic "Claude Code" (or the
      // cwd), which tells the tabs apart from nothing. Ignore those so the
      // first-prompt fallback can name the tab after the actual conversation;
      // only a genuinely descriptive OSC title is allowed to take over.
      const low = clean.toLowerCase();
      const vault = this.plugin.app.vault.getName().toLowerCase();
      if (!clean || low === "claude" || low === "claude code" || low === vault) {
        return;
      }
    }
    clean = clean.slice(0, 40);
    if (!clean) return;
    if (clean === this.title && rank === this.titleRank) return;
    this.title = clean;
    this.titleRank = rank;
    this.plugin.refreshTabTitles();
  }

  /** Fallback title: gather the first line you type and commit it on Enter,
   *  unless a stronger source (OSC title / manual rename) already took over. */
  private captureFirstPrompt(d: string) {
    if (this.firstPromptDone || this.titleRank >= 2) return;
    if (d === "\r" || d === "\n") {
      const t = this.firstPromptBuf.trim();
      if (t) {
        this.setTitleFrom(t, "prompt");
        this.firstPromptDone = true;
      }
      this.firstPromptBuf = "";
      return;
    }
    if (d === "\x7f" || d === "\b") {
      this.firstPromptBuf = this.firstPromptBuf.slice(0, -1);
      return;
    }
    if (d.charCodeAt(0) < 0x20 || d.startsWith("\x1b")) return; // ctrl / escapes
    if (this.firstPromptBuf.length < 80) this.firstPromptBuf += d;
  }

  /** Tab heartbeat. Each chunk of PTY output (other than keystroke echo) marks
   *  the session busy and re-arms a quiet-gap timer; when the gap elapses with no
   *  output, Claude has handed control back and the session goes idle. Output
   *  within ~600ms of a keystroke is treated as echo (so the dot doesn't pulse
   *  just because YOU are typing). */
  private markActivity() {
    if (this.exited) return;
    if (Date.now() - this.lastKeyAt < 600) return; // keystroke echo, not Claude
    this.setBusy(true);
    if (this.busyTimer != null) window.clearTimeout(this.busyTimer);
    this.busyTimer = window.setTimeout(() => {
      this.busyTimer = null;
      this.setBusy(false);
    }, 1200);
  }

  private setBusy(b: boolean) {
    if (this.busy === b) return;
    this.busy = b;
    this.plugin.refreshTabStatus();
  }

  /** Re-apply the Obsidian theme to this terminal (called on css-change). */
  applyTheme() {
    if (!this.term) return;
    this.term.options.theme = this.plugin.termTheme();
    try {
      this.term.refresh(0, Math.max(0, this.term.rows - 1));
    } catch {
      /* not open yet */
    }
  }

  /** Send a message to the pty host, swallowing errors if the IPC channel has
   *  already closed (the 'exit' handler nulls this.child asynchronously). */
  private send(msg: any) {
    try {
      this.child?.send(msg);
    } catch {
      /* channel closed */
    }
  }

  /** @-mention one or more vault paths in this session's input. */
  mention(paths: string[]) {
    const uniq = [...new Set(paths)].filter(Boolean);
    if (!uniq.length) return;
    this.send({ t: "input", d: uniq.map((p) => "@" + p + " ").join("") });
    this.term?.focus();
  }

  // --- [[ note suggester ---------------------------------------------------
  //
  // Mirrors Obsidian's wikilink autocomplete inside the terminal: typing "[[" opens
  // a floating picker anchored at the cursor with the SAME suggestions as [[ in a
  // note (Obsidian's own getLinkSuggestions + prepareFuzzySearch — see queryNotes);
  // picking a note replaces "[[query" with an "@<path> " reference (Claude's syntax).
  //
  // The typed text (the two "[" and the query) IS forwarded to Claude so it echoes
  // inline like Obsidian. On accept we erase exactly what we forwarded with
  // backspaces (2 + query.length) and send the @path. Because every forwarded char
  // passes through here, that count stays exact even with mid-query backspaces.
  // LIMITATION: a query containing emoji / multi-cell graphemes could desync the
  // per-char backspace count vs Claude's per-grapheme delete; note names rarely
  // contain those, so it's acceptable.

  /** Ingest one typed char for the [[ suggester. Returns true when consumed (the
   *  onData caller must then NOT forward it again). `alreadySent` = the caller
   *  already wrote the char to the pty (the AltGr key-handler path), so we only
   *  update state here and never re-forward. */
  private feedWikilink(d: string, alreadySent: boolean): boolean {
    if (!this.plugin.settings.wikilinkPicker) return false;
    if (!this.wlActive) {
      // Detect "[[": two consecutive "[" (the brackets are still forwarded so
      // Claude echoes "[[" inline).
      if (d === "[") {
        this.wlBracketRun++;
        if (this.wlBracketRun >= 2) {
          this.wlBracketRun = 0;
          this.openWikilinkPicker();
        }
        return false;
      }
      this.wlBracketRun = 0;
      return false;
    }
    // Picker open. Backspace shrinks the query (and, once empty, the next
    // backspace deletes the 2nd "[" and exits the picker).
    if (d === "\x7f" || d === "\b") {
      if (this.wlQuery.length > 0) {
        this.wlQuery = this.wlQuery.slice(0, -1);
        if (!alreadySent) this.send({ t: "input", d });
        void this.searchWikilink();
        return true;
      }
      this.closeWikilinkPicker();
      if (!alreadySent) this.send({ t: "input", d });
      return true;
    }
    // A single printable char extends the query (letters, digits, space, accents).
    if (d.length === 1 && d.charCodeAt(0) >= 0x20) {
      this.wlQuery += d;
      if (!alreadySent) this.send({ t: "input", d });
      void this.searchWikilink();
      return true;
    }
    // Anything else while open (an escape sequence that slipped through, a paste
    // with newlines…) cancels the picker and flows normally.
    this.closeWikilinkPicker();
    return false;
  }

  private openWikilinkPicker() {
    this.closeWikilinkPicker(); // safety: never two popups
    this.wlActive = true;
    this.wlQuery = "";
    this.wlItems = [];
    this.wlSel = 0;
    const pop = document.createElement("div");
    pop.className = "menu cch-wikilink-menu";
    document.body.appendChild(pop);
    this.wlPopup = pop;
    // Dismiss on click outside the popup (clicking the terminal cancels too).
    const onDown = (e: MouseEvent) => {
      if (this.wlPopup && !this.wlPopup.contains(e.target as Node))
        this.closeWikilinkPicker();
    };
    setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
    this.wlCleanup = () =>
      document.removeEventListener("mousedown", onDown, true);
    void this.searchWikilink();
  }

  closeWikilinkPicker() {
    this.wlActive = false;
    this.wlQuery = "";
    this.wlBracketRun = 0;
    this.wlSearchSeq++; // invalidate any in-flight search
    if (this.wlCleanup) {
      this.wlCleanup();
      this.wlCleanup = null;
    }
    if (this.wlPopup) {
      this.wlPopup.remove();
      this.wlPopup = null;
    }
    this.wlItems = [];
  }

  /** Run the current query and re-render. Tagged with a sequence number so a slow
   *  OmniSearch response can't clobber a newer query (or a closed picker). */
  private async searchWikilink() {
    const seq = ++this.wlSearchSeq;
    const items = await this.queryNotes(this.wlQuery);
    if (seq !== this.wlSearchSeq || !this.wlActive) return; // stale or closed
    this.wlItems = items.slice(0, 8);
    this.wlSel = 0;
    this.renderWikilinkResults();
  }

  /** Suggestions = OmniSearch (full-text, same results as its own search window,
   *  and diacritic-insensitive on its own). Falls back to Obsidian's native [[
   *  suggester (`nativeNotes`) when OmniSearch isn't available, and for the empty
   *  query (OmniSearch has nothing to search before you type). `path` (for the @
   *  reference) is the file's vault-relative path. */
  private async queryNotes(
    q: string
  ): Promise<{ path: string; basename: string }[]> {
    const app = this.plugin.app as any;
    const omni = app.plugins?.plugins?.omnisearch?.api;
    if (q.trim() && omni?.search) {
      try {
        const res = await omni.search(q);
        if (Array.isArray(res)) {
          return res.slice(0, 8).map((r: any) => ({
            path: r.path,
            basename: r.basename ?? (r.path.split("/").pop() || r.path),
          }));
        }
      } catch {
        /* OmniSearch failed/indexing — fall through to the native suggester */
      }
    }
    return this.nativeNotes(q);
  }

  /** Fallback suggester that mirrors Obsidian's native [[ autocomplete: SAME
   *  candidate source (`metadataCache.getLinkSuggestions()` — every linkable file +
   *  its aliases), matched on the FILENAME / alias with the SAME fuzzy matcher
   *  (`prepareFuzzySearch`) + `sortSearchResults`, diacritic-insensitive via
   *  `stripDiacritics`. Used when OmniSearch is unavailable and for the empty query. */
  private nativeNotes(q: string): { path: string; basename: string }[] {
    const app = this.plugin.app as any;
    type Cand = { file: TFile; alias?: string };
    let cands: Cand[];
    const native = app.metadataCache?.getLinkSuggestions?.();
    if (Array.isArray(native)) {
      cands = native
        .filter((s: any) => s.file instanceof TFile)
        .map((s: any) => ({ file: s.file as TFile, alias: s.alias as string | undefined }));
    } else {
      cands = this.plugin.app.vault.getMarkdownFiles().map((f) => ({ file: f }));
    }
    // Empty query: native shows the suggestion list as-is (recent / ordered).
    if (!q.trim()) {
      return cands
        .slice(0, 8)
        .map((c) => ({ path: c.file.path, basename: c.alias || c.file.basename }));
    }
    // Match the filename/alias (what native ranks on), and sort with Obsidian's
    // own sorter so the order matches the editor's [[ popup. Strip diacritics on
    // BOTH the query and the candidate so the match is accent-insensitive (típing
    // "energia" finds "Energía") — Obsidian's prepareFuzzySearch is accent-SENSITIVE
    // by default; we normalise to mirror OmniSearch's diacritic-insensitive search.
    const match = prepareFuzzySearch(stripDiacritics(q));
    const results: {
      match: ReturnType<typeof match>;
      path: string;
      display: string;
    }[] = [];
    for (const c of cands) {
      const display = c.alias || c.file.basename;
      const m = match(stripDiacritics(display));
      if (m) results.push({ match: m, path: c.file.path, display });
    }
    sortSearchResults(results as any);
    return results.slice(0, 8).map((r) => ({ path: r.path, basename: r.display }));
  }

  private renderWikilinkResults() {
    const pop = this.wlPopup;
    if (!pop) return;
    pop.empty();
    if (!this.wlItems.length) {
      pop.createDiv({
        cls: "cch-wikilink-empty",
        text: this.wlQuery.trim() ? "No matches" : "Type to search…",
      });
    } else {
      this.wlItems.forEach((it, i) => {
        const row = pop.createDiv({
          cls: "cch-wikilink-item" + (i === this.wlSel ? " is-selected" : ""),
        });
        row.createDiv({ cls: "cch-wikilink-name", text: it.basename });
        const dir = it.path.replace(/[^/]*$/, "").replace(/\/$/, "");
        if (dir) row.createDiv({ cls: "cch-wikilink-path", text: dir });
        row.addEventListener("mousemove", () => {
          if (this.wlSel !== i) {
            this.wlSel = i;
            this.highlightWikilink();
          }
        });
        // mousedown (not click): preventDefault keeps terminal focus and beats
        // the outside-close listener; the row is inside the popup so it won't close.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.acceptWikilink(i);
        });
      });
    }
    this.positionWikilinkPopup();
  }

  private highlightWikilink() {
    const pop = this.wlPopup;
    if (!pop) return;
    const rows = Array.from(pop.querySelectorAll(".cch-wikilink-item"));
    rows.forEach((r, i) => (r as HTMLElement).toggleClass("is-selected", i === this.wlSel));
  }

  private moveWikilinkSel(delta: number) {
    if (!this.wlItems.length) return;
    const n = this.wlItems.length;
    this.wlSel = (this.wlSel + delta + n) % n;
    this.highlightWikilink();
    const row = this.wlPopup?.querySelectorAll(".cch-wikilink-item")[
      this.wlSel
    ] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }

  /** Replace the typed "[[query" with an "@<path> " reference. */
  private acceptWikilink(i: number) {
    const item = this.wlItems[i];
    const erase = 2 + this.wlQuery.length; // "[[" + the inline-echoed query
    this.closeWikilinkPicker();
    if (!item) return;
    const back = "\x7f".repeat(erase);
    this.send({ t: "input", d: back + "@" + item.path + " " });
    this.term?.focus();
  }

  /** Anchor the popup at the terminal cursor (below it, flipping above if it
   *  would overflow), clamped to the viewport — same idea as openAccountMenu. */
  private positionWikilinkPopup() {
    const pop = this.wlPopup;
    const term = this.term as any;
    if (!pop || !term || !term.element) return;
    const rect = (term.element as HTMLElement).getBoundingClientRect();
    const buf = term.buffer.active;
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    const cw = cell?.width || rect.width / term.cols;
    const ch = cell?.height || rect.height / term.rows;
    const curX = rect.left + buf.cursorX * cw;
    const curYTop = rect.top + buf.cursorY * ch;
    const margin = 8;
    const pr = pop.getBoundingClientRect();
    let left = curX;
    if (left + pr.width > window.innerWidth - margin)
      left = window.innerWidth - pr.width - margin;
    left = Math.max(margin, left);
    let top = curYTop + ch + 2; // below the cursor line
    if (top + pr.height > window.innerHeight - margin) {
      const above = curYTop - pr.height - 2; // flip above
      top = above >= margin ? above : Math.max(margin, window.innerHeight - pr.height - margin);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  /** Wire copy/paste. With the WebGL renderer there is no DOM text, so native
   *  copy can't see the selection — route it through the clipboard manually:
   *    Ctrl+C with a selection -> copy (without one it stays SIGINT)
   *    Ctrl+Shift+C -> copy   ·   Ctrl+Shift+V -> paste
   *    right-click  -> copy the selection, else paste
   *  (Mirrors the reference harness's terminalPool.ts.) */
  private setupClipboard() {
    const term = this.term;
    const host = this.host;
    if (!term || !host) return;

    let clipboard: any = null;
    try {
      clipboard = nodeRequire("electron")?.clipboard;
    } catch {
      /* fall back to navigator.clipboard */
    }
    const writeClip = (text: string) => {
      if (clipboard) clipboard.writeText(text);
      else void navigator.clipboard?.writeText(text).catch(() => {});
    };
    const readClip = async (): Promise<string> => {
      if (clipboard) return clipboard.readText() || "";
      try {
        return (await navigator.clipboard?.readText()) || "";
      } catch {
        return "";
      }
    };
    const copySelection = (): boolean => {
      if (!term.hasSelection()) return false;
      writeClip(term.getSelection());
      return true;
    };
    const pasteText = async () => {
      const t = await readClip();
      if (t) term.paste(t);
    };
    // Smart paste: if the clipboard holds an image, drop it to a temp PNG and
    // paste the file path (Claude Code attaches a pasted image path the same way
    // it does a dragged file); otherwise paste text.
    const pasteSmart = () => {
      const imgPath = this.plugin.saveClipboardImage(clipboard);
      if (imgPath) {
        term.paste(imgPath);
        return;
      }
      void pasteText();
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // [[ note suggester open: own the navigation / accept / cancel keys so they
      // drive the picker instead of going to the pty (text keys still fall through
      // to onData -> feedWikilink, which builds the query).
      if (this.wlActive) {
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          this.moveWikilinkSel(1);
          return false;
        }
        if (ev.key === "ArrowUp") {
          ev.preventDefault();
          this.moveWikilinkSel(-1);
          return false;
        }
        if (ev.key === "Enter" || ev.key === "Tab") {
          ev.preventDefault();
          ev.stopPropagation();
          this.acceptWikilink(this.wlSel);
          return false;
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          this.closeWikilinkPicker();
          return false;
        }
      }
      // Ctrl+Enter / Shift+Enter -> insert a newline (LF) in Claude's input
      // instead of submitting (Enter alone sends CR = submit).
      if (
        ev.key === "Enter" &&
        (ev.ctrlKey || ev.shiftKey) &&
        !ev.altKey &&
        !ev.metaKey
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        this.send({ t: "input", d: "\x0a" });
        return false;
      }
      // AltGr (Ctrl+Alt) on international keyboards types @ # [ ] { } \ € etc.
      // xterm mangles these as control combos, so deliver the literal char.
      if (ev.ctrlKey && ev.altKey && !ev.metaKey && ev.key.length === 1) {
        this.send({ t: "input", d: ev.key });
        // On international keyboards "[" arrives here (AltGr), bypassing onData —
        // so feed it to the [[ detector too (the char is already sent above).
        this.feedWikilink(ev.key, true);
        ev.preventDefault();
        ev.stopPropagation();
        return false;
      }
      if (!(ev.ctrlKey || ev.metaKey)) return true;
      const key = ev.key.toLowerCase();
      // Ctrl +/-/0 -> font zoom (kept out of the pty and out of Obsidian).
      if (key === "=" || key === "+") {
        ev.preventDefault();
        ev.stopPropagation();
        this.plugin.zoomBy(1);
        return false;
      }
      if (key === "-" || key === "_") {
        ev.preventDefault();
        ev.stopPropagation();
        this.plugin.zoomBy(-1);
        return false;
      }
      if (key === "0") {
        ev.preventDefault();
        ev.stopPropagation();
        this.plugin.setFontSize(14);
        return false;
      }
      // Ctrl+R -> toggle remote control (kept out of the pty and out of Obsidian's
      // global hotkeys; stopPropagation prevents an Electron page reload too).
      if (key === "r" && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleRemoteControl();
        return false;
      }
      if (key === "c" && (ev.shiftKey || term.hasSelection())) {
        if (copySelection() && !ev.shiftKey) term.clearSelection();
        ev.preventDefault();
        return false;
      }
      if (key === "v") {
        // Ctrl+Shift+V forces text; plain Ctrl+V pastes image-or-text.
        if (ev.shiftKey) void pasteText();
        else pasteSmart();
        ev.preventDefault();
        return false;
      }
      if (key === "z" && !ev.altKey) {
        // Claude Code's input has no per-character undo (Ctrl+Z / 0x1a is a
        // no-op there). The closest is its line-clear (Ctrl+U) which it can
        // restore with Ctrl+Y. So map Ctrl+Z -> clear the typed line ("undo"),
        // Ctrl+Shift+Z -> restore it ("redo"). Also stop Obsidian's global undo
        // from swallowing the key while the terminal is focused.
        ev.preventDefault();
        ev.stopPropagation();
        this.send({ t: "input", d: ev.shiftKey ? "\x19" : "\x15" });
        return false;
      }
      return true;
    });

    host.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (copySelection()) {
        term.clearSelection();
        return;
      }
      pasteSmart();
    });

    // Ctrl + mouse wheel -> font zoom (instead of scrolling the terminal).
    host.addEventListener(
      "wheel",
      (ev) => {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.plugin.zoomBy(ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );

    // Drag a note/image (from the file explorer or the OS) onto the terminal to
    // @-mention it. dragover must preventDefault to allow the drop.
    host.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    });
    host.addEventListener("drop", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.handleDrop(ev);
    });
  }

  /** Resolve files dropped on this terminal to paths and @-mention them in this
   *  session. Handles Obsidian internal drags, OS files and a text/plain fallback. */
  private async handleDrop(e: DragEvent) {
    const app = this.plugin.app;
    const paths: string[] = [];
    // 1) Obsidian internal drag (file explorer / links).
    const dragged = (app as any).dragManager?.draggable;
    if (dragged) {
      if (dragged.file?.path) paths.push(dragged.file.path);
      if (Array.isArray(dragged.files)) {
        for (const f of dragged.files) if (f?.path) paths.push(f.path);
      }
    }
    // 2) OS files dropped from outside Obsidian.
    const dt = e.dataTransfer;
    if (dt?.files?.length) {
      for (let i = 0; i < dt.files.length; i++) {
        const p = (dt.files[i] as any).path;
        if (p) paths.push(p);
      }
    }
    // 3) Fallback: text/plain may be a [[wikilink]] or a path.
    if (!paths.length && dt) {
      const txt = (dt.getData("text/plain") || "").trim();
      if (txt) {
        const wl = txt.match(/^\[\[([^\]|#]+)/);
        const name = wl ? wl[1].trim() : txt;
        const tf = app.metadataCache.getFirstLinkpathDest(name, "");
        paths.push(tf ? tf.path : txt);
      }
    }
    if (paths.length) this.mention(paths);
  }

  /** Mount this session's terminal host into a container (the panel body). */
  attachInto(parent: HTMLElement) {
    if (!this.host || !this.term) return;
    // `opened` already true => the host was detached and is now coming back
    // (a tab switch), so the terminal needs a scroll-area/renderer resync.
    const reattach = this.opened;
    parent.appendChild(this.host);
    if (!this.opened) {
      this.fit = new FitAddon();
      this.term.loadAddon(this.fit);
      this.term.open(this.host);
      // WebGL renderer (must load AFTER open()) — same as the reference harness.
      // It keeps every glyph in its own fixed cell so box-drawing and the cursor
      // stay aligned. Requires a CONCRETE font (set above), not a CSS var.
      // Falls back to the DOM renderer on GPU context failure.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            /* noop */
          }
          this.webgl = null;
        });
        this.term.loadAddon(webgl);
        this.webgl = webgl;
      } catch (e) {
        console.warn("[claude-code-harness] webgl unavailable, using DOM renderer:", e);
      }
      this.opened = true;
    }
    // The side panel ANIMATES open (width 0 -> full), firing a burst of resize
    // events. We debounce so claude is resized once, after the animation
    // settles, instead of repainting (and stacking its banner) on every frame.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.scheduleFit();
        if (reattach) this.resyncAfterReattach();
        this.term?.focus();
      })
    );
    window.setTimeout(() => this.scheduleFit(), 120);
    window.setTimeout(() => this.scheduleFit(), 400);
    if (reattach) window.setTimeout(() => this.resyncAfterReattach(), 120);
    document.fonts?.ready?.then(() => this.scheduleFit()).catch(() => {
      /* noop */
    });
  }

  /** Remove this session's host from the DOM WITHOUT killing the process (tab
   *  switch / panel close). */
  detachHost() {
    if (this.rafFit != null) {
      cancelAnimationFrame(this.rafFit);
      this.rafFit = null;
    }
    this.closeWikilinkPicker(); // don't leave the [[ popup floating
    this.host?.remove();
  }

  /** Re-sync xterm's scroll area + renderer after the host was detached and
   *  reattached (tab switch). Without this the mouse wheel / scrollbar can stay
   *  frozen — you can't scroll up or down — until the next pty write forces a
   *  render; pressing a key then jumps to the bottom (xterm's scroll-on-input),
   *  which is what made it feel like the only way to "unstick" it.
   *
   *  Why a plain fit()/refresh() isn't enough: on a tab switch the panel size is
   *  unchanged, so fit() is a no-op and never tells xterm to recompute its
   *  viewport's scrollable height. We force that recompute with a rows -1 -> rows
   *  resize round-trip on xterm ONLY (we never send {t:"resize"} to the pty, so
   *  Claude doesn't reprint its banner); the intermediate size never paints
   *  because both resizes run in the same frame. */
  resyncAfterReattach() {
    if (!this.term || !this.host?.isConnected) return;
    try {
      const { cols, rows } = this.term;
      if (cols >= 2 && rows >= 3) {
        this.term.resize(cols, rows - 1);
        this.term.resize(cols, rows);
      }
      this.term.refresh(0, Math.max(0, this.term.rows - 1));
    } catch {
      /* not laid out yet */
    }
  }

  /** Apply a new font size to this terminal and resize the pty (the persistence
   *  + label update is the plugin's job, in setFontSize). */
  applyFontSize(px: number) {
    if (!this.term) return;
    this.term.options.fontSize = px;
    // Match the reference harness exactly: set the font, refit, resize the pty.
    // Do NOT clearTextureAtlas()/refresh() here — xterm's WebGL renderer
    // rebuilds its glyph atlas on a font-size change by itself, and forcing an
    // extra refresh mid-resize is what produced the garbled / duplicated frame
    // on zoom. A single clean resize lets the Claude TUI repaint once.
    if (this.fit && this.host?.isConnected) {
      try {
        this.fit.fit();
        const { cols, rows } = this.term;
        if (
          !this.exited &&
          cols >= 2 &&
          rows >= 2 &&
          (cols !== this.lastCols || rows !== this.lastRows)
        ) {
          this.lastCols = cols;
          this.lastRows = rows;
          this.send({ t: "resize", cols, rows });
          this.plugin.rememberSize(cols, rows);
        }
      } catch {
        /* not laid out yet */
      }
    }
  }

  /** Switch this session's model by running `/model <id>`. A leading Ctrl+U
   *  clears any draft first so the command runs on its own line (restorable with
   *  Ctrl+Y). Also updates the global default so new sessions inherit it. */
  selectModel(id: string, label: string) {
    this.model = id;
    this.plugin.settings.model = id;
    void this.plugin.saveSettings();
    this.plugin.updateModelBtn();
    this.send({ t: "input", d: `\x15/model ${id}\r` });
    // Arm auto-confirm in case Claude asks "Switch model?" (mid-conversation).
    this.awaitModelConfirm = true;
    this.modelConfirmBuf = "";
    this.modelConfirmDeadline = Date.now() + 6000;
    this.term?.focus();
  }

  /** If the "Switch model?" confirmation appears, press Enter on the
   *  pre-selected "Yes" option. One-shot, with a timeout. */
  private maybeConfirmModel(chunk: string) {
    if (!this.awaitModelConfirm) return;
    if (Date.now() > this.modelConfirmDeadline) {
      this.awaitModelConfirm = false;
      return;
    }
    this.modelConfirmBuf = (this.modelConfirmBuf + chunk).slice(-3000);
    const clean = this.modelConfirmBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (/Switch model\?|Yes, switch to/i.test(clean)) {
      this.awaitModelConfirm = false;
      window.setTimeout(() => this.send({ t: "input", d: "\r" }), 150);
    }
  }

  /** Choose this session's skill. Persists as the new default and, if a session
   *  is running, invokes /<name> now (same `\x15/<name>\r` pattern as selectModel). */
  selectSkill(name: string) {
    this.skill = name;
    this.plugin.settings.skill = name;
    void this.plugin.saveSettings();
    this.plugin.updateSkillBtn();
    const label = name || "none";
    if (name && this.child) {
      this.send({ t: "input", d: `\x15/${name}\r` });
      new Notice("Skill loaded: /" + name);
    } else {
      new Notice("Skill set: " + label + (this.child ? "" : " (loads on next session)"));
    }
    this.term?.focus();
  }

  /** Send text to the pty as if pasted, WITHOUT going through xterm's paste()
   *  (which needs the view attached). This is why the startup commands and the
   *  initial prompt fire even when the user never opens the panel. We bracket
   *  the text only when Claude has bracketed-paste mode on — same condition
   *  xterm.paste() uses — so a multi-line prompt is inserted as one block. */
  private pasteToPty(text: string) {
    const bracketed = !!(this.term as any)?.modes?.bracketedPasteMode;
    const d = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    this.send({ t: "input", d });
  }

  /** Two-state remote control toggle (see the reference behaviour). The first
   *  /remote-control connects; running it again while connected opens a menu that
   *  prints the session URL. OFF→ON connects then scrapes + opens the URL;
   *  ON→OFF opens the menu and arrows up to "Disconnect". */
  toggleRemoteControl() {
    if (!this.child) {
      new Notice("No live session");
      return;
    }
    if (!this.remoteOn) {
      this.send({ t: "input", d: "\x15/remote-control\r" });
      this.remoteOn = true;
      this.plugin.updateRemoteBtn();
      new Notice("Remote control connecting…");
      // Reopen the menu to surface + copy the URL. Fast path: as soon as the
      // output shows "/rc active" (maybeAfterRemoteActive). The retry loop below
      // keeps reopening the menu until the URL renders (connection may be slow).
      this.remoteMenuLoopActive = false;
      this.remoteMenuAttempts = 0;
      this.remoteUrlCaptured = false;
      this.awaitRemoteUrl = false;
      this.awaitRemoteActive = true;
      this.remoteActiveBuf = "";
      this.remoteActiveDeadline = Date.now() + 20000;
      window.setTimeout(() => this.fireRemoteMenu(), 1000);
    } else {
      this.send({ t: "input", d: "\x15/remote-control\r" });
      // Menu default is "Continue"; Up x2 lands on "Disconnect this session".
      // Use the cursor-key sequence that matches xterm's DECCKM mode (the TUI
      // usually enables application cursor keys, where Up is ESC O A, not ESC [ A),
      // and send each keypress with a small gap so the TUI registers them.
      const appCursor = !!(this.term as any)?.modes?.applicationCursorKeysMode;
      const up = appCursor ? "\x1bOA" : "\x1b[A";
      window.setTimeout(() => this.send({ t: "input", d: up }), 700);
      window.setTimeout(() => this.send({ t: "input", d: up }), 820);
      window.setTimeout(() => this.send({ t: "input", d: "\r" }), 940);
      this.remoteOn = false;
      this.awaitRemoteActive = false;
      this.awaitRemoteUrl = false;
      this.remoteMenuLoopActive = false;
      this.plugin.updateRemoteBtn();
      new Notice("Remote control off");
    }
    this.term?.focus();
  }

  /** Fast path: when the output shows "/rc active", open the menu immediately. */
  private maybeAfterRemoteActive(chunk: string) {
    if (!this.awaitRemoteActive) return;
    if (Date.now() > this.remoteActiveDeadline) {
      this.awaitRemoteActive = false;
      return;
    }
    this.remoteActiveBuf = (this.remoteActiveBuf + chunk).slice(-4000);
    const clean = this.remoteActiveBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (/\/rc active/i.test(clean)) this.fireRemoteMenu();
  }

  /** Start the menu retry loop (idempotent): kicked off by the fallback timer and
   *  the "/rc active" fast path. Only one loop runs at a time. */
  private fireRemoteMenu() {
    if (!this.remoteOn || !this.child || this.remoteUrlCaptured) return;
    if (this.remoteMenuLoopActive) return; // a retry chain is already running
    this.remoteMenuLoopActive = true;
    this.runRemoteMenuAttempt();
  }

  /** One attempt: reopen the menu (which prints the URL once the session is
   *  actually connected), arm the URL capture, dismiss the menu shortly after to
   *  stay connected, and schedule a retry if the URL hasn't shown up yet. The menu
   *  doesn't render the URL until connected, so a single early attempt can miss it
   *  — hence the retries (this is what fixed needing to press Ctrl+R twice). */
  private runRemoteMenuAttempt() {
    if (!this.remoteOn || !this.child || this.remoteUrlCaptured) {
      this.remoteMenuLoopActive = false;
      return;
    }
    if (this.remoteMenuAttempts >= 6) {
      this.remoteMenuLoopActive = false;
      this.awaitRemoteUrl = false;
      console.log(
        "[cch remote] gave up after retries. Last cleaned buffer:\n" +
          this.remoteUrlBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-1200)
      );
      new Notice(
        "Couldn't read the remote URL automatically. It should be shown in the Claude panel — copy it from there."
      );
      return;
    }
    this.remoteMenuAttempts++;
    this.awaitRemoteActive = false;
    this.send({ t: "input", d: "\x15/remote-control\r" });
    this.awaitRemoteUrl = true;
    this.remoteUrlBuf = "";
    this.remoteUrlDeadline = Date.now() + 6000;
    // Dismiss the menu so the next attempt can reopen it cleanly (and so we stay
    // connected if this attempt already had the URL).
    window.setTimeout(() => {
      if (this.remoteOn && !this.remoteUrlCaptured) this.send({ t: "input", d: "\x1b" });
    }, 900);
    // Retry: if the URL still isn't captured, reopen the menu (connection may have
    // completed by now).
    window.setTimeout(() => {
      if (this.remoteOn && !this.remoteUrlCaptured) this.runRemoteMenuAttempt();
      else this.remoteMenuLoopActive = false;
    }, 1500);
  }

  /** While awaiting the remote-control menu, scrape the session URL from the
   *  terminal output and copy it to the clipboard (once). */
  private maybeCaptureRemoteUrl(chunk: string) {
    if (!this.awaitRemoteUrl || this.remoteUrlCaptured) return;
    if (Date.now() > this.remoteUrlDeadline) {
      // This attempt's window lapsed; the retry loop will reopen the menu.
      this.awaitRemoteUrl = false;
      return;
    }
    this.remoteUrlBuf = (this.remoteUrlBuf + chunk).slice(-8000);
    const clean = this.remoteUrlBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    // Match the /code/<id> link. The id is word-chars only — NOT dots or slashes:
    // the menu prints option labels ("Disconnect this session", "Show QR code")
    // right after the URL with whitespace stripped, so including '.' would glue
    // ".Disconnectthissession…" onto the URL (a broken link). Stopping at '.'
    // yields the clean URL.
    const m = clean.match(/https:\/\/claude\.ai\/code\/[\w-]+/);
    if (m) {
      this.awaitRemoteUrl = false;
      this.remoteUrlCaptured = true; // stop the retry loop
      this.remoteMenuLoopActive = false;
      const url = m[0];
      // Dismiss the menu so we stay connected (Continue is the default).
      window.setTimeout(() => {
        if (this.remoteOn) this.send({ t: "input", d: "\x1b" });
      }, 200);
      try {
        const clip = nodeRequire("electron")?.clipboard;
        if (clip) clip.writeText(url);
        else void navigator.clipboard?.writeText(url).catch(() => {});
      } catch {
        /* clipboard unavailable */
      }
      const label = this.plugin.openInBrowser(url);
      new Notice("Remote session opening in " + label + ":\n" + url);
    }
  }

  /** Once claude is up, run the startup slash commands, then invoke this
   *  session's skill (/<name>) — in order, with small gaps. Runs on a fresh start. */
  private maybeSendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;

    const steps: string[] = [];
    const startup = this.plugin.settings.startupCommands || "";
    for (const line of startup.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      steps.push(line);
    }
    if (this.skill) steps.push("/" + this.skill);
    if (!steps.length) return;

    let i = 0;
    const submit = (text: string, then: () => void) => {
      if (!this.child) return;
      this.pasteToPty(text);
      window.setTimeout(() => {
        this.send({ t: "input", d: "\r" });
        then();
      }, 350);
    };
    const next = () => {
      if (i >= steps.length || !this.child) return;
      const text = steps[i++];
      submit(text, () => {
        if (i < steps.length) window.setTimeout(next, 1800);
      });
    };
    // First step after claude has settled at its prompt.
    window.setTimeout(next, 1800);
  }

  /** Debounced fit — collapses a burst of resize events into a single resize. */
  scheduleFit() {
    if (this.resizeTimer != null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.fitNow();
    }, 120);
  }

  /** Container ResizeObserver entry point (panel open animation + splitter drag).
   *  Per-frame: rewrap xterm WITHOUT touching the pty (no claude reprint); once
   *  the burst settles: tell claude the final size ONCE (fitNow(true)). */
  onContainerResize() {
    if (this.rafFit == null) {
      this.rafFit = requestAnimationFrame(() => {
        this.rafFit = null;
        this.fitNow(false);
      });
    }
    this.scheduleFit();
  }

  /** Resize xterm to fill its container. `syncPty=false` only rewraps the buffer
   *  (live drag, no claude reprint); `syncPty=true` also sends the real size to
   *  claude (debounced, so a whole drag = ONE reprint). */
  fitNow(syncPty = true) {
    if (!this.fit || !this.term || !this.host?.isConnected) return;
    try {
      this.fit.fit();
      const { cols, rows } = this.term;
      // Only poke the pty when the grid actually changed AND is sane — otherwise
      // the Claude TUI repaints (stacking its banner), and a degenerate size
      // (0 cols/rows during a theme reflow) kills the conpty process.
      if (
        syncPty &&
        !this.exited &&
        cols >= 2 &&
        rows >= 2 &&
        (cols !== this.lastCols || rows !== this.lastRows)
      ) {
        this.lastCols = cols;
        this.lastRows = rows;
        this.send({ t: "resize", cols, rows });
        this.plugin.rememberSize(cols, rows);
      }
      this.term.refresh(0, Math.max(0, rows - 1));
    } catch {
      /* not laid out yet */
    }
  }

  /** Kill this claude process and start a fresh one in the same terminal. */
  restart() {
    if (!this.term) return;
    this.remoteOn = false;
    this.awaitRemoteActive = false;
    this.remoteMenuLoopActive = false;
    this.remoteUrlCaptured = false;
    this.awaitRemoteUrl = false;
    this.plugin.updateRemoteBtn();
    this.killChild();
    this.term.reset();
    this.startHost();
    this.fitNow();
    this.plugin.rebuildHeader();
  }

  killChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Ask the host to kill the PTY and exit itself (it also self-exits on IPC
    // disconnect). Fallback-kill the host if it doesn't go away on its own.
    try {
      child.send({ t: "kill" });
    } catch {
      /* channel already closed */
    }
    window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 800);
  }

  /** Kill the process, dispose the terminal and remove the host (tab closed). */
  dispose() {
    if (this.resizeTimer != null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.rafFit != null) {
      cancelAnimationFrame(this.rafFit);
      this.rafFit = null;
    }
    if (this.busyTimer != null) {
      window.clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
    this.closeWikilinkPicker();
    this.killChild();
    try {
      this.term?.dispose();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.fit = null;
    this.host?.remove();
    this.host = null;
    this.opened = false;
  }

  /** Fork the pty-host (real Node) and wire it up. */
  private startHost() {
    if (!this.term) return;
    const vault = this.plugin.vaultPath();
    if (!vault) {
      this.term.writeln("Could not resolve the vault path (desktop only).");
      return;
    }

    let cp: any;
    try {
      cp = nodeRequire("child_process");
    } catch (e: any) {
      this.term.writeln("Failed to load child_process: " + (e?.message ?? e));
      return;
    }

    const hostPath = path.join(this.plugin.pluginDir(), "pty-host.js");
    const nodePath = this.plugin.resolveNodePath();
    let child: any;
    try {
      child = cp.fork(hostPath, [], {
        execPath: nodePath, // a REAL node.exe — Obsidian's binary ignores ELECTRON_RUN_AS_NODE
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch (e: any) {
      this.term.writeln("Failed to start the pty host with Node at:");
      this.term.writeln("  " + nodePath);
      this.term.writeln("  " + (e?.message ?? e));
      this.term.writeln(
        "\r\nSet a valid path to node.exe in the plugin settings (Node.js path)."
      );
      return;
    }
    this.child = child;
    this.initialSent = false;
    this.exited = false;

    const isWin = process.platform === "win32";
    const shell = isWin
      ? process.env.COMSPEC || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
    const base = this.plugin.settings.command || "claude";
    const extra = this.args?.trim();
    const full = extra ? `${base} ${extra}` : base;
    const args = isWin ? ["/c", full] : ["-lc", full];
    // Spawn at the remembered (or current) size so the first fit is a no-op.
    const cols = this.lastCols || this.plugin.settings.cols || 100;
    const rows = this.lastRows || this.plugin.settings.rows || 30;
    this.lastCols = cols;
    this.lastRows = rows;

    child.on("message", (msg: any) => {
      if (!msg || !this.term) return;
      switch (msg.t) {
        case "ready":
          child.send({
            t: "spawn",
            shell,
            args,
            opts: { name: "xterm-256color", cols, rows, cwd: vault },
          });
          break;
        case "data":
          this.term.write(msg.d);
          this.markActivity(); // tab heartbeat: Claude is producing output
          // Per-session watchers (this terminal's TUI).
          this.maybeSendInitial();
          this.maybeConfirmModel(msg.d);
          this.maybeAfterRemoteActive(msg.d);
          this.maybeCaptureRemoteUrl(msg.d);
          // Global watchers (shared account / usage / auto-switch), fed this
          // session's output.
          this.plugin.maybeAutoSwitch(this, msg.d);
          this.plugin.maybeAutoSaveAccount();
          this.plugin.maybeProbeOnActivity();
          break;
        case "exit":
          this.exited = true; // stop sending resizes to the dead pty
          this.closeWikilinkPicker();
          this.setBusy(false); // settle the heartbeat dot
          if (this.busyTimer != null) {
            window.clearTimeout(this.busyTimer);
            this.busyTimer = null;
          }
          this.term.writeln(
            "\r\n\x1b[2m[claude exited — use the tab's Restart, or close the tab]\x1b[0m"
          );
          this.remoteOn = false;
          this.awaitRemoteUrl = false;
          this.remoteMenuLoopActive = false;
          this.plugin.updateRemoteBtn();
          this.plugin.rebuildHeader(); // mark the tab as exited
          break;
        case "error":
          this.term.writeln("\r\n\x1b[2m[pty-host error] " + msg.message + "\x1b[0m");
          break;
      }
    });

    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
      }
    });

    child.stderr?.on("data", (b: Buffer) =>
      console.error("[claude-code-harness pty-host]", b.toString())
    );
  }
}

export default class ClaudeCodeHarnessPlugin extends Plugin {
  settings: HarnessSettings;

  // Several parallel Claude Code instances. Only the active one is mounted in
  // the panel; the rest keep running and buffering output in xterm. They live on
  // the plugin (not the view) so they survive the panel being closed/reopened.
  private sessions: Session[] = [];
  private activeIndex = 0;
  private viewRoot: HTMLElement | null = null; // the panel contentEl while open

  private fontLink: HTMLLinkElement | null = null;
  // Header button refs (single header, reflecting the ACTIVE session + global state).
  private zoomLabel: HTMLElement | null = null;
  private modelBtn: HTMLElement | null = null;
  private skillBtn: HTMLElement | null = null;
  private accountBtn: HTMLElement | null = null;
  private autoSwitchBtn: HTMLElement | null = null; // green while auto-switch is ON
  private remoteBtn: HTMLElement | null = null;
  private tempImages: string[] = []; // temp PNGs from image paste, cleaned on unload
  // Bundled Token Dashboard server process (null when not running).
  tokenDashboardChild: any = null;

  // --- Global account / auto-switch / usage state (shared by all sessions,
  // because every claude process reads the same ~/.claude/.credentials.json). ---
  private autoSwitchCooldownUntil = 0;
  // Rotate mode: usage % captured when the current account became active.
  private rotateBaselinePct: number | null = null;
  // Account email currently shown in the status bar.
  private barAccountEmail: string | null = null;
  // Swap verification.
  private pendingVerifyEmail: string | null = null;
  private verifyDeadline = 0;
  private sawStatusSinceSwitch = false;
  // Auth-failure recovery after a switch.
  private authWatchUntil = 0;
  private recoverAttempts = 0;
  private warnedNoAccounts = false; // one-shot "need ≥2 accounts" notice
  // Auto-save the active account whenever it changes (throttled).
  private lastAutoSavedEmail = "";
  private lastAutoSaveCheck = 0;
  // Live usage probe cache + guards.
  private accountUsage = new Map<string, AccountUsage>();
  private usageProbing = false;
  private lastActiveProbe = 0;
  private lastAutoSwitchDiag = 0; // throttle for the rotate/threshold console log
  // Last auto-switch evaluation, surfaced by the "Diagnose auto-switch" command.
  private lastDiagInfo:
    | {
        at: number;
        mode: string;
        enabled: boolean;
        pct: number | null;
        src: string;
        cur: string | null;
        bar: string | null;
        baseline: number | null;
        delta: number;
        threshold: number;
        savedAccounts: number;
        reason: string;
      }
    | null = null;

  async onload() {
    await this.loadSettings();
    this.injectFont();

    this.registerView(VIEW_TYPE, (leaf) => new ClaudeCodeView(leaf, this));

    this.addRibbonIcon("terminal", "Claude Code", () => this.activateView());

    this.addCommand({
      id: "open-claude-code",
      name: "Open Claude Code panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-code-session",
      name: "New Claude Code session",
      callback: async () => {
        await this.activateView();
        this.newSession();
      },
    });

    this.addCommand({
      id: "restart-claude-code",
      name: "Restart Claude Code session",
      callback: () => this.activeSession()?.restart(),
    });

    this.addCommand({
      id: "send-active-note",
      name: "Send active note to Claude",
      callback: () => this.sendActiveNote(),
    });

    this.addCommand({
      id: "toggle-remote-control",
      name: "Toggle remote control",
      hotkeys: [{ modifiers: ["Mod"], key: "r" }],
      callback: () => this.activeSession()?.toggleRemoteControl(),
    });

    this.addCommand({
      id: "save-claude-account",
      name: "Save current Claude account",
      callback: () => this.saveCurrentAccount(),
    });

    this.addCommand({
      id: "diagnose-auto-switch",
      name: "Diagnose auto-switch (why no account change)",
      callback: () => this.diagnoseAutoSwitch(),
    });

    this.addCommand({
      id: "open-token-dashboard",
      name: "Open Token Dashboard",
      callback: () => void this.launchTokenDashboard(),
    });

    // Right-click a file/folder in the explorer -> "Send to Claude" (@-mention).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
        menu.addItem((item) =>
          item
            .setTitle("Send to Claude")
            .setIcon("terminal")
            .onClick(() => this.sendPathsToClaude([file.path]))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files: TAbstractFile[]) => {
        menu.addItem((item) =>
          item
            .setTitle("Send to Claude")
            .setIcon("terminal")
            .onClick(() => this.sendPathsToClaude(files.map((f) => f.path)))
        );
      })
    );

    // Follow the Obsidian theme: re-apply colours to every session on change.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        for (const s of this.sessions) s.applyTheme();
      })
    );

    this.addSettingTab(new HarnessSettingTab(this.app, this));

    this.sweepTempImages(); // remove leftover paste PNGs from previous runs

    // Start one session as soon as Obsidian loads, even if the user never opens
    // the panel. xterm buffers all output until the panel is shown.
    this.ensureAtLeastOneSession();

    // Token keep-alive + live usage (see refreshAccount()). Every 3 min we CHECK
    // every account and refresh its OAuth token if it's expired/about to expire,
    // then re-probe usage; also once shortly after start.
    window.setTimeout(() => void this.refreshUsage({ refreshTokens: true }), 5000);
    this.registerInterval(
      window.setInterval(
        () => void this.refreshUsage({ refreshTokens: true }),
        3 * 60 * 1000
      )
    );
  }

  onunload() {
    this.closeAccountMenu();
    for (const s of this.sessions) s.dispose();
    this.sessions = [];
    this.viewRoot = null;
    this.fontLink?.remove();
    this.fontLink = null;
    this.cleanupTempImages();
    if (this.tokenDashboardChild) {
      try {
        this.tokenDashboardChild.kill();
      } catch {
        /* best-effort */
      }
      this.tokenDashboardChild = null;
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  // --- Session manager ----------------------------------------------------

  activeSession(): Session | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  private ensureAtLeastOneSession() {
    if (!this.sessions.length) this.newSession();
  }

  /** Create a new session (its own claude), make it active, and mount it if the
   *  panel is open. Used by the + tab button and the "New session" command. */
  newSession(opts?: { skill?: string; model?: string; args?: string; title?: string }): Session {
    if (this.viewRoot) this.activeSession()?.detachHost();
    const sess = new Session(this, opts);
    this.sessions.push(sess);
    this.activeIndex = this.sessions.length - 1;
    if (this.viewRoot) {
      this.rebuildHeader();
      sess.attachInto(this.viewRoot);
    }
    return sess;
  }

  /** Switch the visible tab to session index `i`. */
  setActive(i: number) {
    if (i < 0 || i >= this.sessions.length) return;
    if (i === this.activeIndex && this.activeSession()?.host?.isConnected) return;
    if (this.viewRoot) this.activeSession()?.detachHost();
    this.activeIndex = i;
    this.rebuildHeader();
    if (this.viewRoot) this.activeSession()?.attachInto(this.viewRoot);
  }

  /** Reorder tabs. Moves the session at `from` so it ends up at index `to` in
   *  the reordered array (0-based, final position). Keeps whatever session was
   *  active still active. */
  moveSession(from: number, to: number) {
    if (from < 0 || from >= this.sessions.length) return;
    to = Math.max(0, Math.min(to, this.sessions.length - 1));
    if (from === to) return;
    const active = this.activeSession();
    const [moved] = this.sessions.splice(from, 1);
    this.sessions.splice(to, 0, moved);
    this.activeIndex = active ? this.sessions.indexOf(active) : this.activeIndex;
    this.rebuildHeader();
  }

  /** Interactive Chrome-style tab drag. The dragged tab follows the pointer
   *  (translateX) while the other tabs slide to open a slot for it; on release
   *  the session order is committed. A press with no movement is a plain click
   *  that just activates the tab. Uses pointer events (HTML5 DnD can't animate
   *  the siblings smoothly). */
  private beginTabDrag(e: PointerEvent, tabsEl: HTMLElement, from: number) {
    if (e.button !== 0) return; // left button only
    const t0 = e.target as HTMLElement;
    if (t0.closest(".cch-tab-close") || t0.closest("input.cch-tab-rename")) return;

    const tabEls = Array.from(tabsEl.querySelectorAll<HTMLElement>(".cch-tab"));
    const dragged = tabEls[from];
    if (!dragged) return;
    const rects = tabEls.map((t) => t.getBoundingClientRect());
    const startX = e.clientX;
    const draggedRect = rects[from];
    const gap = 4; // matches .cch-tabs gap in styles.css
    const slot = draggedRect.width + gap; // space the dragged tab leaves behind
    let started = false;
    let to = from;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < 4) return; // movement threshold → still a click
        started = true;
        dragged.addClass("cch-tab-dragging");
        dragged.style.position = "relative";
        dragged.style.zIndex = "5";
        dragged.style.transition = "none";
      }
      ev.preventDefault();
      dragged.style.transform = `translateX(${dx}px)`;
      // The dragged tab's current visual centre.
      const center = draggedRect.left + draggedRect.width / 2 + dx;
      // New index = how many OTHER tabs should end up before the dragged one. A
      // neighbour reacts as soon as the dragged centre crosses TRIGGER — a small
      // fraction `frac` into that neighbour from the edge facing the drag — so a
      // smaller `frac` makes neighbours slide out of the way sooner.
      const frac = 0.25;
      let idx = 0;
      for (let j = 0; j < tabEls.length; j++) {
        if (j === from) continue;
        const r = rects[j];
        if (j < from) {
          // Left neighbour: stays "before" until the drag pushes past its right.
          if (center >= r.left + (1 - frac) * r.width) idx++;
        } else {
          // Right neighbour: becomes "before" once the drag passes its left.
          if (center > r.left + frac * r.width) idx++;
        }
      }
      to = idx;
      // Slide the siblings to open the slot where the dragged tab will land.
      for (let j = 0; j < tabEls.length; j++) {
        if (j === from) continue;
        let shift = 0;
        if (to > from && j > from && j <= to) shift = -slot;
        else if (to < from && j >= to && j < from) shift = slot;
        tabEls[j].style.transition = "transform 0.15s ease";
        tabEls[j].style.transform = shift ? `translateX(${shift}px)` : "";
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (started) {
        // Always clear the inline drag styles first: if the index didn't change
        // (e.g. dragged a corner tab past the edge) moveSession is a no-op and
        // won't rebuild, so without this the tab would stay where the cursor
        // left it instead of snapping back into its slot.
        for (const t of tabEls) {
          t.style.transform = "";
          t.style.transition = "";
          t.style.zIndex = "";
          t.style.position = "";
        }
        dragged.removeClass("cch-tab-dragging");
        if (to !== from) this.moveSession(from, to); // rebuilds the header
      } else {
        this.setActive(from); // it was a click, not a drag
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /** Close a tab: kill that instance's claude process and drop it. Keeps at
   *  least one session alive so the panel stays usable. */
  closeSession(sess: Session) {
    const idx = this.sessions.indexOf(sess);
    if (idx < 0) return;
    if (this.viewRoot && idx === this.activeIndex) sess.detachHost();
    sess.dispose();
    this.sessions.splice(idx, 1);
    if (!this.sessions.length) {
      this.activeIndex = 0;
      this.newSession(); // always keep one
      return;
    }
    if (this.activeIndex > idx) this.activeIndex--;
    else if (this.activeIndex >= this.sessions.length)
      this.activeIndex = this.sessions.length - 1;
    this.rebuildHeader();
    if (this.viewRoot) {
      const a = this.activeSession();
      if (a && !a.host?.isConnected) a.attachInto(this.viewRoot);
      else a?.scheduleFit();
    }
  }

  /** Mount the panel: build the header (tabs + toolbar) and show the active
   *  session. Called from the view's onOpen. */
  attachView(root: HTMLElement) {
    this.viewRoot = root;
    this.ensureAtLeastOneSession();
    this.buildHeader(root);
    this.activeSession()?.attachInto(root);
  }

  /** Unmount the panel WITHOUT killing any session. Called from the view's onClose. */
  detachView() {
    this.activeSession()?.detachHost();
    this.viewRoot = null;
  }

  /** ResizeObserver entry point — delegate to the active session. */
  onContainerResize() {
    this.activeSession()?.onContainerResize();
  }

  /** Reference the active note in the prompt (Claude resolves @-mentions). */
  async sendActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note to send.");
      return;
    }
    await this.sendPathsToClaude([file.path]);
  }

  /** @-mention one or more vault paths in the active session (opens the panel
   *  and starts a session if needed). Used by the @ button, the file-explorer
   *  context menu and drag-and-drop. */
  async sendPathsToClaude(paths: string[]) {
    const uniq = [...new Set(paths)].filter(Boolean);
    if (!uniq.length) return;
    await this.activateView();
    this.ensureAtLeastOneSession();
    const a = this.activeSession();
    if (!a?.child) {
      new Notice("Claude session is not running.");
      return;
    }
    a.mention(uniq);
  }

  // --- Font / size --------------------------------------------------------

  /** Font zoom (Ctrl +/-/0). Persisted; applied to every session. */
  setFontSize(px: number) {
    const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)));
    this.settings.fontSize = clamped;
    void this.saveSettings();
    for (const s of this.sessions) s.applyFontSize(clamped);
    if (this.zoomLabel) this.zoomLabel.setText(clamped + "px");
  }

  zoomBy(delta: number) {
    this.setFontSize((this.settings.fontSize || 14) + delta);
  }

  /** Persist the last fitted grid size (so the next session spawns claude at it). */
  rememberSize(cols: number, rows: number) {
    if (this.settings.cols !== cols || this.settings.rows !== rows) {
      this.settings.cols = cols;
      this.settings.rows = rows;
      void this.saveSettings();
    }
  }

  // --- Header buttons reflecting the active session -----------------------

  updateModelBtn() {
    if (!this.modelBtn) return;
    const id = this.activeSession()?.model ?? this.settings.model;
    this.modelBtn.setText(MODELS.find((m) => m.id === id)?.label ?? "Model");
  }

  updateSkillBtn() {
    if (!this.skillBtn) return;
    const skill = this.activeSession()?.skill ?? this.settings.skill;
    this.skillBtn.title = "Skill: " + (skill || "none");
  }

  /** Reflect the active session's remoteOn on the header button (green when ON). */
  updateRemoteBtn() {
    if (!this.remoteBtn) return;
    const on = this.activeSession()?.remoteOn ?? false;
    this.remoteBtn.toggleClass("cch-active", on);
    this.remoteBtn.title = on
      ? "Remote control ON — click to disconnect"
      : "Activate remote control (/remote-control)";
  }

  /** Reflect the auto-switch state on its header button (green = ON), with a
   *  tooltip summarising the active mode + percentage. */
  updateAutoSwitchBtn() {
    if (!this.autoSwitchBtn) return;
    const on = this.settings.autoSwitch;
    this.autoSwitchBtn.toggleClass("cch-active", on);
    const mode = this.settings.autoSwitchMode || "threshold";
    const detail =
      mode === "rotate"
        ? "rotate every +" + (this.settings.autoSwitchDelta || 10) + "%"
        : "at " + (this.settings.autoSwitchThreshold || 90) + "%";
    this.autoSwitchBtn.setAttr("aria-label", "Auto-switch accounts");
    this.autoSwitchBtn.title = on
      ? "Auto-switch ON (" + detail + ") — click to configure"
      : "Auto-switch OFF — click to enable";
  }

  /** Header 👤 menu: save / refresh / switch accounts, plus a section to allow or
   *  block each saved account as an AUTO-switch destination. Blocking an account
   *  (e.g. a friend's) stops the percentage-based auto-switch from ever spending
   *  its tokens; you can still switch to it manually from the list above. */
  /** Currently-open account popup, so re-opening / closing is idempotent. */
  private accountPopup: HTMLElement | null = null;
  private accountPopupCleanup: (() => void) | null = null;

  closeAccountMenu() {
    this.accountPopupCleanup?.();
    this.accountPopup?.remove();
    this.accountPopup = null;
    this.accountPopupCleanup = null;
  }

  /**
   * Account popup: a SINGLE list of saved accounts. Each row has a toggle on the
   * left (allow/block as an auto-switch destination) plus the account label;
   * clicking the label switches to that account. No more two separate lists.
   */
  openAccountMenu(anchor: HTMLElement) {
    this.closeAccountMenu();
    if (this.settings.usageProbe) void this.refreshUsage({});
    const cur = this.currentAccountEmail();

    const pop = document.createElement("div");
    pop.className = "menu cch-account-menu";
    document.body.appendChild(pop);
    this.accountPopup = pop;

    const headerItem = (
      title: string,
      icon: string,
      onClick: () => void
    ) => {
      const row = pop.createDiv({ cls: "menu-item cch-acct-action" });
      const ic = row.createDiv({ cls: "menu-item-icon" });
      setIcon(ic, icon);
      row.createDiv({ cls: "menu-item-title", text: title });
      row.onclick = () => {
        this.closeAccountMenu();
        onClick();
      };
    };

    headerItem("Save current account", "save", () => this.saveCurrentAccount());
    if (this.settings.usageProbe) {
      headerItem("Refresh usage", "refresh-cw", () => void this.refreshUsage({}));
    }
    pop.createDiv({ cls: "menu-separator" });

    const saved = this.listSavedAccounts();
    if (!saved.length) {
      pop.createDiv({
        cls: "menu-item cch-acct-empty",
        text: "No saved accounts",
      });
    } else {
      pop.createDiv({
        cls: "cch-acct-hint",
        text: "Toggle = allow auto-switch · click name to use",
      });
      const emailWidth = Math.max(...saved.map((a) => a.email.length));
      for (const a of saved) {
        const row = pop.createDiv({ cls: "cch-acct-row" });
        const eligible = this.isAccountEligible(a.email);
        if (!eligible) row.addClass("cch-acct-blocked");

        // Left toggle: allow (on) / block (off) this account. A blocked account
        // is fully unusable — dimmed AND not switchable by clicking its name.
        const toggle = row.createDiv({
          cls: "cch-acct-toggle" + (eligible ? " is-on" : ""),
        });
        toggle.createDiv({ cls: "cch-acct-knob" });
        toggle.setAttr(
          "aria-label",
          eligible ? "Enabled" : "Disabled"
        );
        toggle.onclick = async (e) => {
          e.stopPropagation();
          await this.toggleAccountEligible(a.email);
          const nowOn = this.isAccountEligible(a.email);
          toggle.toggleClass("is-on", nowOn);
          row.toggleClass("cch-acct-blocked", !nowOn);
          toggle.setAttr("aria-label", nowOn ? "Enabled" : "Disabled");
        };

        // Label: click to switch the live session to this account (unless
        // blocked, in which case it's inert — re-enable it with the toggle).
        const label = row.createDiv({ cls: "cch-acct-label" });
        if (cur === a.email.trim().toLowerCase())
          label.addClass("cch-acct-current");
        if (this.settings.usageProbe) {
          label.appendChild(this.accountMenuTitle(a.email, emailWidth));
        } else {
          label.setText(a.email);
        }
        label.onclick = () => {
          if (!this.isAccountEligible(a.email)) {
            new Notice(
              "This account is disabled. Turn its toggle on to use it."
            );
            return;
          }
          this.closeAccountMenu();
          this.switchToAccount(a.email);
        };
      }
    }

    // Position under the anchor, clamped to the viewport, and dismiss on
    // outside click / Escape.
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const rect = pop.getBoundingClientRect();
    // Sit a bit to the left of the anchor (the button is near the right edge),
    // then clamp so it never leaves the viewport.
    let left = r.left - 180;
    let top = r.bottom + 2;
    if (left + rect.width > window.innerWidth - margin)
      left = window.innerWidth - rect.width - margin;
    left = Math.max(margin, left);
    if (top + rect.height > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    const onDown = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor)
        this.closeAccountMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeAccountMenu();
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    this.accountPopupCleanup = () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }

  /** Menu to toggle auto-switch and pick its mode + percentage from the header. */
  private openAutoSwitchMenu(anchor: HTMLElement) {
    const menu = new Menu();
    const s = this.settings;

    menu.addItem((item) =>
      item
        .setTitle(s.autoSwitch ? "Auto-switch is ON" : "Auto-switch is OFF")
        .setIcon(s.autoSwitch ? "toggle-right" : "toggle-left")
        .setChecked(s.autoSwitch)
        .onClick(async () => {
          s.autoSwitch = !s.autoSwitch;
          this.resetRotationBaseline();
          await this.saveSettings();
          this.updateAutoSwitchBtn();
          if (s.autoSwitch) {
            // Refresh + probe every account now so the first destination pick uses
            // fresh, alive tokens instead of waiting for the next 3-min tick.
            void this.refreshUsage({ refreshTokens: true });
            if (this.listSavedAccounts().length < 2) {
              new Notice(
                "Auto-switch needs at least 2 saved accounts — log in with /login to save more."
              );
            }
          }
        })
    );

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Mode").setDisabled(true));
    const modes: { id: string; label: string }[] = [
      { id: "threshold", label: "Threshold (fixed %)" },
      { id: "rotate", label: "Rotate by increment" },
    ];
    for (const m of modes) {
      menu.addItem((item) =>
        item
          .setTitle(m.label)
          .setChecked((s.autoSwitchMode || "threshold") === m.id)
          .onClick(async () => {
            s.autoSwitchMode = m.id;
            this.resetRotationBaseline();
            await this.saveSettings();
            this.updateAutoSwitchBtn();
          })
      );
    }

    menu.addSeparator();
    const rotate = (s.autoSwitchMode || "threshold") === "rotate";
    menu.addItem((item) =>
      item.setTitle(rotate ? "Increment per rotation" : "Switch at usage %").setDisabled(true)
    );
    const presets = rotate ? [5, 10, 15, 20, 25] : [70, 80, 85, 90, 95];
    const current = rotate ? s.autoSwitchDelta || 10 : s.autoSwitchThreshold || 90;
    for (const p of presets) {
      menu.addItem((item) =>
        item
          .setTitle((rotate ? "+" : "") + p + "%")
          .setChecked(current === p)
          .onClick(async () => {
            if (rotate) s.autoSwitchDelta = p;
            else s.autoSwitchThreshold = p;
            this.resetRotationBaseline();
            await this.saveSettings();
            this.updateAutoSwitchBtn();
          })
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("More options…")
        .setIcon("settings")
        .onClick(() => this.openSettings())
    );

    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom });
  }

  // --- Skills -------------------------------------------------------------

  /** The vault's local skills folder (<vault>/.claude/skills). The plugin runs
   *  claude with cwd = vault root, so these project-local skills are the ones in
   *  scope; falls back to the global ~/.claude/skills if the vault path is
   *  unavailable. */
  skillsDir(): string {
    const base = this.vaultPath();
    if (base) return path.join(base, ".claude", "skills");
    const os = nodeRequire("os");
    return path.join(os.homedir(), ".claude", "skills");
  }

  /** Names of the skills available in ~/.claude/skills (subfolders with a
   *  SKILL.md), sorted. The folder name is the /<name> used to invoke it. */
  listSkills(): string[] {
    try {
      const fs = nodeRequire("fs");
      const dir = this.skillsDir();
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e: any) => e.isDirectory())
        .map((e: any) => e.name)
        .filter((name: string) =>
          fs.existsSync(path.join(dir, name, "SKILL.md"))
        )
        .sort((a: string, b: string) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /** Open this plugin's settings tab directly. */
  openSettings() {
    try {
      const setting = (this.app as any).setting;
      setting.open();
      setting.openTabById(this.manifest.id);
    } catch (e) {
      new Notice("Could not open settings.");
      console.warn("[claude-code-harness] openSettings:", e);
    }
  }

  /** Open Claude Code's skills folder (~/.claude/skills) in the OS file manager,
   *  then bring that window to the front and maximise it. */
  openSkillsFolder() {
    try {
      const dir = this.skillsDir();
      const shell = nodeRequire("electron")?.shell;
      if (shell?.openPath) {
        void shell.openPath(dir);
        this.focusFolderWindow(dir);
      } else {
        new Notice("Could not open the folder (shell unavailable).");
      }
    } catch (e) {
      new Notice("Could not open the skills folder.");
      console.warn("[claude-code-harness] openSkillsFolder:", e);
    }
  }

  /** Bring the Explorer window showing `folder` to the front and maximise it.
   *  Windows-only, best-effort (see the original notes). */
  private focusFolderWindow(folder: string) {
    try {
      const cp = nodeRequire("child_process");
      const target = folder.replace(/\//g, "\\").replace(/'/g, "''");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        "Add-Type -Name N -Namespace W -MemberDefinition '" +
          '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);' +
          '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' +
          "'",
        "$shell = New-Object -ComObject Shell.Application",
        "$win = $null",
        "for ($i=0; $i -lt 8 -and -not $win; $i++) {",
        "  Start-Sleep -Milliseconds 400",
        `  $win = $shell.Windows() | Where-Object { $_.Document.Folder.Self.Path -ieq '${target}' } | Select-Object -First 1`,
        "}",
        "if ($win) {",
        "  $h = [System.IntPtr]$win.HWND",
        "  [W.N]::ShowWindow($h, 6) | Out-Null", // SW_MINIMIZE
        "  Start-Sleep -Milliseconds 150",
        "  [W.N]::ShowWindow($h, 3) | Out-Null", // SW_MAXIMIZE (restores → foreground)
        "  [W.N]::SetForegroundWindow($h) | Out-Null",
        "  $ws = New-Object -ComObject WScript.Shell",
        "  $ws.AppActivate($win.LocationName) | Out-Null",
        "}",
      ].join("; ");
      cp.spawn(
        "powershell",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { detached: true, stdio: "ignore", windowsHide: true }
      ).unref();
    } catch {
      /* best-effort */
    }
  }

  // --- Temp image paste cleanup ------------------------------------------

  /** If the clipboard holds an image, write it to a temp PNG and return its
   *  path; otherwise null. */
  saveClipboardImage(clipboard: any): string | null {
    try {
      const img = clipboard?.readImage?.();
      if (!img || img.isEmpty()) return null;
      const os = nodeRequire("os");
      const fs = nodeRequire("fs");
      const file = path.join(os.tmpdir(), `cch-paste-${Date.now()}.png`);
      fs.writeFileSync(file, img.toPNG());
      this.tempImages.push(file);
      return file;
    } catch {
      return null;
    }
  }

  /** Delete temp PNGs created by image paste this session. */
  private cleanupTempImages() {
    if (!this.tempImages.length) return;
    try {
      const fs = nodeRequire("fs");
      for (const f of this.tempImages) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* fs unavailable */
    }
    this.tempImages = [];
  }

  /** Remove leftover cch-paste-*.png from earlier runs (older than 1 day). */
  private sweepTempImages() {
    try {
      const fs = nodeRequire("fs");
      const os = nodeRequire("os");
      const dir = os.tmpdir();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(dir)) {
        if (!/^cch-paste-\d+\.png$/.test(name)) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** Load JetBrains Mono so the terminal renders identically to the reference. */
  private injectFont() {
    if (document.getElementById("cch-jetbrains-mono")) return;
    const link = document.createElement("link");
    link.id = "cch-jetbrains-mono";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
    this.fontLink = link;
  }

  // --- Account email ------------------------------------------------------

  /** The Claude account currently logged in, from ~/.claude.json. */
  private currentAccountEmail(): string | null {
    try {
      const fs = nodeRequire("fs");
      const os = nodeRequire("os");
      const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
      const email = JSON.parse(raw)?.oauthAccount?.emailAddress;
      return email ? String(email).trim().toLowerCase() : null;
    } catch {
      return null;
    }
  }

  // --- Account switching --------------------------------------------------
  // Claude Code stores its CLI auth in the plain file ~/.claude/.credentials.json
  // (claudeAiOauth), and the account metadata in ~/.claude.json (oauthAccount).
  // We snapshot both per account under ~/.claude/cch-accounts/<email>.json and
  // switch by writing them back — WITHOUT restarting: a live claude re-reads the
  // credentials and uses the new account on its next request (see README_TECNICO).

  private accountsDir(): string {
    return path.join(nodeRequire("os").homedir(), ".claude", "cch-accounts");
  }
  private credsPath(): string {
    return path.join(nodeRequire("os").homedir(), ".claude", ".credentials.json");
  }
  private claudeJsonPath(): string {
    return path.join(nodeRequire("os").homedir(), ".claude.json");
  }
  private accountFileName(email: string): string {
    return email.replace(/[^a-zA-Z0-9._@-]/g, "_") + ".json";
  }

  /** Write JSON atomically (temp file + rename) so a concurrent reader (the live
   *  claude re-reading credentials per request) never sees a half-written file. */
  private writeJsonAtomic(file: string, obj: any) {
    const fs = nodeRequire("fs");
    const tmp = file + ".cch-tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  /** Snapshot the active account's credentials + oauthAccount under its email. */
  saveCurrentAccount(notify = true): string | null {
    try {
      const fs = nodeRequire("fs");
      const creds = JSON.parse(fs.readFileSync(this.credsPath(), "utf8"));
      const cj = JSON.parse(fs.readFileSync(this.claudeJsonPath(), "utf8"));
      const oauthAccount = cj?.oauthAccount;
      const email = oauthAccount?.emailAddress;
      if (!email) {
        if (notify) new Notice("No active account email found.");
        return null;
      }
      const dir = this.accountsDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.writeJsonAtomic(path.join(dir, this.accountFileName(email)), {
        email,
        savedAt: Date.now(),
        credentials: creds,
        oauthAccount,
      });
      if (notify) new Notice("Saved Claude account: " + email);
      return email;
    } catch (e) {
      if (notify) new Notice("Could not save the current account.");
      console.warn("[claude-code-harness] saveCurrentAccount:", e);
      return null;
    }
  }

  /** Saved accounts (from cch-accounts/*.json), sorted by email. */
  listSavedAccounts(): { email: string; file: string }[] {
    try {
      const fs = nodeRequire("fs");
      const dir = this.accountsDir();
      return fs
        .readdirSync(dir)
        .filter((f: string) => f.toLowerCase().endsWith(".json"))
        .map((f: string) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            return { email: j.email || f.replace(/\.json$/i, ""), file: f };
          } catch {
            return { email: f.replace(/\.json$/i, ""), file: f };
          }
        })
        .sort((a: { email: string }, b: { email: string }) =>
          a.email.localeCompare(b.email)
        );
    } catch {
      return [];
    }
  }

  /** Switch to a saved account by hot-swapping the credentials file — NO restart.
   *  Affects ALL running sessions (they re-read ~/.claude/.credentials.json and
   *  use the new account on their next request). Snapshots the outgoing account
   *  first (to keep its freshly-refreshed token). */
  switchToAccount(email: string) {
    try {
      const fs = nodeRequire("fs");
      const file = path.join(this.accountsDir(), this.accountFileName(email));
      if (!fs.existsSync(file)) {
        new Notice("No saved credentials for " + email);
        return;
      }
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!saved?.credentials?.claudeAiOauth?.accessToken) {
        new Notice("Saved file for " + email + " has no valid credentials.");
        return;
      }
      const current = this.currentAccountEmail();
      if (current && current !== email.trim().toLowerCase()) {
        this.saveCurrentAccount(false); // preserve the outgoing account's latest token
      }
      // Atomic writes so the live claude never reads a half-written file.
      this.writeJsonAtomic(this.credsPath(), saved.credentials);
      if (saved.oauthAccount) {
        const cj = JSON.parse(fs.readFileSync(this.claudeJsonPath(), "utf8"));
        cj.oauthAccount = saved.oauthAccount;
        this.writeJsonAtomic(this.claudeJsonPath(), cj);
      }
      const target = email.trim().toLowerCase();
      this.lastAutoSavedEmail = target;
      this.rotateBaselinePct = null; // new account re-establishes its own baseline
      this.pendingVerifyEmail = target;
      this.verifyDeadline = Date.now() + 45000;
      this.sawStatusSinceSwitch = false;
      this.authWatchUntil = Date.now() + 60000;
      if (this.accountBtn) this.accountBtn.title = "Account: " + target; // optimistic
      new Notice("Switched to " + email + " — used on the next message.");
    } catch (e) {
      new Notice("Could not switch account.");
      console.warn("[claude-code-harness] switchToAccount:", e);
    }
  }

  /** Delete a saved account snapshot. */
  deleteSavedAccount(email: string) {
    try {
      const fs = nodeRequire("fs");
      fs.unlinkSync(path.join(this.accountsDir(), this.accountFileName(email)));
    } catch (e) {
      console.warn("[claude-code-harness] deleteSavedAccount:", e);
    }
  }

  /** Is this saved account allowed as an AUTO-switch destination? Friends'
   *  accounts can be blocked so the plugin never spends their tokens on its own;
   *  manual switching from the menu is always allowed regardless. */
  isAccountEligible(email: string): boolean {
    return !this.settings.autoSwitchExcluded.includes(email.trim().toLowerCase());
  }

  /** Allow/block an account as an auto-switch destination (persisted). */
  async toggleAccountEligible(email: string) {
    const lower = email.trim().toLowerCase();
    const list = this.settings.autoSwitchExcluded;
    const i = list.indexOf(lower);
    if (i >= 0) list.splice(i, 1);
    else list.push(lower);
    await this.saveSettings();
  }

  /** Auto-snapshot the active account whenever it changes (throttled to ~10s). */
  maybeAutoSaveAccount() {
    const now = Date.now();
    if (now - this.lastAutoSaveCheck < 10000) return;
    this.lastAutoSaveCheck = now;
    const email = this.currentAccountEmail();
    if (!email || email === this.lastAutoSavedEmail) return;
    let existed = false;
    try {
      const fs = nodeRequire("fs");
      existed = fs.existsSync(path.join(this.accountsDir(), this.accountFileName(email)));
    } catch {
      /* ignore */
    }
    const saved = this.saveCurrentAccount(false);
    if (saved) {
      this.lastAutoSavedEmail = email;
      if (!existed) new Notice("Auto-saved Claude account: " + email);
    }
  }

  /** Forget the rotate-mode baseline (re-captured on the next reading). */
  resetRotationBaseline() {
    this.rotateBaselinePct = null;
  }

  /** True when `email` has a FRESH 7d reading at/over the weekly ceiling, i.e. it
   *  is about to hit its weekly limit and must NOT be used as a switch target.
   *  Fail-open: unknown/stale/error 7d → false (don't exclude on missing data). */
  private weeklyMaxedOut(email: string): boolean {
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u || u.error || u.pct7d == null) return false;
    if (Date.now() - u.checkedAt >= USAGE_FRESH_MS) return false;
    return u.pct7d >= WEEKLY_CEILING_PCT;
  }

  /** Account to switch to: the **least-used** one (lowest probed 5h %), skipping
   *  dead-token accounts and any whose 7d usage is ≥ the weekly ceiling. Falls
   *  back to round-robin. Null if nowhere to go. */
  private pickNextAccount(): string | null {
    const saved = this.listSavedAccounts().map((a) => a.email);
    if (saved.length < 2) return null;
    const cur = this.currentAccountEmail();
    const others = saved.filter(
      (e) => e.trim().toLowerCase() !== cur && this.isAccountEligible(e)
    );
    if (!others.length) return null;

    let best: string | null = null;
    let bestPct = Infinity;
    for (const e of others) {
      const u = this.accountUsage.get(e.trim().toLowerCase());
      if (u?.error === "auth") continue; // dead token — can't use it
      if (this.weeklyMaxedOut(e)) continue; // 7d ≥ ceiling — about to hit weekly limit
      const pct =
        u && u.pct5h != null && Date.now() - u.checkedAt < USAGE_FRESH_MS
          ? u.pct5h
          : Infinity;
      if (pct < bestPct) {
        bestPct = pct;
        best = e;
      }
    }
    if (best && bestPct < Infinity) return best;

    const idx = saved.findIndex((e) => e.trim().toLowerCase() === cur);
    const start = idx >= 0 ? idx + 1 : 0;
    for (let i = 0; i < saved.length; i++) {
      const cand = saved[(start + i) % saved.length];
      if (cand.trim().toLowerCase() === cur) continue;
      if (!this.isAccountEligible(cand)) continue;
      if (this.accountUsage.get(cand.trim().toLowerCase())?.error === "auth") continue;
      if (this.weeklyMaxedOut(cand)) continue; // 7d ≥ ceiling — about to hit weekly limit
      return cand;
    }
    return best; // may be null
  }

  /** Least-used eligible account (not the current one) whose FRESH 5h usage is
   *  strictly below `maxPct`. Returns null when none qualifies — no fresh
   *  reading, all blocked, or every candidate is already at/over `maxPct` (so
   *  switching there would not buy any margin). This is what enforces the
   *  "always jump to a less-spent account, keep a 10% margin" rule. */
  private leastUsedBelow(maxPct: number): { email: string; pct: number } | null {
    const cur = this.currentAccountEmail();
    let best: string | null = null;
    let bestPct = Infinity;
    for (const a of this.listSavedAccounts()) {
      const lower = a.email.trim().toLowerCase();
      if (lower === cur) continue;
      if (!this.isAccountEligible(a.email)) continue;
      const u = this.accountUsage.get(lower);
      if (!u || u.error === "auth" || u.pct5h == null) continue;
      if (Date.now() - u.checkedAt >= USAGE_FRESH_MS) continue;
      if (u.pct5h >= maxPct) continue; // no room → keep the 10% margin elsewhere
      if (this.weeklyMaxedOut(a.email)) continue; // 7d ≥ ceiling — about to hit weekly limit
      if (u.pct5h < bestPct) {
        bestPct = u.pct5h;
        best = a.email;
      }
    }
    return best ? { email: best, pct: bestPct } : null;
  }

  /** True if at least one eligible non-current account has a FRESH 5h reading
   *  (whatever its value). Lets us tell "every other account is maxed out" apart
   *  from "we simply have no usage data yet" when deciding whether to stay. */
  private haveFreshUsageData(): boolean {
    const cur = this.currentAccountEmail();
    for (const a of this.listSavedAccounts()) {
      const lower = a.email.trim().toLowerCase();
      if (lower === cur) continue;
      if (!this.isAccountEligible(a.email)) continue;
      const u = this.accountUsage.get(lower);
      if (u && !u.error && u.pct5h != null && Date.now() - u.checkedAt < USAGE_FRESH_MS) {
        return true;
      }
    }
    return false;
  }

  /** One-shot notice when an auto-switch is wanted but there is genuinely no
   *  destination (only one account saved, or every other one is blocked). NOT
   *  shown when the reason is "everyone is maxed" — that is a normal stay. */
  private maybeWarnNoAccounts() {
    if (this.warnedNoAccounts) return;
    this.warnedNoAccounts = true;
    const eligible = this.listSavedAccounts().filter(
      (a) =>
        a.email.trim().toLowerCase() !== this.currentAccountEmail() &&
        this.isAccountEligible(a.email)
    ).length;
    new Notice(
      eligible === 0 && this.listSavedAccounts().length >= 2
        ? "Auto-switch: every other account is blocked — allow one in the 👤 menu."
        : "Auto-switch: save at least 2 accounts (log in with /login)."
    );
  }

  // --- Live usage probe (API rate-limit headers) --------------------------

  /** OAuth access token for an account: live creds for the active account,
   *  otherwise the saved snapshot. Null if unreadable. */
  private accessTokenFor(email: string): string | null {
    try {
      const fs = nodeRequire("fs");
      const lower = email.trim().toLowerCase();
      const file =
        lower === this.currentAccountEmail()
          ? this.credsPath()
          : path.join(this.accountsDir(), this.accountFileName(email));
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return (
        j?.claudeAiOauth?.accessToken ||
        j?.credentials?.claudeAiOauth?.accessToken ||
        null
      );
    } catch {
      return null;
    }
  }

  /** Refresh one account's OAuth token (the same grant Claude Code uses) and
   *  persist the rotated pair atomically. Returns true on success. Only touches
   *  the file on HTTP 200, so a failure never destroys the refresh token. */
  private async refreshAccount(email: string): Promise<boolean> {
    const fs = nodeRequire("fs");
    const lower = email.trim().toLowerCase();
    const isActive = lower === this.currentAccountEmail();
    // The ACTIVE account is refreshed by `claude` itself (it re-reads
    // .credentials.json and rotates the refresh token lazily on each request).
    // Refreshing it from here too would race against that rotation: if we rotate
    // RT1→RT2 while claude still holds RT1, claude's next refresh uses a dead
    // token → 401 → forced /login. So we leave the active account to claude and
    // only keep INACTIVE accounts (which claude never touches) alive from here.
    if (isActive) {
      console.log("[cch keepalive] skip active", lower, "(claude owns refresh)");
      return true; // let refreshUsage probe with the live token as-is
    }
    const file = isActive
      ? this.credsPath()
      : path.join(this.accountsDir(), this.accountFileName(email));

    let store: any;
    try {
      store = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
    const oauth = isActive ? store?.claudeAiOauth : store?.credentials?.claudeAiOauth;
    const refreshToken = oauth?.refreshToken;
    if (!refreshToken) return false;

    const prev = Number(oauth.expiresAt) || 0;
    const prevMs = prev > 0 && prev < 1e12 ? prev * 1000 : prev;
    if (prevMs && prevMs - Date.now() > REFRESH_SKEW_MS) return true; // still alive

    console.log("[cch keepalive] refreshing", lower);
    const resp = await this.oauthRefresh(refreshToken);
    if (!resp) {
      console.warn("[cch keepalive] refresh FAILED", lower, "(see cause above)");
      return false; // network/HTTP error → keep old creds intact
    }

    const ttl = resp.expires_in || 0;
    const expiresAt =
      prev > 0 && prev < 1e12
        ? Math.floor(Date.now() / 1000) + ttl // seconds
        : Date.now() + ttl * 1000; // milliseconds
    const merged = {
      ...oauth,
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token || refreshToken,
      expiresAt,
    };
    if (isActive) {
      store.claudeAiOauth = merged;
    } else {
      store.credentials = store.credentials || {};
      store.credentials.claudeAiOauth = merged;
    }
    try {
      this.writeJsonAtomic(file, store);
    } catch {
      return false;
    }
    console.log("[cch keepalive] refreshed", lower, "ok");
    return true;
  }

  /** POST the OAuth refresh-token grant. Resolves to the parsed token response on
   *  HTTP 200, or null on any error (never rejects). */
  private oauthRefresh(
    refreshToken: string
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
    return new Promise((resolve) => {
      let https: any;
      try {
        https = nodeRequire("https");
      } catch {
        resolve(null);
        return;
      }
      const body = JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      });
      const u = new URL(OAUTH_TOKEN_URL);
      let done = false;
      const finish = (r: any) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          path: u.pathname,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res: any) => {
          const status = res.statusCode;
          let data = "";
          res.on("data", (c: any) => (data += c));
          res.on("end", () => {
            if (status !== 200) {
              // 401 = refresh token dead/rotated out from under us; 429 = the
              // token endpoint rate-limited us (it limits hard). Either way the
              // old creds are kept intact by the caller.
              console.warn(
                "[cch keepalive] token endpoint HTTP",
                status,
                String(data).slice(0, 200)
              );
              return finish(null);
            }
            try {
              const j = JSON.parse(data);
              finish(j?.access_token ? j : null);
            } catch {
              finish(null);
            }
          });
        }
      );
      req.on("error", (e: any) => {
        console.warn("[cch keepalive] token endpoint network error", e?.message || e);
        finish(null);
      });
      req.on("timeout", () => {
        console.warn("[cch keepalive] token endpoint timeout");
        req.destroy();
        finish(null);
      });
      req.write(body);
      req.end();
    });
  }

  /** Probe one account's usage via a minimal API call, reading the rate-limit
   *  response headers. Resolves to an AccountUsage (never rejects). */
  private probeUsage(token: string): Promise<AccountUsage> {
    const now = Date.now();
    const empty = (error: AccountUsage["error"]): AccountUsage => ({
      pct5h: null,
      reset5h: null,
      pct7d: null,
      reset7d: null,
      status: null,
      error,
      checkedAt: now,
    });
    return new Promise((resolve) => {
      let https: any;
      try {
        https = nodeRequire("https");
      } catch {
        resolve(empty("net"));
        return;
      }
      const model = this.settings.usageProbeModel?.trim() || USAGE_PROBE_MODEL;
      const body = JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      const u = new URL(USAGE_API_URL);
      const toPct = (v: string | undefined): number | null => {
        if (v == null) return null;
        const f = parseFloat(v);
        if (isNaN(f)) return null;
        // The unified-utilization headers are ALWAYS a 0..1 fraction, so always
        // ×100. (The old `f <= 1 ? …` guard mis-read a maxed-out account: at the
        // limit the fraction is ~1.0 and can tip just above 1.0, e.g. 1.02, which
        // the guard treated as "already a %" → reported 100% as 1%.) Cap at 100.
        return Math.min(100, Math.round(f * 100));
      };
      let done = false;
      const finish = (r: AccountUsage) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          path: u.pathname,
          headers: {
            authorization: "Bearer " + token,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": OAUTH_BETA,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res: any) => {
          const h = res.headers || {}; // Node lowercases header names
          const status = res.statusCode;
          res.on("data", () => {});
          res.on("end", () => {
            if (status === 401) return finish(empty("auth"));
            const pct5h = toPct(h[H_5H_UTIL]);
            if (pct5h == null) {
              return finish(empty(status === 429 ? "rate" : "net"));
            }
            const reset = parseInt(h[H_5H_RESET], 10);
            // 7d reset: prefer the expected header, else scan for any header
            // whose name mentions both "7d" and "reset" (robust to a rename).
            let raw7d = h[H_7D_RESET];
            if (raw7d == null) {
              for (const k of Object.keys(h)) {
                if (k.includes("7d") && k.includes("reset")) {
                  raw7d = h[k];
                  break;
                }
              }
            }
            const reset7 = parseInt(raw7d, 10);
            finish({
              pct5h,
              reset5h: isNaN(reset) ? null : reset,
              pct7d: toPct(h[H_7D_UTIL]),
              reset7d: isNaN(reset7) ? null : reset7,
              status: h[H_5H_STATUS] || null,
              error: null,
              checkedAt: now,
            });
          });
        }
      );
      req.on("error", () => finish(empty("net")));
      req.on("timeout", () => {
        req.destroy();
        finish(empty("net"));
      });
      req.write(body);
      req.end();
    });
  }

  /** Refresh cached usage for the active account (activeOnly) or every saved
   *  account. With `refreshTokens`, each account's OAuth token is refreshed first. */
  async refreshUsage(opts: { activeOnly?: boolean; refreshTokens?: boolean } = {}) {
    if (!this.settings.usageProbe || this.usageProbing) return;
    this.usageProbing = true;
    try {
      const cur = this.currentAccountEmail();
      let emails: string[];
      if (opts.activeOnly) {
        emails = cur ? [cur] : [];
      } else {
        const set = new Set(
          this.listSavedAccounts().map((a) => a.email.trim().toLowerCase())
        );
        if (cur) set.add(cur);
        emails = [...set];
      }
      for (const email of emails) {
        if (opts.refreshTokens) await this.refreshAccount(email);
        const token = this.accessTokenFor(email);
        if (!token) {
          this.accountUsage.set(email, {
            pct5h: null,
            reset5h: null,
            pct7d: null,
            reset7d: null,
            status: null,
            error: "auth",
            checkedAt: Date.now(),
          });
          continue;
        }
        const usage = await this.probeUsage(token);
        this.accountUsage.set(email, usage);
        await new Promise((r) => setTimeout(r, 300)); // gentle spacing
      }
      this.updateAutoSwitchBtn();
    } finally {
      this.usageProbing = false;
    }
  }

  /** Fresh probed 5h % for an account, or null if missing/stale/errored. */
  private usagePct(email: string | null): number | null {
    if (!email) return null;
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u || u.error || u.pct5h == null) return null;
    if (Date.now() - u.checkedAt > USAGE_FRESH_MS) return null;
    return u.pct5h;
  }

  /** "Time left until `epoch`" as a short countdown, or "" if missing/past.
   *  Scales the units: days+hours for the 7d window, hours+minutes (or just
   *  minutes) for the 5h window. */
  private resetCountdown(epoch: number | null): string {
    if (!epoch) return "";
    const diff = epoch - Math.floor(Date.now() / 1000);
    if (diff <= 0) return "";
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    return `${m}m`;
  }

  /** Short label for an account's cached usage (plain text, for settings). */
  usageLabel(email: string): string {
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u) return "…";
    if (u.error === "auth") return "expired";
    if (u.error === "rate") return "rate-limited";
    if (u.error) return "unavailable";
    if (u.pct5h == null) return "…";
    let s = "5h " + u.pct5h + "%";
    const cd5 = this.resetCountdown(u.reset5h);
    if (cd5) s += ` (${cd5})`;
    if (u.pct7d != null) {
      s += " · 7d " + u.pct7d + "%";
      const cd7 = this.resetCountdown(u.reset7d);
      if (cd7) s += ` (${cd7})`;
    }
    return s;
  }

  /** Colour for a usage %: green (low/least used) → red (near the limit). */
  private usageColor(pct: number): string {
    if (pct >= 90) return "var(--color-red)";
    if (pct >= 75) return "var(--color-orange)";
    if (pct >= 50) return "var(--color-yellow)";
    return "var(--color-green)";
  }

  /** Aligned, colour-coded title for an account in the 👤 menu. */
  private accountMenuTitle(email: string, emailWidth: number): DocumentFragment {
    const frag = document.createDocumentFragment();
    const seg = (text: string, color?: string) => {
      const s = document.createElement("span");
      s.textContent = text;
      s.style.fontFamily = "var(--font-monospace)";
      s.style.whiteSpace = "pre";
      if (color) s.style.color = color;
      frag.appendChild(s);
    };
    seg(email.padEnd(emailWidth + 2, " "));

    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u || (u.pct5h == null && !u.error)) {
      seg("…", "var(--text-muted)");
      return frag;
    }
    if (u.error === "auth") return (seg("expired", "var(--color-orange)"), frag);
    if (u.error === "rate") return (seg("rate-limited", "var(--color-orange)"), frag);
    if (u.error || u.pct5h == null) return (seg("unavailable", "var(--text-muted)"), frag);

    seg("5h ", "var(--text-muted)");
    seg(String(u.pct5h).padStart(3, " ") + "%", this.usageColor(u.pct5h));

    const cd5 = this.resetCountdown(u.reset5h);
    seg("  " + (cd5 ? `(${cd5})` : "").padEnd(9, " "), "var(--text-muted)");

    if (u.pct7d != null) {
      seg("· 7d ", "var(--text-muted)");
      seg(String(u.pct7d).padStart(3, " ") + "%", this.usageColor(u.pct7d));
      const cd7 = this.resetCountdown(u.reset7d);
      seg("  " + (cd7 ? `(${cd7})` : ""), "var(--text-muted)");
    }
    return frag;
  }

  /** Debounced probe of the active account on terminal activity (≥60s apart). */
  maybeProbeOnActivity() {
    if (!this.settings.usageProbe) return;
    const now = Date.now();
    if (now - this.lastActiveProbe < 60000) return;
    this.lastActiveProbe = now;
    void this.refreshUsage({ activeOnly: true });
  }

  /** Emails of accounts we know about (saved snapshots ∪ the active one). */
  private knownAccountEmails(): Set<string> {
    const set = new Set(this.listSavedAccounts().map((a) => a.email.trim().toLowerCase()));
    const cur = this.currentAccountEmail();
    if (cur) set.add(cur);
    return set;
  }

  /** Compiled usage-% regex (settings override, safe fallback to the default). */
  private usageRegex(): RegExp {
    const src = this.settings.autoSwitchUsageRegex?.trim() || DEFAULT_USAGE_RE;
    try {
      return new RegExp(src);
    } catch {
      return new RegExp(DEFAULT_USAGE_RE);
    }
  }

  /** Process a session's output: track the active account from the status bar
   *  (label + swap verification + auth-fail recovery) and, if enabled, auto-switch
   *  accounts by usage. Fed every `data` chunk from every session; uses that
   *  session's rolling buffer, but the decision state (cooldown, baseline, verify)
   *  is global because the credentials are shared across all instances. */
  maybeAutoSwitch(session: Session, chunk: string) {
    session.autoSwitchBuf = (session.autoSwitchBuf + chunk).slice(-3000);
    const clean = session.autoSwitchBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

    // --- Track the account shown in the status bar -------------------------
    const known = this.knownAccountEmails();
    let barEmail: string | null = null;
    for (const e of clean.match(EMAIL_RE) || []) {
      if (known.has(e.trim().toLowerCase())) barEmail = e.trim().toLowerCase();
    }
    if (barEmail && barEmail !== this.barAccountEmail) {
      this.barAccountEmail = barEmail;
      this.sawStatusSinceSwitch = true;
      if (this.accountBtn) this.accountBtn.title = "Account: " + barEmail;
    } else if (barEmail) {
      this.sawStatusSinceSwitch = true;
    }

    // --- Verify a pending swap actually took effect -----------------------
    if (this.pendingVerifyEmail) {
      if (this.barAccountEmail === this.pendingVerifyEmail) {
        new Notice("✓ Active account: " + this.pendingVerifyEmail);
        this.pendingVerifyEmail = null;
        this.recoverAttempts = 0;
      } else if (Date.now() > this.verifyDeadline) {
        if (this.sawStatusSinceSwitch && this.barAccountEmail) {
          new Notice(
            "Could not confirm switch (still on " + this.barAccountEmail +
              ") — send a message to apply it."
          );
        }
        this.pendingVerifyEmail = null;
      }
    }

    // --- Auth failure after a swap (a saved token may be dead) ------------
    if (Date.now() < this.authWatchUntil && AUTH_FAIL_RE.test(clean)) {
      this.authWatchUntil = 0;
      const bad = this.barAccountEmail || "the account";
      new Notice("Auth failed for " + bad + " — its saved token may be stale. Run /login.");
      if (this.settings.autoSwitch && this.recoverAttempts < this.listSavedAccounts().length) {
        this.recoverAttempts++;
        const next = this.pickNextAccount();
        if (next) this.triggerSwitch(next, "auth failed");
      }
      return;
    }

    // --- Auto-switch decision --------------------------------------------
    const cur = this.currentAccountEmail();
    let pct: number | null = null;
    let src = "none";
    const m = clean.match(this.usageRegex());
    const scraped = m && m[1] !== undefined ? parseInt(m[1], 10) : NaN;
    if (!isNaN(scraped)) {
      if (this.barAccountEmail && this.barAccountEmail !== cur) {
        src = "scrape(anchored-out)";
      } else {
        pct = scraped;
        src = "scrape";
      }
    }
    if (pct == null) {
      pct = this.usagePct(cur);
      if (pct != null) src = "api";
    }

    const decide = (): string => {
      if (!this.settings.autoSwitch) return "auto-switch is OFF";
      const cd = this.autoSwitchCooldownUntil - Date.now();
      if (cd > 0) return `in cooldown (${Math.ceil(cd / 1000)}s left after last switch)`;
      if (LIMIT_RE.test(clean)) {
        this.requestSwitch("limit reached");
        return "switching now — “limit reached” message detected";
      }
      if (pct == null) {
        return src === "scrape(anchored-out)"
          ? "no usable % — status bar shows another account and no fresh API reading"
          : "no usage % available yet (status bar not scraped and no fresh API reading)";
      }
      // Destination that keeps the 10% margin: least-used eligible account still
      // BELOW the ceiling. Falls back to plain round-robin ONLY when we have no
      // fresh usage data at all (can't compare) — if we DO have data but every
      // other account is ≥90%, there is deliberately no target (we stay put).
      const pickMargined = (): string | null => {
        const t = this.leastUsedBelow(SWITCH_CEILING_PCT);
        if (t) return t.email;
        if (!this.haveFreshUsageData()) return this.pickNextAccount();
        return null;
      };
      // Switch to the margined destination, or explain why we stay. `wantReason`
      // is the human reason for the switch; `stayReason` describes staying.
      const switchOrStay = (wantReason: string, stayReason: string): string => {
        const next = pickMargined();
        if (next) {
          this.triggerSwitch(next, wantReason);
          return `switching now — ${wantReason} → ${next}`;
        }
        // No destination: warn only if it's a real config problem (no/blocked
        // accounts), stay quietly if it's just "everyone is maxed".
        if (this.pickNextAccount() == null) this.maybeWarnNoAccounts();
        return stayReason;
      };

      // --- Hard 90% ceiling — overrides the mode/threshold settings. ----------
      // At ≥90% we must move to preserve the 10% margin, but ONLY toward an
      // account that still has room (<90%). If every other account is ≥90% (or
      // none is eligible) we stay and run THIS account to the limit.
      if (pct >= SWITCH_CEILING_PCT) {
        return switchOrStay(
          `at ${pct}% (≥${SWITCH_CEILING_PCT}% cap)`,
          `at ${pct}% (${src}) — every other account is ≥${SWITCH_CEILING_PCT}% (or none eligible); staying to max it out`
        );
      }

      // --- Below 90% — the configured mode/threshold drives the timing. -------
      if (this.settings.autoSwitchMode === "rotate") {
        const delta = this.settings.autoSwitchDelta || 10;
        if (this.rotateBaselinePct === null) {
          this.rotateBaselinePct = pct;
          return `baseline set at ${pct}% — will rotate at ${pct + delta}% (+${delta})`;
        }
        if (pct < this.rotateBaselinePct) {
          this.rotateBaselinePct = pct;
          return `usage dropped → baseline re-based to ${pct}%`;
        }
        const target = this.rotateBaselinePct + delta;
        if (pct < target) {
          return `at ${pct}% (${src}); need ${target}% to rotate (baseline ${this.rotateBaselinePct} +${delta})`;
        }
        return switchOrStay(
          `at ${pct}%`,
          `at ${pct}% — would rotate but no account has margin (<${SWITCH_CEILING_PCT}%); staying`
        );
      }
      const th = this.settings.autoSwitchThreshold;
      if (pct < th) return `at ${pct}% (${src}); threshold is ${th}%`;
      return switchOrStay(
        `at ${pct}%`,
        `at ${pct}% ≥ threshold ${th}% — but no account has margin (<${SWITCH_CEILING_PCT}%); staying`
      );
    };

    const reason = decide();
    this.lastDiagInfo = {
      at: Date.now(),
      mode: this.settings.autoSwitchMode,
      enabled: this.settings.autoSwitch,
      pct,
      src,
      cur,
      bar: this.barAccountEmail,
      baseline: this.rotateBaselinePct,
      delta: this.settings.autoSwitchDelta,
      threshold: this.settings.autoSwitchThreshold,
      savedAccounts: this.listSavedAccounts().length,
      reason,
    };
    if (Date.now() - this.lastAutoSwitchDiag > 4000) {
      this.lastAutoSwitchDiag = Date.now();
      console.log("[cch auto-switch]", this.lastDiagInfo);
    }
  }

  /** Show the last auto-switch evaluation (why no account change fired). */
  private diagnoseAutoSwitch() {
    const d = this.lastDiagInfo;
    if (!d) {
      new Notice(
        "Auto-switch: no reading yet. Use Claude so it prints output (the status line), then run this again."
      );
      return;
    }
    const age = Math.round((Date.now() - d.at) / 1000);
    const lines = [
      "Auto-switch — " + d.reason,
      `• mode: ${d.mode}${d.enabled ? "" : " (disabled)"}`,
      `• usage: ${d.pct == null ? "—" : d.pct + "%"} (source: ${d.src})`,
      d.mode === "rotate"
        ? `• baseline: ${d.baseline == null ? "—" : d.baseline + "%"} · delta: +${d.delta}`
        : `• threshold: ${d.threshold}%`,
      `• active: ${d.cur || "?"} · status bar: ${d.bar || "?"}`,
      `• saved accounts: ${d.savedAccounts}`,
      `(evaluated ${age}s ago)`,
    ];
    new Notice(lines.join("\n"), 12000);
    console.log("[cch auto-switch] diagnose", d);
  }

  /** Pick the next account and switch, or warn once if there aren't ≥2 saved.
   *  Used by the emergency paths (limit-reached / auth-failure) that must move to
   *  any working account regardless of the 10% margin. */
  private requestSwitch(reason: string) {
    const next = this.pickNextAccount();
    if (!next) {
      this.maybeWarnNoAccounts();
      return;
    }
    this.triggerSwitch(next, reason);
  }

  /** Common path for an automatic switch: set cooldown, reset state, notify, swap. */
  private triggerSwitch(next: string, reason: string) {
    this.autoSwitchCooldownUntil = Date.now() + 10000;
    this.rotateBaselinePct = null; // recapture baseline for the new account
    new Notice(`Claude account ${reason} — switching to ${next}…`);
    this.switchToAccount(next);
  }

  /** Open the remote session URL in the browser mapped to the active Claude
   *  account. Returns a human label for the notice. */
  openInBrowser(url: string): string {
    const email = this.currentAccountEmail();
    const map = this.settings.browserMap.find(
      (m) => m.email.trim().toLowerCase() === email && !!email
    );
    const browser = map?.browser || this.settings.defaultBrowser || "chrome";
    return this.launchBrowser(browser, map?.path || "", url);
  }

  /** Launch a specific browser with the URL (new tab in the running instance). */
  private launchBrowser(browser: string, customPath: string, url: string): string {
    const openDefault = () => {
      try {
        nodeRequire("electron")?.shell?.openExternal(url);
      } catch {
        /* nothing else to try; the URL is still on the clipboard */
      }
    };
    try {
      const cp = nodeRequire("child_process");
      const fs = nodeRequire("fs");
      const expand = (p: string) =>
        p.replace(/%([^%]+)%/g, (_, v) => (process.env as any)[v] || "");

      if (browser === "default") {
        openDefault();
        return "default browser";
      }
      if (browser === "custom") {
        if (customPath) {
          cp.spawn(customPath, [url], { detached: true, stdio: "ignore" }).unref();
          this.focusFullscreen(path.basename(customPath).replace(/\.exe$/i, ""));
          return path.basename(customPath);
        }
        openDefault();
        return "default browser";
      }
      const def = BROWSERS[browser];
      if (!def) {
        openDefault();
        return "default browser";
      }
      const exe = def.exes
        .map(expand)
        .find((p: string) => {
          try {
            return p && fs.existsSync(p);
          } catch {
            return false;
          }
        });
      if (exe) {
        cp.spawn(exe, [url], { detached: true, stdio: "ignore" }).unref();
      } else {
        cp.spawn("cmd", ["/c", "start", def.alias, url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      }
      this.focusFullscreen(def.proc);
      return def.label;
    } catch {
      openDefault();
      return "default browser";
    }
  }

  /** Bring the just-launched browser window to the foreground and toggle
   *  fullscreen (F11). Best-effort, fire-and-forget. */
  private focusFullscreen(proc: string) {
    if (!proc) return;
    try {
      const cp = nodeRequire("child_process");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        "Start-Sleep -Milliseconds 1800",
        `$p = Get-Process '${proc}' -ErrorAction SilentlyContinue | ` +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "Sort-Object StartTime -Descending | Select-Object -First 1",
        "if ($p) {",
        "  $w = New-Object -ComObject WScript.Shell",
        "  $w.AppActivate($p.Id) | Out-Null",
        "  Start-Sleep -Milliseconds 350",
        "  $w.SendKeys('{F11}')",
        "}",
      ].join("; ");
      cp.spawn(
        "powershell",
        ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        { detached: true, stdio: "ignore", windowsHide: true }
      ).unref();
    } catch {
      /* best-effort */
    }
  }

  // --- Header (tabs + toolbar) -------------------------------------------

  /** Build the panel header: a row of session tabs (each with a close ×, plus a
   *  + button to spawn a new instance) over the toolbar (@ · model · account ·
   *  skill · remote · auto-switch · zoom · settings · restart). The toolbar acts
   *  on the ACTIVE session. Rebuilt whenever the active session or the set of
   *  sessions changes; the terminal host is appended after it. */
  private buildHeader(container: HTMLElement) {
    // Drop stale references from a previous build (a hidden button stays null).
    this.modelBtn = null;
    this.skillBtn = null;
    this.accountBtn = null;
    this.remoteBtn = null;
    this.autoSwitchBtn = null;
    this.zoomLabel = null;

    const header = container.createDiv({ cls: "cch-header" });
    const s = this.settings;

    // --- Tab strip: one tab per session + a "new session" button. ---
    const tabs = header.createDiv({ cls: "cch-tabs" });
    this.sessions.forEach((sess, i) => {
      const tab = tabs.createDiv({
        cls: "cch-tab" + (i === this.activeIndex ? " cch-tab-active" : ""),
      });
      const dotCls = sess.exited ? "is-exited" : sess.busy ? "is-busy" : "is-idle";
      const dot = tab.createSpan({ cls: "cch-tab-dot " + dotCls });
      dot.setAttr("aria-label", sess.exited ? "Exited" : sess.busy ? "Working…" : "Idle");
      const label = tab.createSpan({
        cls: "cch-tab-label" + (sess.exited ? " cch-tab-exited" : ""),
        text: sess.title || "Claude",
      });
      // Double-click the label to rename the tab manually (overrides auto-title).
      label.ondblclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startTabRename(tab, label, sess);
      };
      const close = tab.createSpan({ cls: "cch-tab-close" });
      setIcon(close, "x");
      close.setAttr("aria-label", "Close session");
      close.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeSession(sess);
      };
      // Pointer-based interactive reorder (Chrome-style: siblings slide out of
      // the way as you drag). A plain click (no drag) activates the tab.
      tab.addEventListener("pointerdown", (e) => this.beginTabDrag(e, tabs, i));
    });
    const add = tabs.createEl("button", { cls: "cch-btn cch-tab-new" });
    setIcon(add, "plus");
    add.setAttr("aria-label", "New Claude session");
    add.title = "New Claude session";
    add.onclick = (e) => {
      e.preventDefault();
      this.openNewSessionMenu(add);
    };

    // --- Toolbar: buttons that act on the active session / global state. ---
    const bar = header.createDiv({ cls: "cch-toolbar" });
    const iconBtn = (icon: string, title: string, onClick: () => void) => {
      const b = bar.createEl("button", { cls: "cch-btn" });
      setIcon(b, icon);
      b.setAttr("aria-label", title);
      b.title = title;
      b.onclick = (e) => {
        e.preventDefault();
        onClick();
      };
    };

    // Left corner: mention the active note with @.
    if (s.btnSendNote) {
      iconBtn("at-sign", "Send active note to Claude", () =>
        void this.sendActiveNote()
      );
    }
    bar.createDiv({ cls: "cch-spacer" });

    // Model selector (active session's model).
    if (s.btnModel) {
      const id = this.activeSession()?.model ?? s.model;
      const modelBtn = bar.createEl("button", {
        cls: "cch-btn cch-model",
        text: MODELS.find((m) => m.id === id)?.label ?? "Model",
      });
      modelBtn.title = "Select model";
      this.modelBtn = modelBtn;
      modelBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        const a = this.activeSession();
        for (const m of MODELS) {
          menu.addItem((item) =>
            item
              .setTitle(m.label)
              .setChecked((a?.model ?? s.model) === m.id)
              .onClick(() => a?.selectModel(m.id, m.label))
          );
        }
        const r = modelBtn.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      };
    }

    // Account: save the current Claude account / switch to a saved one (global).
    if (s.btnAccount) {
      const accountBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(accountBtn, "user-round");
      this.accountBtn = accountBtn;
      const curEmail = this.barAccountEmail || this.currentAccountEmail();
      accountBtn.setAttr("aria-label", "Claude account");
      accountBtn.title = "Account: " + (curEmail || "unknown");
      accountBtn.onclick = (e) => {
        e.preventDefault();
        this.openAccountMenu(accountBtn);
      };
    }

    // Skill selector (active session's skill).
    if (s.btnSkill) {
      const skillBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(skillBtn, "sparkles");
      const cur = this.activeSession()?.skill ?? s.skill;
      skillBtn.setAttr("aria-label", "Skill");
      skillBtn.title = "Skill: " + (cur || "none");
      this.skillBtn = skillBtn;
      skillBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        const a = this.activeSession();
        const skills = this.listSkills();
        if (!skills.length) {
          menu.addItem((item) =>
            item.setTitle("No skills in .claude/skills").setDisabled(true)
          );
        } else {
          for (const sk of skills) {
            menu.addItem((item) =>
              item
                .setTitle(sk)
                .setChecked((a?.skill ?? s.skill) === sk)
                .onClick(() => a?.selectSkill(sk))
            );
          }
        }
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Open skills folder")
            .setIcon("folder-open")
            .onClick(() => this.openSkillsFolder())
        );
        const r = skillBtn.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      };
    }

    // Remote control toggle (active session; green while ON).
    if (s.btnRemote) {
      const remoteBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(remoteBtn, "smartphone");
      this.remoteBtn = remoteBtn;
      remoteBtn.onclick = (e) => {
        e.preventDefault();
        this.activeSession()?.toggleRemoteControl();
      };
      this.updateRemoteBtn();
    }

    // Auto-switch toggle + mode/percentage picker (global; green while ON).
    if (s.btnAutoSwitch) {
      const asBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(asBtn, "repeat");
      this.autoSwitchBtn = asBtn;
      asBtn.onclick = (e) => {
        e.preventDefault();
        this.openAutoSwitchMenu(asBtn);
      };
      this.updateAutoSwitchBtn();
    }

    // Token Dashboard: launch the bundled local usage dashboard and open it in
    // the default browser (global; equivalent to the old "Lanzar Token Dashboard.bat").
    if (s.btnTokenDashboard) {
      const tdBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(tdBtn, "bar-chart-3");
      tdBtn.setAttr("aria-label", "Token Dashboard");
      tdBtn.title = "Open Token Dashboard (token usage)";
      tdBtn.onclick = (e) => {
        e.preventDefault();
        void this.launchTokenDashboard();
      };
    }

    if (s.btnZoom) {
      iconBtn("minus", "Zoom out (Ctrl -)", () => this.zoomBy(-1));
      const zl = bar.createEl("button", {
        cls: "cch-btn cch-zoom",
        text: (this.settings.fontSize || 14) + "px",
      });
      zl.title = "Reset zoom (Ctrl 0)";
      zl.onclick = () => this.setFontSize(14);
      this.zoomLabel = zl;
      iconBtn("plus", "Zoom in (Ctrl +)", () => this.zoomBy(1));
    }

    iconBtn("settings", "Plugin settings", () => this.openSettings());
    iconBtn("rotate-ccw", "Restart session", () => this.activeSession()?.restart());

    // Keep the header as the first child so it survives a rebuild (rebuildHeader
    // removes the old one and calls this while the terminal host is already in).
    container.prepend(header);
  }

  /** Menu shown by the + tab button: spawn a new session with a chosen skill. */
  private openNewSessionMenu(anchor: HTMLElement) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("New session (default skill)")
        .setIcon("plus")
        .onClick(() => this.newSession())
    );
    menu.addItem((item) =>
      item.setTitle("New session (no skill)").onClick(() => this.newSession({ skill: "" }))
    );
    const skills = this.listSkills();
    if (skills.length) {
      menu.addSeparator();
      for (const sk of skills) {
        menu.addItem((item) =>
          item.setTitle("New: /" + sk).onClick(() => this.newSession({ skill: sk }))
        );
      }
    }
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom });
  }

  /** Rebuild the header in the open panel (tabs + toolbar), preserving the
   *  mounted terminal host. Also called from the settings tab as refreshHeader. */
  rebuildHeader() {
    if (!this.viewRoot) return;
    this.viewRoot.querySelector(".cch-header")?.remove();
    this.buildHeader(this.viewRoot);
  }

  refreshHeader() {
    this.rebuildHeader();
  }

  /** Update just the tab labels in place (cheap; avoids a full header rebuild on
   *  every auto-title change). Labels are in session order, so index aligns. */
  refreshTabTitles() {
    if (!this.viewRoot) return;
    const labels = this.viewRoot.findAll(".cch-tabs .cch-tab-label");
    this.sessions.forEach((sess, i) => labels[i]?.setText(sess.title || "Claude"));
  }

  /** Update the per-tab heartbeat dot in place (busy / idle / exited) without a
   *  full header rebuild. Dots are in session order, so index aligns. */
  refreshTabStatus() {
    if (!this.viewRoot) return;
    const dots = this.viewRoot.findAll(".cch-tabs .cch-tab-dot");
    this.sessions.forEach((sess, i) => {
      const dot = dots[i];
      if (!dot) return;
      dot.removeClasses(["is-busy", "is-idle", "is-exited"]);
      const state = sess.exited ? "is-exited" : sess.busy ? "is-busy" : "is-idle";
      dot.addClass(state);
      dot.setAttr("aria-label", sess.exited ? "Exited" : sess.busy ? "Working…" : "Idle");
    });
  }

  /** Inline-edit a tab title (double-click). Commits on Enter/blur as a "manual"
   *  title (which outranks the auto sources), cancels on Escape. */
  private startTabRename(tab: HTMLElement, label: HTMLElement, sess: Session) {
    if (tab.querySelector("input.cch-tab-rename")) return; // already editing
    tab.setAttr("draggable", "false"); // don't fight text selection while editing
    const input = document.createElement("input");
    input.type = "text";
    input.addClass("cch-tab-rename");
    input.value = sess.title || "";
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) sess.setTitleFrom(input.value, "manual");
      this.rebuildHeader();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    };
    input.onblur = () => commit(true);
  }

  // --- Node / paths -------------------------------------------------------

  /** Find a real node.exe to fork the pty host with. */
  resolveNodePath(): string {
    const isWin = process.platform === "win32";
    let fs: any;
    try {
      fs = nodeRequire("fs");
    } catch {
      return isWin ? "node.exe" : "node";
    }
    const set = this.settings.nodePath?.trim();
    if (set && fs.existsSync(set)) return set;

    const candidates = isWin
      ? [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files (x86)\\nodejs\\node.exe",
        ]
      : ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* ignore */
      }
    }

    try {
      const cp = nodeRequire("child_process");
      const cmd = isWin ? "where node" : "command -v node";
      const found = cp
        .execSync(cmd, { encoding: "utf8" })
        .split(/\r?\n/)[0]
        .trim();
      if (found && fs.existsSync(found)) return found;
    } catch {
      /* not found via PATH */
    }
    return isWin ? "node.exe" : "node";
  }

  pluginDir(): string {
    return path.join(
      this.vaultPath(),
      this.app.vault.configDir,
      "plugins",
      "claude-code-harness"
    );
  }

  /**
   * Resolve a python interpreter to run the bundled Token Dashboard. Modeled on
   * resolveNodePath(): manual setting -> known install locations -> `where
   * python` / `where py` (Windows launcher) -> bare command on PATH.
   */
  resolvePythonPath(): string {
    const isWin = process.platform === "win32";
    let fs: any;
    try {
      fs = nodeRequire("fs");
    } catch {
      return isWin ? "python" : "python3";
    }
    const set = this.settings.pythonPath?.trim();
    if (set && fs.existsSync(set)) return set;

    const expand = (p: string) =>
      p.replace(/%([^%]+)%/g, (_, v) => (process.env as any)[v] || "");

    if (isWin) {
      const bases = [
        expand("%LOCALAPPDATA%\\Programs\\Python"),
        "C:\\Program Files\\Python",
        "C:\\",
      ];
      for (const base of bases) {
        try {
          if (!base || !fs.existsSync(base)) continue;
          for (const name of fs.readdirSync(base)) {
            if (!/^Python3?\d*/i.test(name)) continue;
            const exe = path.join(base, name, "python.exe");
            if (fs.existsSync(exe)) return exe;
          }
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const c of ["/usr/local/bin/python3", "/usr/bin/python3", "/opt/homebrew/bin/python3"]) {
        try {
          if (fs.existsSync(c)) return c;
        } catch {
          /* ignore */
        }
      }
    }

    try {
      const cp = nodeRequire("child_process");
      const cmds = isWin ? ["where python", "where py"] : ["command -v python3", "command -v python"];
      for (const cmd of cmds) {
        try {
          const found = cp
            .execSync(cmd, { encoding: "utf8" })
            .split(/\r?\n/)[0]
            .trim();
          if (found && fs.existsSync(found)) return found;
          // `where py` returns the launcher path; if found but odd, still usable.
          if (found && /\bpy(\.exe)?$/i.test(found)) return found;
        } catch {
          /* try next */
        }
      }
    } catch {
      /* not found via PATH */
    }
    return isWin ? "python" : "python3";
  }

  /**
   * Start the bundled Token Dashboard (Python stdlib HTTP server on
   * 127.0.0.1:8080) and open it in the default browser. Equivalent to the old
   * "Lanzar Token Dashboard.bat". Reuses an already-running server if present.
   */
  async launchTokenDashboard() {
    const url = "http://127.0.0.1:8080/";
    const openBrowser = () => {
      try {
        nodeRequire("electron")?.shell?.openExternal(url);
      } catch {
        /* best-effort */
      }
    };

    // Server already running from a previous click — just open a tab.
    if (this.tokenDashboardChild && this.tokenDashboardChild.exitCode === null) {
      openBrowser();
      return;
    }

    let cp: any;
    try {
      cp = nodeRequire("child_process");
    } catch (e: any) {
      new Notice("Token Dashboard: failed to load child_process: " + (e?.message ?? e));
      return;
    }

    const cwd = path.join(this.pluginDir(), "token-dashboard");
    const python = this.resolvePythonPath();

    let child: any;
    try {
      // -u keeps Python's stdout unbuffered so we see the "listening" line
      // promptly (otherwise it's buffered when piped and the browser only
      // opens via the slower HTTP-poll fallback).
      child = cp.spawn(python, ["-u", "cli.py", "dashboard", "--no-open"], {
        cwd,
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      new Notice(
        "Token Dashboard: could not start Python (" +
          python +
          "). Install Python or set its path in settings.\n" +
          (e?.message ?? e)
      );
      return;
    }

    this.tokenDashboardChild = child;
    new Notice("Token Dashboard: starting… (the first run scans sessions, ~1 min)");

    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      openBrowser();
    };

    child.on("error", (e: any) => {
      if (e?.code === "ENOENT") {
        new Notice(
          "Token Dashboard: Python not found (" +
            python +
            "). Install Python or set its path in plugin settings."
        );
      } else {
        new Notice("Token Dashboard error: " + (e?.message ?? e));
      }
      this.tokenDashboardChild = null;
    });

    child.on("exit", () => {
      this.tokenDashboardChild = null;
    });

    // Open the browser as soon as the server reports it is listening.
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (d: string) => {
      if (/listening on/i.test(String(d))) openOnce();
    });

    // Surface fatal startup errors (e.g. missing module) to the user.
    let errBuf = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (d: string) => {
      errBuf = (errBuf + String(d)).slice(-2000);
    });
    child.on("exit", (code: number) => {
      if (!opened && code && code !== 0) {
        new Notice(
          "Token Dashboard exited (code " + code + ").\n" + (errBuf.trim() || "")
        );
      }
    });

    // Fallback: poll the port for up to ~90s in case stdout is buffered.
    const http = nodeRequire("http");
    const started = Date.now();
    const poll = () => {
      if (opened || Date.now() - started > 90000) return;
      const req = http.get(url, (res: any) => {
        res.destroy?.();
        openOnce();
      });
      req.on("error", () => setTimeout(poll, 1500));
      req.setTimeout?.(2000, () => req.destroy());
    };
    setTimeout(poll, 2000);
  }

  /** Terminal theme derived from the active Obsidian theme. */
  termTheme() {
    const s = getComputedStyle(document.body);
    const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb;
    const dark = !document.body.classList.contains("theme-light");
    const ansi = dark ? ANSI_DARK : ANSI_LIGHT;
    const bg = v("--background-primary", dark ? "#1e1e1e" : "#ffffff");
    const fg = v("--text-normal", dark ? "#dcddde" : "#1c1c1c");
    return {
      ...ansi,
      background: bg,
      foreground: fg,
      cursor: v("--text-accent", dark ? "#4a9eff" : "#1d72c4"),
      cursorAccent: bg,
      selectionBackground: v("--text-selection", dark ? "#33415e" : "#d3dee9"),
      selectionForeground: fg,
    };
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE, active: true });
      leaf = right;
    }
    workspace.revealLeaf(leaf);
  }

  vaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  // --- Clickable note references in the terminal --------------------------

  /** Resolve a link text (note name, possibly `Name|alias` / `Name#heading`) to
   *  an existing .md note in the vault, or null. */
  private resolveNote(name: string): TFile | null {
    const clean = name
      .trim()
      .replace(/^\[\[+/, "")
      .replace(/\]\]+$/, "")
      .split("|")[0]
      .split("#")[0]
      .trim();
    if (!clean) return null;
    const f = this.app.metadataCache.getFirstLinkpathDest(clean, "");
    return f && f.extension === "md" ? f : null;
  }

  /** Open a note referenced from the terminal (Ctrl/Cmd-click = new tab). */
  openNoteLink(linktext: string, ev: MouseEvent) {
    const f = this.resolveNote(linktext);
    if (!f) return;
    const newTab = !!ev && (ev.ctrlKey || ev.metaKey);
    void this.app.workspace.openLinkText(f.path, "", newTab ? "tab" : false);
  }

  /** xterm link provider: turn note references in Claude's output into clickable
   *  links that open the matching .md note. Detects: (1) `[[wikilinks]]` (any
   *  colour) and (2) CONTIGUOUS COLOURED runs (Claude renders bare references in a
   *  non-default fg) that resolve to a note.
   *
   *  Handles names split across lines. Claude wraps long text ITSELF with real
   *  newlines + a 2-space indent on the continuation (so the next row is NOT an
   *  xterm soft-wrap / `isWrapped`), splitting a name at a word boundary. We
   *  reconstruct the contiguous block of non-blank rows around `y` joined with a
   *  single space (collapsing each row's indentation), match over the joined text,
   *  and emit ONE single-row link per row a match touches — returning only the
   *  segment on the queried row `y` (multi-row/off-line ranges break xterm). */
  computeNoteLinks(term: Terminal, y: number): ILink[] | undefined {
    if (!this.settings.linkifyNotes || !term) return undefined;
    const buf = term.buffer.active;
    const isBlank = (row: number) => {
      const ln = buf.getLine(row - 1);
      return !ln || ln.translateToString(true).trim() === "";
    };
    if (isBlank(y)) return undefined;

    // Contiguous block of non-blank rows around y (bounded), to bridge the hard
    // newlines Claude inserts when wrapping a long reference.
    let top = y;
    for (let r = y - 1; r >= 1 && y - r <= 6 && !isBlank(r); r--) top = r;
    let bot = y;
    for (let r = y + 1; r <= buf.length && r - y <= 6 && !isBlank(r); r++) bot = r;

    // Reconstruct: row contents (indent + trailing spaces trimmed) joined by a
    // single space. Track the cell column/row and colour of each char so matches
    // map back to screen coordinates. The join space inherits the previous row's
    // last column (so it merges into that row's segment) and is "coloured" only
    // when both sides are, so a coloured name split across rows rejoins as one run.
    let text = "";
    const cx: number[] = [];
    const cy: number[] = [];
    const colored: boolean[] = [];
    const isJoin: boolean[] = []; // true for the synthetic space inserted at a wrap
    let havePrev = false;
    let prevX = 0;
    let prevRow = 0;
    let prevColored = false;
    for (let row = top; row <= bot; row++) {
      const line = buf.getLine(row - 1);
      if (!line) continue;
      const rc: { ch: string; x: number; col: boolean }[] = [];
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x);
        if (!c || c.getWidth() === 0) continue;
        const chars = c.getChars() || " ";
        const col = !c.isFgDefault();
        for (const ch of chars) rc.push({ ch, x, col });
      }
      let s = 0;
      let e = rc.length - 1;
      while (s <= e && rc[s].ch === " ") s++;
      while (e >= s && rc[e].ch === " ") e--;
      if (s > e) continue; // blank row
      if (havePrev) {
        text += " ";
        cx.push(prevX);
        cy.push(prevRow);
        colored.push(prevColored && rc[s].col);
        isJoin.push(true);
      }
      for (let k = s; k <= e; k++) {
        text += rc[k].ch;
        cx.push(rc[k].x);
        cy.push(row);
        colored.push(rc[k].col);
        isJoin.push(false);
      }
      havePrev = true;
      prevX = rc[e].x;
      prevRow = row;
      prevColored = rc[e].col;
    }
    if (!text.trim()) return undefined;

    const links: ILink[] = [];
    const taken: boolean[] = new Array(text.length).fill(false);
    // Emit a match [s,e) as one single-row link per row it spans, keeping only the
    // segment on the queried row y.
    const add = (s: number, e: number, target: string) => {
      for (let i = s; i < e; i++) if (taken[i]) return; // no overlaps
      for (let i = s; i < e; i++) taken[i] = true;
      let k = s;
      while (k < e) {
        const row = cy[k];
        let j = k;
        while (j < e && cy[j] === row) j++;
        if (row === y) {
          links.push({
            text: target,
            range: { start: { x: cx[k] + 1, y: row }, end: { x: cx[j - 1] + 1, y: row } },
            decorations: { pointerCursor: true, underline: true },
            activate: (ev: MouseEvent) => this.openNoteLink(target, ev),
          });
        }
        k = j;
      }
    };

    // Resolve a candidate over [s,e). Claude HARD-wraps at a fixed width, often
    // mid-word, so the synthetic join spaces we inserted may or may not belong in
    // the real name ("se|supone" needs the space; "inves|tigación" must not). Try
    // the candidate as-is, then with each subset of its join spaces removed, and
    // return the variant that resolves to an existing note (or null).
    const resolveSpan = (s: number, e: number, raw: string): string | null => {
      if (this.resolveNote(raw)) return raw;
      const joins: number[] = [];
      for (let i = s; i < e; i++) if (isJoin[i]) joins.push(i - s);
      const n = joins.length;
      if (!n || n > 4) return null; // cap the combinations
      for (let mask = 1; mask < 1 << n; mask++) {
        let v = "";
        for (let k = 0; k < raw.length; k++) {
          const ji = joins.indexOf(k);
          if (ji >= 0 && mask & (1 << ji)) continue; // drop this join space
          v += raw[k];
        }
        if (this.resolveNote(v)) return v;
      }
      return null;
    };

    // 1) [[wikilinks]] (resolve to an existing note) — colour-independent.
    const wl = /\[\[([^\]\n]+?)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wl.exec(text))) {
      const s = m.index;
      const e = m.index + m[0].length;
      const target = resolveSpan(s, e, m[0]);
      if (target) add(s, e, target);
    }

    // 2) Coloured runs → whole run, else separator-split pieces, with surrounding
    //    punctuation trimmed.
    const PUNCT = "\\s.,;:!¡¿?()\\[\\]{}\"'«»`*<>→·•|";
    const leadRe = new RegExp("^[" + PUNCT + "]+");
    const trailRe = new RegExp("[" + PUNCT + "]+$");
    const matchPiece = (piece: string, baseOffset: number) => {
      const lead = piece.match(leadRe)?.[0].length ?? 0;
      const inner = piece.slice(lead).replace(trailRe, "");
      if (!inner) return;
      const s = baseOffset + lead;
      const target = resolveSpan(s, s + inner.length, inner);
      if (target) add(s, s + inner.length, target);
    };
    let i = 0;
    while (i < text.length) {
      if (!colored[i]) {
        i++;
        continue;
      }
      const runStart = i;
      while (i < text.length && colored[i]) i++;
      const runText = text.slice(runStart, i);
      matchPiece(runText, runStart);
      let off = 0;
      for (const piece of runText.split(/([,;|·•]+)/)) {
        if (!/^[,;|·•]+$/.test(piece)) matchPiece(piece, runStart + off);
        off += piece.length;
      }
    }

    return links.length ? links : undefined;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class ClaudeCodeView extends ItemView {
  plugin: ClaudeCodeHarnessPlugin;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodeHarnessPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Claude Code";
  }

  getIcon() {
    return "terminal";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("claude-code-harness");
    this.plugin.attachView(root);
    this.resizeObserver = new ResizeObserver(() => this.plugin.onContainerResize());
    this.resizeObserver.observe(root);
  }

  async onClose() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    // Detach the terminal but leave the claude processes running on the plugin.
    this.plugin.detachView();
  }
}

class HarnessSettingTab extends PluginSettingTab {
  plugin: ClaudeCodeHarnessPlugin;

  constructor(app: App, plugin: ClaudeCodeHarnessPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Command")
      .setDesc(
        "Command run inside the terminal when the session starts. Defaults to 'claude'."
      )
      .addText((text) =>
        text
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.command)
          .onChange(async (value) => {
            this.plugin.settings.command = value.trim() || "claude";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Extra arguments")
      .setDesc(
        'Appended to the claude command. E.g. --model opus --append-system-prompt "Be concise".'
      )
      .addText((text) =>
        text
          .setPlaceholder('--append-system-prompt "..."')
          .setValue(this.plugin.settings.args)
          .onChange(async (value) => {
            this.plugin.settings.args = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Startup commands")
      .setDesc(
        "Slash commands run at session start, one per line, BEFORE the skill. E.g. /remote-control."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.startupCommands).onChange(
          async (value) => {
            this.plugin.settings.startupCommands = value;
            await this.plugin.saveSettings();
          }
        );
        ta.inputEl.rows = 2;
        ta.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Skill")
      .setDesc(
        "Default Claude Code skill invoked as /<name> when a new session starts (after the startup commands). Skills live in the vault's .claude/skills — add your own there, or pick one per-session from the panel header."
      )
      .addDropdown((d) => {
        d.addOption("", "(none)");
        for (const s of this.plugin.listSkills()) {
          d.addOption(s, s);
        }
        d.setValue(this.plugin.settings.skill || "");
        d.onChange(async (value) => {
          this.plugin.settings.skill = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Notify on bell")
      .setDesc(
        "Show an Obsidian notice when the terminal rings the bell — Claude tends to ring it when a long task finishes."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.notifyOnBell).onChange(async (v) => {
          this.plugin.settings.notifyOnBell = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Clickable note links")
      .setDesc(
        "Turn coloured note references in Claude's output (and [[wikilinks]]) into clickable links that open the matching .md note. Hover to underline, click to open (Ctrl/Cmd-click for a new tab)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.linkifyNotes).onChange(async (v) => {
          this.plugin.settings.linkifyNotes = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("[[ note suggester")
      .setDesc(
        "Type [[ in the terminal to open Obsidian's note picker at the cursor — the same suggestions you'd get typing [[ in a note. Arrows to move, Enter/Tab/click to pick, Escape to cancel. Picking a note replaces [[query with an @<path> reference (Claude Code's file-reference syntax)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.wikilinkPicker).onChange(async (v) => {
          this.plugin.settings.wikilinkPicker = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Claude accounts")
      .setDesc(
        "Accounts are saved automatically when you log in with /login. Switch between them here or from the header — it hot-swaps ~/.claude/.credentials.json with no restart, so every running session keeps going and uses the new account on its next message. Saved under ~/.claude/cch-accounts (never committed)."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Save current account")
      .setDesc("Snapshot the account currently logged in (read from ~/.claude.json).")
      .addButton((b) =>
        b.setButtonText("Save current account").onClick(() => {
          this.plugin.saveCurrentAccount();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Auto-switch on usage")
      .setDesc(
        "Switch saved accounts automatically based on the 5h usage % (read from the status line). It hot-swaps the credentials with no restart, so the running turn isn't interrupted — the new account applies to the next message. Needs at least 2 saved accounts."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSwitch).onChange(async (v) => {
          this.plugin.settings.autoSwitch = v;
          this.plugin.resetRotationBaseline();
          await this.plugin.saveSettings();
          this.plugin.updateAutoSwitchBtn();
          if (v) {
            void this.plugin.refreshUsage({ refreshTokens: true });
            if (this.plugin.listSavedAccounts().length < 2) {
              new Notice(
                "Auto-switch needs at least 2 saved accounts — log in with /login to save more."
              );
            }
          }
        })
      );

    new Setting(containerEl)
      .setName("Auto-switch mode")
      .setDesc(
        "Threshold: switch when usage reaches a fixed %. Rotate by increment: switch every time usage rises by a set amount, distributing spend across all accounts."
      )
      .addDropdown((d) => {
        d.addOption("threshold", "Threshold (fixed %)");
        d.addOption("rotate", "Rotate by increment");
        d.setValue(this.plugin.settings.autoSwitchMode || "threshold");
        d.onChange(async (v) => {
          this.plugin.settings.autoSwitchMode = v;
          this.plugin.resetRotationBaseline();
          await this.plugin.saveSettings();
          this.plugin.updateAutoSwitchBtn();
          this.display(); // swap which slider is shown
        });
      });

    if ((this.plugin.settings.autoSwitchMode || "threshold") === "rotate") {
      const deltaSetting = new Setting(containerEl)
        .setName("Switch every +% — " + (this.plugin.settings.autoSwitchDelta || 10) + "%")
        .setDesc(
          "Increment in 5h usage since the account became active that triggers a rotation to the next account."
        )
        .addSlider((s) =>
          s
            .setLimits(1, 50, 1)
            .setValue(this.plugin.settings.autoSwitchDelta || 10)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.autoSwitchDelta = v;
              await this.plugin.saveSettings();
              this.plugin.updateAutoSwitchBtn();
              deltaSetting.setName("Switch every +% — " + v + "%");
            })
        );
    } else {
      const thresholdSetting = new Setting(containerEl)
        .setName(
          "Switch at usage % — " + (this.plugin.settings.autoSwitchThreshold || 90) + "%"
        )
        .setDesc("Usage % of the 5h limit at which to switch to the next account.")
        .addSlider((s) =>
          s
            .setLimits(50, 99, 1)
            .setValue(this.plugin.settings.autoSwitchThreshold || 90)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.autoSwitchThreshold = v;
              await this.plugin.saveSettings();
              this.plugin.updateAutoSwitchBtn();
              thresholdSetting.setName("Switch at usage % — " + v + "%");
            })
        );
    }

    new Setting(containerEl)
      .setName("Live usage (API)")
      .setDesc(
        "Read the real 5h/7d usage % from the Anthropic API (rate-limit headers) instead of only scraping the status bar, and probe every saved account so their % shows in the account menu. Makes tiny per-account calls with each account's saved token. Off = scraping only."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.usageProbe).onChange(async (v) => {
          this.plugin.settings.usageProbe = v;
          await this.plugin.saveSettings();
          if (v) void this.plugin.refreshUsage({});
        })
      );

    new Setting(containerEl)
      .setName("Usage probe model (advanced)")
      .setDesc(
        "Model id for the minimal usage probe call. Leave empty for the default: " +
          USAGE_PROBE_MODEL
      )
      .addText((t) =>
        t
          .setPlaceholder(USAGE_PROBE_MODEL)
          .setValue(this.plugin.settings.usageProbeModel)
          .onChange(async (v) => {
            this.plugin.settings.usageProbeModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Usage % pattern (advanced)")
      .setDesc(
        "Regex to read the 5h usage % from the status line, used as a fallback when Live usage is off or the API call fails (needs a capture group). Leave empty for the default: " +
          DEFAULT_USAGE_RE
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_USAGE_RE)
          .setValue(this.plugin.settings.autoSwitchUsageRegex)
          .onChange(async (v) => {
            this.plugin.settings.autoSwitchUsageRegex = v.trim();
            await this.plugin.saveSettings();
          })
      );

    for (const a of this.plugin.listSavedAccounts()) {
      const name = this.plugin.settings.usageProbe
        ? a.email + " — " + this.plugin.usageLabel(a.email)
        : a.email;
      const eligible = this.plugin.isAccountEligible(a.email);
      new Setting(containerEl)
        .setName(name)
        .setDesc(
          eligible
            ? "Auto-switch: allowed"
            : "Auto-switch: blocked (e.g. a friend's account — its tokens won't be spent automatically)"
        )
        .addExtraButton((b) =>
          b
            .setIcon(eligible ? "repeat" : "ban")
            .setTooltip(
              eligible
                ? "Eligible for auto-switch — click to block"
                : "Blocked from auto-switch — click to allow"
            )
            .onClick(async () => {
              await this.plugin.toggleAccountEligible(a.email);
              this.display();
            })
        )
        .addButton((b) =>
          b.setButtonText("Switch").onClick(() => this.plugin.switchToAccount(a.email))
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Delete saved account")
            .onClick(() => {
              this.plugin.deleteSavedAccount(a.email);
              this.display();
            })
        );
    }

    new Setting(containerEl).setName("Header buttons").setHeading();
    const buttonToggle = (
      name: string,
      key:
        | "btnSendNote"
        | "btnAccount"
        | "btnModel"
        | "btnSkill"
        | "btnRemote"
        | "btnAutoSwitch"
        | "btnTokenDashboard"
        | "btnZoom"
    ) =>
      new Setting(containerEl).setName(name).addToggle((t) =>
        t.setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
          this.plugin.refreshHeader();
        })
      );
    buttonToggle("Send active note (@)", "btnSendNote");
    buttonToggle("Account switcher", "btnAccount");
    buttonToggle("Model selector", "btnModel");
    buttonToggle("Skill selector", "btnSkill");
    buttonToggle("Remote control", "btnRemote");
    buttonToggle("Auto-switch toggle", "btnAutoSwitch");
    buttonToggle("Token Dashboard", "btnTokenDashboard");
    buttonToggle("Zoom controls", "btnZoom");

    new Setting(containerEl)
      .setName("Remote control — browser per account")
      .setDesc(
        "The remote session URL only works in the browser where that Claude account is logged in. Map each account email (the active one is read from ~/.claude.json) to a browser. Unmapped accounts use the default below."
      )
      .setHeading();

    const browserOptions: Record<string, string> = {
      chrome: "Chrome",
      firefox: "Firefox",
      edge: "Edge",
      brave: "Brave",
      opera: "Opera",
      operagx: "Opera GX",
      zen: "Zen",
      helium: "Helium",
      vivaldi: "Vivaldi",
      waterfox: "Waterfox",
      floorp: "Floorp",
      mullvad: "Mullvad Browser",
    };

    new Setting(containerEl)
      .setName("Default browser")
      .setDesc("Used when the active account isn't mapped (or can't be read).")
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(browserOptions)) d.addOption(id, label);
        d.addOption("default", "System default");
        d.setValue(this.plugin.settings.defaultBrowser || "chrome");
        d.onChange(async (v) => {
          this.plugin.settings.defaultBrowser = v;
          await this.plugin.saveSettings();
        });
      });

    this.plugin.settings.browserMap.forEach((row, i) => {
      const setting = new Setting(containerEl)
        .addText((t) =>
          t
            .setPlaceholder("account@gmail.com")
            .setValue(row.email)
            .onChange(async (v) => {
              this.plugin.settings.browserMap[i].email = v;
              await this.plugin.saveSettings();
            })
        )
        .addDropdown((d) => {
          for (const [id, label] of Object.entries(browserOptions)) d.addOption(id, label);
          d.addOption("custom", "Custom path…");
          d.setValue(row.browser || "chrome");
          d.onChange(async (v) => {
            this.plugin.settings.browserMap[i].browser = v;
            await this.plugin.saveSettings();
            this.display(); // show/hide the custom-path field
          });
        });
      if (row.browser === "custom") {
        setting.addText((t) =>
          t
            .setPlaceholder("C:\\path\\to\\browser.exe")
            .setValue(row.path)
            .onChange(async (v) => {
              this.plugin.settings.browserMap[i].path = v.trim();
              await this.plugin.saveSettings();
            })
        );
      }
      setting.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove")
          .onClick(async () => {
            this.plugin.settings.browserMap.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add account → browser").onClick(async () => {
        this.plugin.settings.browserMap.push({ email: "", browser: "chrome", path: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );

    new Setting(containerEl)
      .setName("Node.js path")
      .setDesc(
        "Optional. Full path to node.exe. node-pty needs a real Node runtime (Obsidian's binary can't run as Node). Leave empty to auto-detect."
      )
      .addText((text) =>
        text
          .setPlaceholder("C:\\Program Files\\nodejs\\node.exe")
          .setValue(this.plugin.settings.nodePath)
          .onChange(async (value) => {
            this.plugin.settings.nodePath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Python path")
      .setDesc(
        "Optional. Full path to python.exe used by the Token Dashboard button. Leave empty to auto-detect (PATH / py launcher)."
      )
      .addText((text) =>
        text
          .setPlaceholder("C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python312\\python.exe")
          .setValue(this.plugin.settings.pythonPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("p", {
      text: "Open a new tab with the + button in the panel header to run several Claude sessions in parallel. Each tab is its own claude process over the vault; closing a tab kills that instance.",
      cls: "setting-item-description",
    });
  }
}
