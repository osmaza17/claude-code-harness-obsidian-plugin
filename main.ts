import {
  App,
  FileSystemAdapter,
  ItemView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
  TAbstractFile,
  WorkspaceLeaf,
} from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import * as path from "path";

// Electron exposes Node's require on the window in the renderer. We use it to
// reach child_process without esbuild trying to bundle it.
const nodeRequire: NodeRequire = (window as any).require;

export const VIEW_TYPE = "claude-code-harness-view";

interface HarnessSettings {
  // Command run inside the PTY when the session starts.
  command: string;
  // Path to a real node.exe. node-pty needs a true Node runtime (Obsidian's
  // binary ignores ELECTRON_RUN_AS_NODE), so we fork the system Node. Empty =
  // auto-detect.
  nodePath: string;
  // Last fitted grid size. We spawn claude at this size so the first fit when
  // the panel opens doesn't change it (a resize makes claude repaint and stack
  // its banner). Persisted across sessions.
  cols: number;
  rows: number;
  // Terminal font size (px), adjustable with Ctrl +/-/0.
  fontSize: number;
  // Extra arguments appended to the claude command (e.g.
  // --append-system-prompt "Be concise" --model opus).
  args: string;
  // Active skill: the folder name (e.g. "second-brain-assistant") inside Claude
  // Code's skills folder (~/.claude/skills). It is invoked as /<name> when the
  // session starts. Selectable from the panel header. Empty = none.
  skill: string;
  // Slash commands (one per line) run at session start, BEFORE the skill.
  // E.g. /remote-control.
  startupCommands: string;
  // Last model picked from the header menu (for the button label). The actual
  // model is owned by Claude (/model saves it as the default).
  model: string;
  // Fire an Obsidian notice when the terminal rings the bell (\x07) — Claude
  // tends to ring it when a long task finishes / needs attention.
  notifyOnBell: boolean;
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
  btnZoom: boolean;
}

const DEFAULT_SETTINGS: HarnessSettings = {
  command: "claude",
  nodePath: "",
  cols: 100,
  rows: 30,
  fontSize: 14,
  args: "",
  skill: "second-brain-assistant",
  startupCommands: "",
  model: "opus",
  notifyOnBell: true,
  browserMap: [],
  defaultBrowser: "chrome",
  autoSwitch: false,
  autoSwitchMode: "threshold",
  autoSwitchThreshold: 90,
  autoSwitchDelta: 10,
  autoSwitchUsageRegex: "",
  usageProbe: true,
  usageProbeModel: "",
  btnSendNote: true,
  btnAccount: true,
  btnModel: true,
  btnSkill: true,
  btnSkillsFolder: true,
  btnRemote: true,
  btnAutoSwitch: true,
  btnZoom: true,
};

const MIN_FONT = 8;
const MAX_FONT = 40;

// Default pattern to scrape the 5h usage % from Claude's status line
// ("5h:[▓▓░] 23% (3 31m)"). Overridable via settings.autoSwitchUsageRegex.
const DEFAULT_USAGE_RE = "5h:[^\\n]{0,40}?(\\d{1,3})\\s*%";
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
const H_5H_STATUS = "anthropic-ratelimit-unified-5h-status";
const USAGE_FRESH_MS = 6 * 60 * 1000; // a reading older than this is "stale"

// Per-account usage snapshot from a probe (or an error state). pct values are
// 0..100 (the headers give a 0..1 fraction; we ×100). reset5h is epoch seconds.
interface AccountUsage {
  pct5h: number | null;
  reset5h: number | null;
  pct7d: number | null;
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

export default class ClaudeCodeHarnessPlugin extends Plugin {
  settings: HarnessSettings;

  // The session lives on the plugin, not the view, so it survives the panel
  // being closed and reopened. node-pty runs in a forked Node process (see
  // pty-host.js) because Obsidian's renderer cannot create worker_threads.
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private host: HTMLElement | null = null; // element xterm renders into
  private child: any = null; // forked pty-host process
  private opened = false; // whether term.open() has been called
  private exited = false; // claude (the inner pty process) has exited — stop resizing
  // Last grid size sent to the pty. We only resize when it ACTUALLY changes:
  // every resize makes the Claude TUI repaint its whole screen and pushes the
  // previous frame into scrollback, so spurious resizes stack the boot banner.
  private lastCols = 0;
  private lastRows = 0;
  private fontLink: HTMLLinkElement | null = null;
  private resizeTimer: number | null = null;
  private rafFit: number | null = null; // pending per-frame display fit during a drag
  private zoomLabel: HTMLElement | null = null;
  private modelBtn: HTMLElement | null = null;
  private skillBtn: HTMLElement | null = null;
  private accountBtn: HTMLElement | null = null;
  private autoSwitchBtn: HTMLElement | null = null; // green while auto-switch is ON
  private webgl: any = null; // WebglAddon, kept so we can clear its glyph atlas on zoom
  // After a /model switch, Claude may show a "Switch model?" confirmation. We
  // watch the stream and auto-confirm (option 1 is pre-selected).
  private awaitModelConfirm = false;
  private modelConfirmBuf = "";
  private modelConfirmDeadline = 0;
  private tempImages: string[] = []; // temp PNGs from image paste, cleaned on unload
  private initialSent = false; // whether the startup steps were inserted this session
  // Remote control toggle (/remote-control). remoteOn drives the button's green
  // state; while awaiting the menu we scrape the session URL to the clipboard.
  private remoteBtn: HTMLElement | null = null;
  private remoteOn = false;
  // After connecting we wait for "/rc active" in the output, then re-run
  // /remote-control to open the menu that prints the session URL.
  private awaitRemoteActive = false;
  private remoteActiveBuf = "";
  private remoteActiveDeadline = 0;
  private remoteMenuFired = false; // guards the one-shot menu reopen
  private awaitRemoteUrl = false;
  private remoteUrlBuf = "";
  private remoteUrlDeadline = 0;
  // Auto-switch state: rolling buffer of recent output to scrape the 5h usage %,
  // and a cooldown so a single high reading doesn't trigger repeated switches.
  private autoSwitchBuf = "";
  private autoSwitchCooldownUntil = 0;
  // Rotate mode: usage % captured when the current account became active (the
  // baseline); we switch once usage rises autoSwitchDelta points above it. Tracks
  // the low-water mark so a 5h-window reset (usage drops) re-bases cleanly.
  private rotateBaselinePct: number | null = null;
  // Account email currently shown in the status bar (truth of which account is
  // really active), used to anchor the % reading, verify swaps and label the button.
  private barAccountEmail: string | null = null;
  // Swap verification: the account we expect the bar to show after a switch.
  private pendingVerifyEmail: string | null = null;
  private verifyDeadline = 0;
  private sawStatusSinceSwitch = false;
  // Auth-failure recovery after a switch (a saved token may be dead).
  private authWatchUntil = 0;
  private recoverAttempts = 0;
  private warnedNoAccounts = false; // one-shot "need ≥2 accounts" notice
  // Auto-save the active account whenever it changes (throttled) so each account
  // the user logs into gets snapshotted for switching without manual clicks.
  private lastAutoSavedEmail = "";
  private lastAutoSaveCheck = 0;
  // Live usage probe: cached per-account utilisation (email → AccountUsage),
  // a guard against overlapping sweeps, and a debounce for activity-triggered
  // probes of the active account.
  private accountUsage = new Map<string, AccountUsage>();
  private usageProbing = false;
  private lastActiveProbe = 0;
  private lastAutoSwitchDiag = 0; // throttle for the rotate/threshold console log
  // Last auto-switch evaluation, surfaced by the "Diagnose auto-switch" command
  // (and the throttled console echo) so the user can see WHY no switch fired.
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
      id: "restart-claude-code",
      name: "Restart Claude Code session",
      callback: () => this.restart(),
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
      callback: () => this.toggleRemoteControl(),
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

    this.addSettingTab(new HarnessSettingTab(this.app, this));

    this.sweepTempImages(); // remove leftover paste PNGs from previous runs

    // Start the session as soon as Obsidian loads, even if the user never
    // opens the panel. xterm buffers all output until the panel is shown.
    this.ensureSession();

    // Token keep-alive + live usage. Every 3 min we CHECK every account (incl. the
    // active one) and refresh its OAuth token if it's expired or about to expire
    // (REFRESH_SKEW_MS) — so inactive accounts never drift into "expired" / get
    // excluded from auto-switch — then re-probe usage. Also runs once shortly after
    // start. The expiry throttle keeps the refresh rate near claude's own and
    // avoids hammering the rate-limited token endpoint. 3 min < USAGE_FRESH_MS
    // (6 min) so `pickNextAccount` always has fresh data. See refreshAccount().
    window.setTimeout(() => void this.refreshUsage({ refreshTokens: true }), 5000);
    this.registerInterval(
      window.setInterval(
        () => void this.refreshUsage({ refreshTokens: true }),
        3 * 60 * 1000
      )
    );
  }

  onunload() {
    if (this.resizeTimer != null) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.rafFit != null) {
      cancelAnimationFrame(this.rafFit);
      this.rafFit = null;
    }
    this.killChild();
    this.term?.dispose();
    this.term = null;
    this.fit = null;
    this.host?.remove();
    this.host = null;
    this.opened = false;
    this.fontLink?.remove();
    this.fontLink = null;
    this.cleanupTempImages();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
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

  /** @-mention one or more vault paths in Claude's input (opens the panel and
   *  starts the session if needed). Used by the @ button, the file-explorer
   *  context menu and drag-and-drop. */
  async sendPathsToClaude(paths: string[]) {
    const uniq = [...new Set(paths)].filter(Boolean);
    if (!uniq.length) return;
    await this.activateView();
    this.ensureSession();
    if (!this.child) {
      new Notice("Claude session is not running.");
      return;
    }
    this.send({ t: "input", d: uniq.map((p) => "@" + p + " ").join("") });
    this.term?.focus();
  }

  /** Resolve files dropped on the terminal to paths and @-mention them. Handles
   *  Obsidian internal drags (file explorer), OS files, and a text/plain
   *  fallback (a wikilink or a path). */
  private async handleDrop(e: DragEvent) {
    const paths: string[] = [];
    // 1) Obsidian internal drag (file explorer / links).
    const dragged = (this.app as any).dragManager?.draggable;
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
        const tf = this.app.metadataCache.getFirstLinkpathDest(name, "");
        paths.push(tf ? tf.path : txt);
      }
    }
    if (paths.length) await this.sendPathsToClaude(paths);
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

  /** Load JetBrains Mono (same font the reference harness uses) so the terminal
   *  renders identically. Falls back to ui-monospace if the fetch is blocked. */
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

  /** Create the persistent terminal and start the pty host once. */
  ensureSession() {
    if (this.term) return;
    // Terminal config replicated verbatim from the reference harness
    // (terminalPool.ts) so the rendering is identical.
    this.term = new Terminal({
      theme: this.termTheme(),
      fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: this.settings.fontSize || 14,
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

    // Forward keystrokes to the pty host (registered once, lives with the term).
    this.term.onData((d: string) => this.send({ t: "input", d }));

    // Claude rings the bell (\x07) when a long task finishes / needs attention.
    this.term.onBell(() => {
      if (this.settings.notifyOnBell) {
        new Notice("🔔 Claude Code needs your attention");
      }
    });

    this.setupClipboard();
    this.startHost();

    // Follow the Obsidian theme: re-apply colours when it changes.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (!this.term) return;
        this.term.options.theme = this.termTheme();
        try {
          this.term.refresh(0, Math.max(0, this.term.rows - 1));
        } catch {
          /* not open yet */
        }
      })
    );
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
      const imgPath = this.saveClipboardImage(clipboard);
      if (imgPath) {
        term.paste(imgPath);
        return;
      }
      void pasteText();
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
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
        this.zoomBy(1);
        return false;
      }
      if (key === "-" || key === "_") {
        ev.preventDefault();
        ev.stopPropagation();
        this.zoomBy(-1);
        return false;
      }
      if (key === "0") {
        ev.preventDefault();
        ev.stopPropagation();
        this.setFontSize(14);
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
        this.zoomBy(ev.deltaY < 0 ? 1 : -1);
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

  /** If the clipboard holds an image, write it to a temp PNG and return its
   *  path; otherwise null. */
  private saveClipboardImage(clipboard: any): string | null {
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

  /** Move the persistent terminal into a freshly opened panel. */
  attachTo(container: HTMLElement) {
    this.ensureSession();
    if (!this.host || !this.term) return;
    this.buildHeader(container);
    container.appendChild(this.host);
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
        this.term?.focus();
      })
    );
    window.setTimeout(() => this.scheduleFit(), 120);
    window.setTimeout(() => this.scheduleFit(), 400);
    document.fonts?.ready?.then(() => this.scheduleFit()).catch(() => {
      /* noop */
    });
  }

  /** Font zoom (Ctrl +/-/0). Persisted; refits after changing. */
  setFontSize(px: number) {
    const clamped = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(px)));
    this.settings.fontSize = clamped;
    void this.saveSettings();
    if (this.term) {
      this.term.options.fontSize = clamped;
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
            if (this.settings.cols !== cols || this.settings.rows !== rows) {
              this.settings.cols = cols;
              this.settings.rows = rows;
              void this.saveSettings();
            }
          }
        } catch {
          /* not laid out yet */
        }
      }
    }
    if (this.zoomLabel) this.zoomLabel.setText(clamped + "px");
  }

  zoomBy(delta: number) {
    this.setFontSize((this.settings.fontSize || 14) + delta);
  }

  private currentModelLabel(): string {
    return MODELS.find((m) => m.id === this.settings.model)?.label ?? "Model";
  }

  /** Switch Claude's model by running `/model <id>` in the terminal. A leading
   *  Ctrl+U clears any draft first so the command runs on its own line (the
   *  draft is restorable with Ctrl+Y). */
  selectModel(id: string, label: string) {
    this.settings.model = id;
    void this.saveSettings();
    this.modelBtn?.setText(label);
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


  /** Send text to the pty as if pasted, WITHOUT going through xterm's paste()
   *  (which needs the view attached). This is why the startup commands and the
   *  initial prompt now fire even when the user never opens the panel. We bracket
   *  the text only when Claude has bracketed-paste mode on — same condition
   *  xterm.paste() uses — so a multi-line prompt is inserted as one block instead
   *  of each newline submitting a line early. */
  private pasteToPty(text: string) {
    const bracketed = !!(this.term as any)?.modes?.bracketedPasteMode;
    const d = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    this.send({ t: "input", d });
  }

  /** Claude Code's personal skills folder (~/.claude/skills). Each skill is a
   *  subfolder with a SKILL.md, invoked as /<folder-name>. */
  skillsDir(): string {
    const os = nodeRequire("os");
    return path.join(os.homedir(), ".claude", "skills");
  }

  /** Names of the skills available in ~/.claude/skills (subfolders containing a
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

  /** Choose the active skill from the header. Persists the choice (so future
   *  sessions invoke it) and, if a session is running, invokes it now. Sending
   *  uses the same `\x15/<name>\r` pattern as selectModel: the leading Ctrl+U
   *  clears any draft so the slash command runs on its own line. */
  selectSkill(name: string) {
    this.settings.skill = name;
    void this.saveSettings();
    const label = name || "none";
    if (this.skillBtn) this.skillBtn.title = "Skill: " + label;
    if (name && this.child) {
      this.send({ t: "input", d: `\x15/${name}\r` });
      new Notice("Skill loaded: /" + name);
    } else {
      new Notice("Skill set: " + label + " (loads on next session)");
    }
    this.term?.focus();
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
   *  Windows-only, best-effort (Win11 Explorer has no real F11 fullscreen, so we
   *  maximise the exact window matched by its folder path).
   *
   *  Plain SetForegroundWindow rarely steals focus (Windows' foreground lock), so
   *  we minimise→restore the window (a restore reliably grants foreground) and
   *  also call AppActivate. Retries because the window may not exist yet. */
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
        // Retry ~3.2s: the Explorer window may not be registered yet.
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
      /* best-effort: no focus/maximise if PowerShell isn't available */
    }
  }

  /** Two-state remote control toggle.
   *  A first /remote-control just connects (shows "/rc connecting…" -> "/rc
   *  active"); it does NOT print the URL. Running it again WHILE connected opens
   *  a menu (Disconnect · Show QR code · > Continue) that prints the session URL
   *  (https://claude.ai/code/session_…).
   *  - OFF -> ON: connect, then once "/rc active" shows, re-run the command to
   *    open the menu, scrape the URL to the clipboard and dismiss with Esc
   *    ("Esc to continue") so the session stays connected. See maybeAfterRemoteActive.
   *  - ON -> OFF: open the menu, arrow Up twice (Continue -> QR -> Disconnect)
   *    and Enter to select "Disconnect this session".
   *  The leading Ctrl+U clears any draft so the command lands on its own line. */
  toggleRemoteControl() {
    if (!this.child) {
      new Notice("No live session");
      return;
    }
    if (!this.remoteOn) {
      this.send({ t: "input", d: "\x15/remote-control\r" });
      this.remoteOn = true;
      this.updateRemoteBtn();
      new Notice("Remote control connecting…");
      // Reopen the menu to surface + copy the URL. Fast path: as soon as the
      // output shows "/rc active" (maybeAfterRemoteActive). Fallback: a timer,
      // since the menu also appears while still "connecting…".
      this.remoteMenuFired = false;
      this.awaitRemoteActive = true;
      this.remoteActiveBuf = "";
      this.remoteActiveDeadline = Date.now() + 20000;
      window.setTimeout(() => this.fireRemoteMenu(), 3500);
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
      this.updateRemoteBtn();
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

  /** One-shot: re-run /remote-control to open the menu (which prints the session
   *  URL), arm the URL capture, then dismiss with Esc to stay connected. */
  private fireRemoteMenu() {
    if (this.remoteMenuFired || !this.remoteOn || !this.child) return;
    this.remoteMenuFired = true;
    this.awaitRemoteActive = false;
    this.send({ t: "input", d: "\x15/remote-control\r" });
    this.awaitRemoteUrl = true;
    this.remoteUrlBuf = "";
    this.remoteUrlDeadline = Date.now() + 8000;
    window.setTimeout(() => this.send({ t: "input", d: "\x1b" }), 700);
  }

  /** Reflect remoteOn on the header button (green when active). */
  private updateRemoteBtn() {
    if (!this.remoteBtn) return;
    this.remoteBtn.toggleClass("cch-active", this.remoteOn);
    this.remoteBtn.title = this.remoteOn
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

  /** While awaiting the remote-control menu, scrape the session URL from the
   *  terminal output and copy it to the clipboard (once). */
  private maybeCaptureRemoteUrl(chunk: string) {
    if (!this.awaitRemoteUrl) return;
    if (Date.now() > this.remoteUrlDeadline) {
      this.awaitRemoteUrl = false;
      return;
    }
    this.remoteUrlBuf = (this.remoteUrlBuf + chunk).slice(-5000);
    const clean = this.remoteUrlBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const m = clean.match(/https:\/\/claude\.ai\/code\/session_[\w-]+/);
    if (m) {
      this.awaitRemoteUrl = false;
      const url = m[0];
      try {
        const clip = nodeRequire("electron")?.clipboard;
        if (clip) clip.writeText(url);
        else void navigator.clipboard?.writeText(url).catch(() => {});
      } catch {
        /* clipboard unavailable */
      }
      const label = this.openInBrowser(url);
      new Notice("Remote session opening in " + label + ":\n" + url);
    }
  }

  /** The Claude account currently logged in, from ~/.claude.json. Updated by
   *  Claude on /login, so reading it now reflects the active account. */
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

  /** Snapshot the active account's credentials + oauthAccount under its email.
   *  Returns the saved email, or null. */
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
   *  The running claude re-reads ~/.claude/.credentials.json and uses the new
   *  account on its next request, so the conversation keeps going uninterrupted.
   *  Snapshots the outgoing account first (to keep its freshly-refreshed token). */
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
        // Re-read immediately before writing to minimise clobbering Claude's own
        // concurrent updates to ~/.claude.json (it writes that file frequently).
        const cj = JSON.parse(fs.readFileSync(this.claudeJsonPath(), "utf8"));
        cj.oauthAccount = saved.oauthAccount;
        this.writeJsonAtomic(this.claudeJsonPath(), cj);
      }
      const target = email.trim().toLowerCase();
      this.lastAutoSavedEmail = target;
      this.rotateBaselinePct = null; // new account re-establishes its own baseline
      // Arm verification + auth-failure watch for this swap.
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

  /** Auto-snapshot the active account whenever it changes (throttled to ~10s), so
   *  every account logged into gets saved for switching without manual clicks. */
  private maybeAutoSaveAccount() {
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

  /** Forget the rotate-mode baseline (re-captured on the next reading). Called
   *  when the auto-switch mode/enable changes so a stale baseline isn't reused. */
  resetRotationBaseline() {
    this.rotateBaselinePct = null;
  }

  /** Account to switch to: the **least-used** one (lowest probed 5h %), skipping
   *  accounts whose saved token is dead (error "auth"). Falls back to round-robin
   *  order when no fresh usage data is available. Null if there's nowhere to go. */
  private pickNextAccount(): string | null {
    const saved = this.listSavedAccounts().map((a) => a.email);
    if (saved.length < 2) return null;
    const cur = this.currentAccountEmail();
    const others = saved.filter((e) => e.trim().toLowerCase() !== cur);
    if (!others.length) return null;

    // Prefer the candidate with the lowest fresh 5h usage; never pick one whose
    // token is known-dead. Candidates without a fresh reading rank after those
    // with one (handled by treating unknown as +Infinity but keeping order).
    let best: string | null = null;
    let bestPct = Infinity;
    for (const e of others) {
      const u = this.accountUsage.get(e.trim().toLowerCase());
      if (u?.error === "auth") continue; // dead token — can't use it
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

    // No fresh usage data → round-robin from the current account (original logic),
    // still skipping dead-token accounts.
    const idx = saved.findIndex((e) => e.trim().toLowerCase() === cur);
    const start = idx >= 0 ? idx + 1 : 0;
    for (let i = 0; i < saved.length; i++) {
      const cand = saved[(start + i) % saved.length];
      if (cand.trim().toLowerCase() === cur) continue;
      if (this.accountUsage.get(cand.trim().toLowerCase())?.error === "auth") continue;
      return cand;
    }
    return best; // may be null
  }

  // --- Live usage probe (API rate-limit headers) --------------------------

  /** OAuth access token for an account: the live creds for the active account,
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
      // Active creds file holds claudeAiOauth at the root; snapshots nest it
      // under .credentials.
      return (
        j?.claudeAiOauth?.accessToken ||
        j?.credentials?.claudeAiOauth?.accessToken ||
        null
      );
    } catch {
      return null;
    }
  }

  /** Refresh one account's OAuth token with its refresh token (the same grant
   *  Claude Code uses internally) and persist the rotated pair atomically, so an
   *  inactive account doesn't drift into "expired". Returns true on success.
   *
   *  SAFETY: the refresh token ROTATES on every success — the server returns a new
   *  one and invalidates the old. Losing it locks the account out (needs /login).
   *  Hence: we only touch the file on HTTP 200 (any error → creds left intact, old
   *  refresh token still valid), and we write atomically (temp+rename). The active
   *  account is refreshed too (user opted into the aggressive mode); claude re-reads
   *  .credentials.json per request, so it just picks up the fresher token. */
  private async refreshAccount(email: string): Promise<boolean> {
    const fs = nodeRequire("fs");
    const lower = email.trim().toLowerCase();
    const isActive = lower === this.currentAccountEmail();
    const file = isActive
      ? this.credsPath()
      : path.join(this.accountsDir(), this.accountFileName(email));

    let store: any;
    try {
      store = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
    // Active creds hold claudeAiOauth at the root; snapshots nest it under
    // .credentials. Refresh in place, preserving every other field.
    const oauth = isActive ? store?.claudeAiOauth : store?.credentials?.claudeAiOauth;
    const refreshToken = oauth?.refreshToken;
    if (!refreshToken) return false;

    // Throttle: only refresh when expired or about to expire (see REFRESH_SKEW_MS).
    // expiresAt is stored in ms here, but tolerate seconds defensively.
    const prev = Number(oauth.expiresAt) || 0;
    const prevMs = prev > 0 && prev < 1e12 ? prev * 1000 : prev;
    if (prevMs && prevMs - Date.now() > REFRESH_SKEW_MS) return true; // still alive

    const resp = await this.oauthRefresh(refreshToken);
    if (!resp) return false; // network/HTTP error → keep old creds intact

    // Preserve the stored unit of expiresAt (confirmed ms here, but be defensive
    // in case a snapshot ever used seconds) so claude reads it correctly.
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
    return true;
  }

  /** POST the OAuth refresh-token grant. Resolves to the parsed token response on
   *  HTTP 200, or null on any non-200 / network / parse error (never rejects), so
   *  a failure never destroys the stored refresh token. */
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
            if (status !== 200) return finish(null);
            try {
              const j = JSON.parse(data);
              finish(j?.access_token ? j : null);
            } catch {
              finish(null);
            }
          });
        }
      );
      req.on("error", () => finish(null));
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
      req.write(body);
      req.end();
    });
  }

  /** Probe one account's usage via a minimal API call, reading the rate-limit
   *  response headers. Resolves to an AccountUsage (never rejects). Uses Node's
   *  https (desktop-only) so all response headers are exposed. */
  private probeUsage(token: string): Promise<AccountUsage> {
    const now = Date.now();
    const empty = (error: AccountUsage["error"]): AccountUsage => ({
      pct5h: null,
      reset5h: null,
      pct7d: null,
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
        return Math.round(f <= 1 ? f * 100 : f); // headers are a 0..1 fraction
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
            finish({
              pct5h,
              reset5h: isNaN(reset) ? null : reset,
              pct7d: toPct(h[H_7D_UTIL]),
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
   *  account, probing sequentially with a small gap to avoid bursts. With
   *  `refreshTokens`, each account's OAuth token is refreshed first (keep-alive),
   *  so inactive accounts don't go "expired" and their usage reads correctly. */
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

  /** Short label for an account's cached usage (plain text, for settings). */
  usageLabel(email: string): string {
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u) return "…";
    if (u.error === "auth") return "expired";
    if (u.error === "rate") return "rate-limited";
    if (u.error) return "unavailable";
    if (u.pct5h == null) return "…";
    let s = "5h " + u.pct5h + "%";
    if (u.reset5h) {
      const diff = u.reset5h - Math.floor(Date.now() / 1000);
      if (diff > 0) {
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        s += h > 0 ? ` (${h}h ${m}m)` : ` (${m}m)`;
      }
    }
    if (u.pct7d != null) s += " · 7d " + u.pct7d + "%";
    return s;
  }

  /** Colour for a usage %: green (low/least used) → red (near the limit). */
  private usageColor(pct: number): string {
    if (pct >= 90) return "var(--color-red)";
    if (pct >= 75) return "var(--color-orange)";
    if (pct >= 50) return "var(--color-yellow)";
    return "var(--color-green)";
  }

  /** Aligned, colour-coded title for an account in the 👤 menu. Monospace +
   *  pre-spaced so the email / 5h% / countdown / 7d% line up in columns; the %
   *  numbers are coloured by how close to the limit they are. `emailWidth` is the
   *  longest email in the list, used to pad the first column. */
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

    // 5h: "5h " + right-aligned number + "%" (number coloured by level).
    seg("5h ", "var(--text-muted)");
    seg(String(u.pct5h).padStart(3, " ") + "%", this.usageColor(u.pct5h));

    // Countdown to reset, padded to a fixed width so the 7d column lines up.
    let cd = "";
    if (u.reset5h) {
      const diff = u.reset5h - Math.floor(Date.now() / 1000);
      if (diff > 0) {
        const h = Math.floor(diff / 3600);
        const m = Math.floor((diff % 3600) / 60);
        cd = h > 0 ? `(${h}h ${String(m).padStart(2, "0")}m)` : `(${m}m)`;
      }
    }
    seg("  " + cd.padEnd(9, " "), "var(--text-muted)");

    if (u.pct7d != null) {
      seg("· 7d ", "var(--text-muted)");
      seg(String(u.pct7d).padStart(3, " ") + "%", this.usageColor(u.pct7d));
    }
    return frag;
  }

  /** Debounced probe of the active account on terminal activity (≥60s apart). */
  private maybeProbeOnActivity() {
    if (!this.settings.usageProbe) return;
    const now = Date.now();
    if (now - this.lastActiveProbe < 60000) return;
    this.lastActiveProbe = now;
    void this.refreshUsage({ activeOnly: true });
  }

  /** Emails of accounts we know about (saved snapshots ∪ the active one), so a
   *  stray email in note content isn't mistaken for the account in the status bar. */
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

  /** Process Claude's output: track the active account from the status bar
   *  (label + swap verification + auth-fail recovery) and, if enabled, auto-switch
   *  accounts by usage. Runs on every `data` chunk (not only when autoSwitch is on)
   *  so the live label and verification work regardless. */
  private maybeAutoSwitch(chunk: string) {
    this.autoSwitchBuf = (this.autoSwitchBuf + chunk).slice(-3000);
    const clean = this.autoSwitchBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

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
    // Read the active account's 5h usage %: prefer the scraped status-bar %
    // (works even with no API access; the bar can lag a swap, hence the anchor
    // guard). Fall back to the authoritative API reading (tied to the account's
    // own token, so no anchoring needed) so auto-switch keeps working if the bar
    // % is ever hidden. We compute this even when auto-switch is off so the
    // "Diagnose auto-switch" command always has something to show.
    const cur = this.currentAccountEmail();
    let pct: number | null = null;
    let src = "none";
    const m = clean.match(this.usageRegex());
    const scraped = m && m[1] !== undefined ? parseInt(m[1], 10) : NaN;
    if (!isNaN(scraped)) {
      if (this.barAccountEmail && this.barAccountEmail !== cur) {
        // Anchor: the bar's account isn't the one we believe is active — its % is
        // stale (it hasn't caught up to the last swap). Don't act on it.
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

    // Decide — and capture WHY, in plain language, for the "Diagnose auto-switch"
    // command. `decide()` returns a human-readable reason and performs the switch
    // as a side effect when warranted (so the recorded reason matches reality).
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
      if (this.settings.autoSwitchMode === "rotate") {
        const delta = this.settings.autoSwitchDelta || 10;
        if (this.rotateBaselinePct === null) {
          this.rotateBaselinePct = pct; // first reading after activation = baseline
          return `baseline set at ${pct}% — will rotate at ${pct + delta}% (+${delta})`;
        }
        if (pct < this.rotateBaselinePct) {
          this.rotateBaselinePct = pct; // 5h window reset → re-base to the low-water mark
          return `usage dropped → baseline re-based to ${pct}%`;
        }
        const target = this.rotateBaselinePct + delta;
        if (pct < target) {
          return `at ${pct}% (${src}); need ${target}% to rotate (baseline ${this.rotateBaselinePct} +${delta})`;
        }
        this.requestSwitch(`at ${pct}%`);
        return `switching now — rose to ${pct}% ≥ ${target}% (baseline ${this.rotateBaselinePct} +${delta})`;
      }
      const th = this.settings.autoSwitchThreshold;
      if (pct < th) return `at ${pct}% (${src}); threshold is ${th}%`;
      this.requestSwitch(`at ${pct}%`);
      return `switching now — ${pct}% ≥ threshold ${th}%`;
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
    // Throttled console echo (open DevTools with Ctrl+Shift+I → Console).
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

  /** Pick the next account and switch, or warn once if there aren't ≥2 saved. */
  private requestSwitch(reason: string) {
    const next = this.pickNextAccount();
    if (!next) {
      if (!this.warnedNoAccounts) {
        this.warnedNoAccounts = true;
        new Notice("Auto-switch: save at least 2 accounts (log in with /login).");
      }
      return;
    }
    this.triggerSwitch(next, reason);
  }

  /** Common path for an automatic switch: set cooldown, reset state, notify, swap. */
  private triggerSwitch(next: string, reason: string) {
    this.autoSwitchCooldownUntil = Date.now() + 10000;
    this.autoSwitchBuf = "";
    this.rotateBaselinePct = null; // recapture baseline for the new account
    new Notice(`Claude account ${reason} — switching to ${next}…`);
    this.switchToAccount(next);
  }

  /** Open the remote session URL in the browser mapped to the active Claude
   *  account (the URL only works where that same account is logged in). Returns
   *  a human label for the notice. The link is also on the clipboard, so this is
   *  best-effort. */
  private openInBrowser(url: string): string {
    const email = this.currentAccountEmail();
    const map = this.settings.browserMap.find(
      (m) => m.email.trim().toLowerCase() === email && !!email
    );
    const browser = map?.browser || this.settings.defaultBrowser || "chrome";
    return this.launchBrowser(browser, map?.path || "", url);
  }

  /** Launch a specific browser with the URL (new tab in the running instance).
   *  Best-effort; any failure falls back to the OS default browser. */
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
        // Let Windows resolve the alias via its App Paths registry entry.
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
   *  fullscreen (F11). CLI fullscreen flags are ignored when the browser is
   *  already running, so we drive the window instead: a short PowerShell that
   *  activates the process's main window (WScript.Shell.AppActivate, which
   *  handles Windows' foreground rules) and sends {F11}. Best-effort and fire-
   *  and-forget — the link is already open and on the clipboard regardless. */
  private focusFullscreen(proc: string) {
    if (!proc) return;
    try {
      const cp = nodeRequire("child_process");
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        // Give the new tab/window time to appear (cold start needs longer).
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
      /* best-effort: no fullscreen if PowerShell isn't available */
    }
  }

  /** Once claude is up, run the startup slash commands, then invoke the active
   *  skill (/<name>) — in order, with small gaps. Runs on a fresh start (Obsidian
   *  launch or the Restart button); account switching no longer restarts, so the
   *  skill is never re-injected on a switch. */
  private maybeSendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;

    const steps: string[] = [];
    const startup = this.settings.startupCommands || "";
    for (const line of startup.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      steps.push(line);
    }
    if (this.settings.skill) steps.push("/" + this.settings.skill);
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
   *  Both are bursts of width changes. We split the work:
   *   - every frame: rewrap xterm to the container WITHOUT touching the pty
   *     (`fitNow(false)`), so the panel tracks the drag live with no gap and,
   *     crucially, without making claude reprint (which is what stacked the
   *     duplicate banners);
   *   - once the burst settles: tell claude the final size ONCE
   *     (`scheduleFit()` -> `fitNow(true)`), so a whole drag costs a single
   *     reprint instead of one per column crossed. */
  onContainerResize() {
    if (this.rafFit == null) {
      this.rafFit = requestAnimationFrame(() => {
        this.rafFit = null;
        this.fitNow(false);
      });
    }
    this.scheduleFit();
  }

  /** Build the panel header (@ send note · model selector · skill selector ·
   *  open skills folder · remote control · zoom · restart). Rebuilt each time a
   *  panel opens; the persistent terminal host is appended after it. */
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

    const iconBtn = (icon: string, title: string, onClick: () => void) => {
      const b = header.createEl("button", { cls: "cch-btn" });
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
    header.createDiv({ cls: "cch-spacer" });

    // Model selector.
    if (s.btnModel) {
      const modelBtn = header.createEl("button", {
        cls: "cch-btn cch-model",
        text: this.currentModelLabel(),
      });
      modelBtn.title = "Select model";
      this.modelBtn = modelBtn;
      modelBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        for (const m of MODELS) {
          menu.addItem((item) =>
            item
              .setTitle(m.label)
              .setChecked(this.settings.model === m.id)
              .onClick(() => this.selectModel(m.id, m.label))
          );
        }
        const r = modelBtn.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      };
    }

    // Account: save the current Claude account / switch to a saved one.
    if (s.btnAccount) {
      const accountBtn = header.createEl("button", { cls: "cch-btn" });
      setIcon(accountBtn, "user-round");
      this.accountBtn = accountBtn;
      const curEmail = this.barAccountEmail || this.currentAccountEmail();
      accountBtn.setAttr("aria-label", "Claude account");
      accountBtn.title = "Account: " + (curEmail || "unknown");
      accountBtn.onclick = (e) => {
        e.preventDefault();
        // Refresh all accounts' usage in the background; the menu shows the
        // cached values now (it's built synchronously) and the next open is fresh.
        if (this.settings.usageProbe) void this.refreshUsage({});
        const menu = new Menu();
        const cur = this.currentAccountEmail();
        menu.addItem((item) =>
          item
            .setTitle("Save current account")
            .setIcon("save")
            .onClick(() => this.saveCurrentAccount())
        );
        if (this.settings.usageProbe) {
          menu.addItem((item) =>
            item
              .setTitle("Refresh usage")
              .setIcon("refresh-cw")
              .onClick(() => void this.refreshUsage({}))
          );
        }
        menu.addSeparator();
        const saved = this.listSavedAccounts();
        if (!saved.length) {
          menu.addItem((item) =>
            item.setTitle("No saved accounts").setDisabled(true)
          );
        } else {
          const emailWidth = Math.max(...saved.map((a) => a.email.length));
          for (const a of saved) {
            menu.addItem((item) => {
              if (this.settings.usageProbe) {
                item.setTitle(this.accountMenuTitle(a.email, emailWidth));
              } else {
                item.setTitle(a.email);
              }
              item
                .setChecked(cur === a.email.trim().toLowerCase())
                .onClick(() => this.switchToAccount(a.email));
            });
          }
        }
        const r = accountBtn.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      };
    }

    // Skill selector: pick which skill from ~/.claude/skills is invoked as
    // /<name> (and invoke it in the running session now).
    if (s.btnSkill) {
      const skillBtn = header.createEl("button", { cls: "cch-btn" });
      setIcon(skillBtn, "sparkles");
      const cur = this.settings.skill;
      skillBtn.setAttr("aria-label", "Skill");
      skillBtn.title = "Skill: " + (cur || "none");
      this.skillBtn = skillBtn;
      skillBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        const skills = this.listSkills();
        if (!skills.length) {
          menu.addItem((item) =>
            item.setTitle("No skills in ~/.claude/skills").setDisabled(true)
          );
        } else {
          for (const sk of skills) {
            menu.addItem((item) =>
              item
                .setTitle(sk)
                .setChecked(this.settings.skill === sk)
                .onClick(() => this.selectSkill(sk))
            );
          }
        }
        // Open the skills folder (to add new ones) from inside the menu.
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

    // Remote control toggle (green while ON). Rebuilt with the rest of the
    // header, so reflect the persisted session state via updateRemoteBtn().
    if (s.btnRemote) {
      const remoteBtn = header.createEl("button", { cls: "cch-btn" });
      setIcon(remoteBtn, "smartphone");
      this.remoteBtn = remoteBtn;
      remoteBtn.onclick = (e) => {
        e.preventDefault();
        this.toggleRemoteControl();
      };
      this.updateRemoteBtn();
    }

    // Auto-switch toggle + mode/percentage picker (green while ON).
    if (s.btnAutoSwitch) {
      const asBtn = header.createEl("button", { cls: "cch-btn" });
      setIcon(asBtn, "repeat");
      this.autoSwitchBtn = asBtn;
      asBtn.onclick = (e) => {
        e.preventDefault();
        this.openAutoSwitchMenu(asBtn);
      };
      this.updateAutoSwitchBtn();
    }

    if (s.btnZoom) {
      iconBtn("minus", "Zoom out (Ctrl -)", () => this.zoomBy(-1));
      const zl = header.createEl("button", {
        cls: "cch-btn cch-zoom",
        text: (this.settings.fontSize || 14) + "px",
      });
      zl.title = "Reset zoom (Ctrl 0)";
      zl.onclick = () => this.setFontSize(14);
      this.zoomLabel = zl;
      iconBtn("plus", "Zoom in (Ctrl +)", () => this.zoomBy(1));
    }

    iconBtn("settings", "Plugin settings", () => this.openSettings());
    iconBtn("rotate-ccw", "Restart session", () => this.restart());

    // Keep the header as the first child so it survives a rebuild (refreshHeader
    // removes the old one and calls this while the terminal host is already in).
    container.prepend(header);
  }

  /** Rebuild the header of any open panel (after toggling button visibility). */
  refreshHeader() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const root = (leaf.view as any)?.contentEl as HTMLElement | undefined;
      if (!root) continue;
      root.querySelector(".cch-header")?.remove();
      this.buildHeader(root);
    }
  }

  /** Detach the terminal from a closing panel WITHOUT killing the session. */
  detach() {
    if (this.rafFit != null) {
      cancelAnimationFrame(this.rafFit);
      this.rafFit = null;
    }
    this.host?.remove();
  }

  /** Resize xterm to fill its container.
   *
   *  `syncPty` controls the expensive half. The Claude TUI redraws its WHOLE
   *  screen on every width change (SIGWINCH), and because it runs on the main
   *  buffer — not the alternate screen — each redraw leaves the previous frame
   *  behind as scrollback. So every pty resize costs one stacked banner.
   *
   *  - `syncPty=false` (live drag): only `fit.fit()` — rewrap the EXISTING buffer
   *    to the new width so the panel tracks the splitter with no visual gap, but
   *    DON'T tell claude, so it doesn't reprint. No new duplicate lines.
   *  - `syncPty=true` (drag settled / zoom / open): also send the real size to
   *    claude. Debounced via scheduleFit so a whole drag = ONE reprint, not one
   *    per column crossed. */
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
        // Remember the size so next session spawns claude at it -> no first-fit
        // resize -> no stacked banner.
        if (this.settings.cols !== cols || this.settings.rows !== rows) {
          this.settings.cols = cols;
          this.settings.rows = rows;
          void this.saveSettings();
        }
      }
      this.term.refresh(0, Math.max(0, rows - 1));
    } catch {
      /* not laid out yet */
    }
  }

  /** Kill the current claude process and start a fresh one in the same panel. */
  restart() {
    if (!this.term) {
      this.ensureSession();
      return;
    }
    this.remoteOn = false;
    this.awaitRemoteActive = false;
    this.remoteMenuFired = false;
    this.awaitRemoteUrl = false;
    this.updateRemoteBtn();
    this.killChild();
    this.term.reset();
    this.startHost();
    this.fitNow();
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

  private killChild() {
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

  /** Find a real node.exe to fork the pty host with. */
  private resolveNodePath(): string {
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

    // Last resort: ask the OS to locate it.
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

  private pluginDir(): string {
    return path.join(
      this.vaultPath(),
      this.app.vault.configDir,
      "plugins",
      "claude-code-harness"
    );
  }

  /** Fork the pty-host (Obsidian binary as plain Node) and wire it up. */
  private startHost() {
    if (!this.term) return;
    const vault = this.vaultPath();
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

    const hostPath = path.join(this.pluginDir(), "pty-host.js");
    const nodePath = this.resolveNodePath();
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
    const base = this.settings.command || "claude";
    const extra = this.settings.args?.trim();
    const full = extra ? `${base} ${extra}` : base;
    const args = isWin ? ["/c", full] : ["-lc", full];
    // Spawn at the remembered (or current) size so the first fit is a no-op.
    const cols = this.lastCols || this.settings.cols || 100;
    const rows = this.lastRows || this.settings.rows || 30;
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
          this.maybeSendInitial();
          this.maybeConfirmModel(msg.d);
          this.maybeAfterRemoteActive(msg.d);
          this.maybeCaptureRemoteUrl(msg.d);
          this.maybeAutoSwitch(msg.d);
          this.maybeAutoSaveAccount();
          this.maybeProbeOnActivity();
          break;
        case "exit":
          this.exited = true; // stop sending resizes to the dead pty
          this.term.writeln(
            "\r\n\x1b[2m[claude exited — run 'Restart Claude Code session' to start a new one]\x1b[0m"
          );
          this.remoteOn = false;
          this.awaitRemoteUrl = false;
          this.updateRemoteBtn();
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

  /** Terminal theme derived from the active Obsidian theme: surface colours
   *  from CSS variables, ANSI palette chosen by light/dark. Re-applied on the
   *  workspace 'css-change' event. */
  private termTheme() {
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
    this.plugin.attachTo(root);
    this.resizeObserver = new ResizeObserver(() => this.plugin.onContainerResize());
    this.resizeObserver.observe(root);
  }

  async onClose() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    // Detach the terminal but leave the claude process running on the plugin.
    this.plugin.detach();
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
        "Claude Code skill invoked as /<name> when the session starts (after the startup commands). Skills live in ~/.claude/skills — add your own there, or pick one from the panel header."
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
      .setName("Claude accounts")
      .setDesc(
        "Accounts are saved automatically when you log in with /login. Switch between them here or from the header — it hot-swaps ~/.claude/.credentials.json with no restart, so the running session keeps going and uses the new account on its next message. Saved under ~/.claude/cch-accounts (never committed)."
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
            // Refresh + probe every account now (see the header toggle handler).
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
      new Setting(containerEl)
        .setName(name)
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

    containerEl.createEl("p", {
      text: "Run 'Restart Claude Code session' from the command palette after changing these settings.",
      cls: "setting-item-description",
    });
  }
}
