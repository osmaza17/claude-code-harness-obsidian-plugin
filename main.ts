import {
  FileSystemAdapter,
  ItemView,
  Notice,
  Plugin,
  prepareFuzzySearch,
  sortSearchResults,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { Terminal, ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import * as path from "path";
import type { HarnessSettings } from "./types";
import {
  VIEW_TYPE,
  DEFAULT_SETTINGS,
  MIN_FONT,
  MAX_FONT,
  LIMIT_STOP_RE,
  looksLikePrompt,
  ANSI_DARK,
  ANSI_LIGHT,
} from "./constants";
import { nodeRequire, stripDiacritics, newConversationId } from "./utils";
import { AccountManager } from "./accounts";
import { HarnessSettingTab } from "./settings-tab";
import { SessionHistory } from "./history";
import { HeaderView } from "./header";

export { VIEW_TYPE };

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
export class Session {
  plugin: ClaudeCodeHarnessPlugin;
  id: number;
  title: string;
  // Per-session config (defaults copied from settings at creation).
  skill: string;
  model: string;
  args: string;
  // Claude Code conversation id for this tab. We fix it with --session-id when the
  // session starts so we can deterministically --resume it later (Ctrl+Shift+T),
  // even with several sessions running in the same vault cwd. Not part of `args`
  // (that's the shared/global "Extra arguments"); injected at command-build time.
  sessionId: string;
  resume = false; // start with --resume <sessionId> (recovered tab) vs --session-id
  // Chrome-style pin: a pinned tab renders compact (dot only, no ×) at the left
  // end of the strip and is always restored on the next Obsidian run until the
  // user closes it manually (via the tab's right-click menu).
  pinned = false;

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

  /** True once this tab has real conversation/usage (a committed first prompt, a
   *  non-default title, or it was reopened from a saved conversation). Used to keep
   *  pristine blank tabs out of the persisted reopen stack — while still keeping a
   *  reopened tab (which starts with titleRank 0 / no first prompt) recoverable. */
  hasActivity(): boolean {
    return this.firstPromptDone || this.titleRank > 0 || this.resume;
  }

  // Tab heartbeat: is Claude actively working in this session? Inferred from PTY
  // activity — Claude streams tokens / animates its spinner continuously while
  // thinking or responding, then goes silent when it hands control back. `busy`
  // drives the tab dot; the timer flips it back to idle after a quiet gap.
  busy = false;
  private busyTimer: number | null = null;
  private lastKeyAt = 0; // when the user last typed (to ignore keystroke echo)
  // Usage/token limit hit → tab goes RED until the user types again (or restart).
  // Inferred from Claude's output (best-effort, LIMIT_STOP_RE); drives the tab.
  limitReached = false;
  private limitBuf = "";
  // Claude is blocked waiting for the user to answer (permission prompt / plan
  // approval / AskUserQuestion) → tab goes RED so "needs your answer" is not
  // confused with "done" (both are silent/idle). Detected by scanning xterm's
  // RENDERED screen (not the byte stream — see screenShowsPrompt), so the periodic
  // status-bar refresh can't scroll the prompt out of view and leave it stuck.
  awaitingInput = false;
  private awaitScanTimer: number | null = null;

  // Remote control toggle (/remote-control). remoteOn drives the button's green
  // state. Activating just CONNECTS (sends /remote-control); the URL is left for
  // the user to read/copy from Claude's own panel — we deliberately do NOT auto-
  // reopen the menu, scrape the URL, or open a browser on activation anymore.
  remoteOn = false;

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
    opts?: {
      skill?: string;
      model?: string;
      args?: string;
      title?: string;
      sessionId?: string;
      resume?: boolean;
      cols?: number;
      rows?: number;
      pinned?: boolean;
    }
  ) {
    this.plugin = plugin;
    this.id = ++SESSION_SEQ;
    const s = plugin.settings;
    this.skill = opts?.skill !== undefined ? opts.skill : s.skill;
    this.model = opts?.model !== undefined ? opts.model : s.model;
    this.args = opts?.args !== undefined ? opts.args : s.args;
    this.title = opts?.title || this.skill || "Claude";
    this.sessionId = opts?.sessionId || newConversationId();
    this.resume = !!opts?.resume;
    this.pinned = !!opts?.pinned;
    // Reopened/restored tabs carry their archived grid size: spawn claude at it
    // so the --resume repaint matches (0/undefined falls back to settings).
    if (opts?.cols && opts?.rows) {
      this.lastCols = opts.cols;
      this.lastRows = opts.rows;
    }
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
      this.clearLimitReached(); // typing = moving on; drop the red limit flag
      this.scheduleAwaitScan(); // re-check the prompt after navigating/answering it
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
    this.plugin.header.refreshTabTitles();
    // The persisted open-tab snapshot stores the title; keep it current so a
    // reopened tab shows its real name (debounced, so frequent OSC updates are cheap).
    this.plugin.history.persistOpenSessions();
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
    // Schedule hard stop: the active account is forbidden right now and there is
    // nowhere to jump → cut any generation the moment it starts ("like usage ran
    // out"). The plugin throttles the accompanying Notice.
    if (this.plugin.accounts.isScheduleHardStop()) {
      this.interrupt();
      this.plugin.accounts.notifyScheduleStop();
      return;
    }
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
    this.plugin.header.refreshTabStatus();
  }

  /** Watch this session's output for a "usage/token limit reached" message and,
   *  if seen, flag the tab RED. Uses a small dedicated rolling buffer (ANSI
   *  stripped) and latches once: it stops scanning while flagged, so stale limit
   *  text left on screen can't keep re-triggering. Cleared by clearLimitReached
   *  (the user types) or restart(). */
  private maybeLimitReached(chunk: string) {
    if (this.limitReached || this.exited) return;
    this.limitBuf = (this.limitBuf + chunk).slice(-2000);
    const clean = this.limitBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (LIMIT_STOP_RE.test(clean)) {
      this.limitReached = true;
      this.limitBuf = "";
      this.plugin.header.refreshTabStatus();
    }
  }

  /** Drop the red limit flag (user moved on / restart). Fresh buffer so the next
   *  real limit message is detected again. */
  private clearLimitReached() {
    this.limitBuf = "";
    if (!this.limitReached) return;
    this.limitReached = false;
    this.plugin.header.refreshTabStatus();
  }

  /** Coalesce a screen scan after output/keystrokes. xterm parses writes
   *  asynchronously, so we wait ~80ms for the buffer to settle before reading it,
   *  and dedupe bursts into one scan. */
  private scheduleAwaitScan() {
    if (this.exited || this.awaitScanTimer != null) return;
    this.awaitScanTimer = window.setTimeout(() => {
      this.awaitScanTimer = null;
      this.maybeAwaitingInput();
    }, 80);
  }

  /** True if the terminal's VISIBLE screen currently shows an interactive prompt
   *  blocked on the user. Reads xterm's rendered viewport (the real on-screen
   *  state) rather than a byte-stream buffer: the periodic status-bar refresh would
   *  otherwise scroll the prompt's footer out of a rolling window and leave the tab
   *  stuck green, and navigating the form (which redraws it) keeps it on screen. */
  private screenShowsPrompt(): boolean {
    const term = this.term;
    if (!term) return false;
    const buf = term.buffer.active;
    const end = buf.baseY + term.rows; // bottom of the live viewport
    const start = Math.max(0, end - term.rows);
    let text = "";
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      if (line) text += line.translateToString(true) + "\n";
    }
    return looksLikePrompt(text);
  }

  /** Reconcile the RED "awaiting your answer" flag with what's on screen. The red
   *  limit flag wins, so skip while it's set. */
  private maybeAwaitingInput() {
    if (this.exited || this.limitReached) return;
    const waiting = this.screenShowsPrompt();
    if (waiting !== this.awaitingInput) {
      this.awaitingInput = waiting;
      this.plugin.header.refreshTabStatus();
    }
  }

  /** Force-drop the awaiting flag (restart). Screen scans handle the normal case. */
  private clearAwaiting() {
    if (!this.awaitingInput) return;
    this.awaitingInput = false;
    this.plugin.header.refreshTabStatus();
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

  /** Interrupt Claude's current generation (Esc). No-op once the pty has exited. */
  interrupt() {
    if (this.exited) return;
    this.send({ t: "input", d: "\x1b" });
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
  // note (Obsidian's native getLinkSuggestions + prepareFuzzySearch — see queryNotes);
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
   *  response can't clobber a newer query (or a closed picker). */
  private async searchWikilink() {
    const seq = ++this.wlSearchSeq;
    const items = await this.queryNotes(this.wlQuery);
    if (seq !== this.wlSearchSeq || !this.wlActive) return; // stale or closed
    this.wlItems = items.slice(0, 8);
    this.wlSel = 0;
    this.renderWikilinkResults();
  }

  /** Suggestions = Obsidian's native [[ suggester (`nativeNotes`): same candidate
   *  source + fuzzy matcher + sort order as the editor's own [[ popup. `path` (for
   *  the @ reference) is the file's vault-relative path. */
  private async queryNotes(
    q: string
  ): Promise<{ path: string; basename: string }[]> {
    return this.nativeNotes(q);
  }

  /** Mirrors Obsidian's native [[ autocomplete: SAME candidate source
   *  (`metadataCache.getLinkSuggestions()` — every linkable file + its aliases),
   *  matched on the FILENAME / alias with the SAME fuzzy matcher
   *  (`prepareFuzzySearch`) + `sortSearchResults`, diacritic-insensitive via
   *  `stripDiacritics`. */
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
      // Ctrl+Shift+Y -> reopen the last closed tab (Chrome's Ctrl+Shift+T is taken
      // by Obsidian for note tabs). Kept out of the pty and out of Obsidian/Electron
      // (stopPropagation prevents a page reload and Obsidian's global hotkeys).
      if (key === "y" && ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        void this.plugin.history.reopenClosedSession();
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
    // 2) OS files dropped from outside Obsidian. Electron ≥32 removed File.path
    // in favour of webUtils.getPathForFile, so try the modern API first and fall
    // back to .path on older builds.
    const dt = e.dataTransfer;
    if (dt?.files?.length) {
      let webUtils: any = null;
      try {
        webUtils = nodeRequire("electron")?.webUtils;
      } catch {
        /* old Electron / unavailable */
      }
      for (let i = 0; i < dt.files.length; i++) {
        const f = dt.files[i];
        let p: string | null = null;
        try {
          p = webUtils?.getPathForFile?.(f) || null;
        } catch {
          p = null;
        }
        if (!p) p = (f as any).path || null;
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
    this.plugin.header.updateModelBtn();
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
    this.plugin.header.updateSkillBtn();
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

  /** Two-state remote control toggle. OFF→ON just CONNECTS (sends /remote-control);
   *  the session URL is shown in Claude's own panel for the user to read/copy — we
   *  no longer auto-reopen the menu, scrape the URL, or open a browser. ON→OFF opens
   *  the menu and arrows up to "Disconnect". */
  toggleRemoteControl() {
    if (!this.child) {
      new Notice("No live session");
      return;
    }
    if (!this.remoteOn) {
      this.send({ t: "input", d: "\x15/remote-control\r" });
      this.remoteOn = true;
      this.plugin.header.updateRemoteBtn();
      new Notice("Remote control connecting… (URL shown in the Claude panel)");
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
      this.plugin.header.updateRemoteBtn();
      new Notice("Remote control off");
    }
    this.term?.focus();
  }

  /** Once claude is up, run the startup slash commands, then invoke this
   *  session's skill (/<name>) — in order, with small gaps. Runs on a fresh start. */
  private maybeSendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;
    // Recovered tab (--resume): the conversation already has its skill + startup
    // context in history. Resume clean — don't re-inject anything.
    // The [cch initial] logs are PERMANENT diagnostics (like [cch keepalive]):
    // when the skill doesn't show up, the DevTools console tells you whether the
    // injection was skipped, armed, or sent — no guessing.
    if (this.resume) {
      console.log("[cch initial] tab", this.id, "resume tab — skipping startup injection");
      return;
    }

    const steps: string[] = [];
    // NOTE: we deliberately do NOT auto-send "/model <id>" here. The user wants a
    // fresh tab to keep whatever model claude starts on by default and change it
    // themselves via the header selector. Consequence: the header's model label
    // may show session.model while claude is actually on its own default until the
    // user picks one (selectModel sends /model and re-syncs the label).
    const startup = this.plugin.settings.startupCommands || "";
    for (const line of startup.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      steps.push(line);
    }
    if (this.skill) steps.push("/" + this.skill);
    if (!steps.length) {
      console.log("[cch initial] tab", this.id, "nothing to inject (no skill / startup commands)");
      return;
    }
    console.log("[cch initial] tab", this.id, "armed:", steps.join(" · "), "(first step in 1800ms)");

    let i = 0;
    const submit = (text: string, then: () => void) => {
      if (!this.child) {
        console.log("[cch initial] tab", this.id, "ABORTED — pty gone before step:", text);
        return;
      }
      console.log("[cch initial] tab", this.id, "sending:", text);
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
    // First step after claude has settled at its prompt. Fixed delay ON PURPOSE:
    // a prompt-detection gate (screen scan + quiet window) was tried in 2026-07 and
    // reverted at the user's request — it made the injection feel much slower (its
    // 20s fallback cap kicked in when the detection missed). The restart-race that
    // motivated it is fixed by the superseded-host guard in startHost's message
    // handler, so the fixed timer anchors to the NEW claude's first output again.
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

  /** Restart = replace this tab with a BRAND-NEW session (fresh conversation).
   *  Delegates to the plugin so the flow is EXACTLY the new-tab path — same
   *  constructor, fresh terminal and the same startup injection (/skill). The old
   *  in-place relaunch (kill + term.reset + startHost on the shared terminal)
   *  raced the dying claude and the /skill paste could get swallowed. */
  restart() {
    this.plugin.restartSession(this);
  }

  /** Reload THIS tab into the EXACT SAME conversation: kill claude and relaunch it
   *  with `--resume <sessionId>` in a freshly-reset terminal at the panel's real
   *  size. Unlike restart() (fresh conversation, new id), this keeps the same
   *  sessionId + tab identity and recovers the current conversation. It's the same
   *  clean render path as Ctrl+Shift+Y / the attachView auto-restore (term.reset →
   *  startHost → fit on an empty buffer at real size), so it fixes the duplicated /
   *  garbled TUI a detached auto-restore leaves after an Obsidian restart — without
   *  losing the conversation. A blank tab (no .jsonl to resume) relaunches fresh
   *  with --session-id instead. */
  reloadSession() {
    if (!this.term) return;
    this.closeWikilinkPicker(); // don't leave the [[ popup floating over the reset
    this.limitReached = false;
    this.limitBuf = "";
    this.awaitingInput = false;
    if (this.awaitScanTimer != null) {
      window.clearTimeout(this.awaitScanTimer);
      this.awaitScanTimer = null;
    }
    this.remoteOn = false;
    this.plugin.header.updateRemoteBtn();
    // Same conversation → keep sessionId, title, titleRank, firstPromptDone. Resume
    // it with --resume if there is a .jsonl on disk (real activity); a never-used
    // blank tab has nothing to resume, so relaunch fresh with --session-id.
    this.resume = this.hasActivity();
    this.killChild();
    this.term.reset();
    this.startHost();
    this.fitNow();
    this.plugin.header.rebuildHeader();
    // resume flag may have flipped → re-snapshot the persisted open-tab entry.
    this.plugin.history.persistOpenSessions();
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
    if (this.awaitScanTimer != null) {
      window.clearTimeout(this.awaitScanTimer);
      this.awaitScanTimer = null;
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
    const parts = [base];
    if (extra) parts.push(extra);
    // Tag the conversation with our own id so it can be recovered later. Skip if the
    // user already passed a session flag in "Extra arguments" (avoid duplicates).
    const hasSessionFlag = /(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(
      extra || ""
    );
    if (this.sessionId && !hasSessionFlag) {
      parts.push(
        this.resume ? `--resume ${this.sessionId}` : `--session-id ${this.sessionId}`
      );
    }
    const full = parts.join(" ");
    console.log("[cch spawn] tab", this.id, "→", full);
    const args = isWin ? ["/c", full] : ["-lc", full];
    // Spawn at the remembered (or current) size so the first fit is a no-op.
    const cols = this.lastCols || this.plugin.settings.cols || 100;
    const rows = this.lastRows || this.plugin.settings.rows || 30;
    this.lastCols = cols;
    this.lastRows = rows;

    child.on("message", (msg: any) => {
      // Drop messages from a SUPERSEDED host (killed by restart/reload — killChild
      // nulls this.child before startHost sets the new one). The dying claude's
      // buffered output is dispatched on later event-loop ticks, i.e. AFTER
      // startHost() reset initialSent, so without this guard it (a) leaks into the
      // freshly reset terminal and (b) triggers maybeSendInitial anchored to the
      // OLD claude — the /skill paste then fires ~1.8s later, before the NEW claude
      // reaches its prompt, and its raw-mode init swallows it (skill never sent on
      // restart). A stale "exit" would even mark the new session exited.
      if (this.child !== child) return;
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
          this.maybeLimitReached(msg.d); // paint the tab red if usage limit hit
          this.scheduleAwaitScan(); // red if Claude is waiting on the user (screen scan)
          // Per-session watchers (this terminal's TUI).
          this.maybeSendInitial();
          this.maybeConfirmModel(msg.d);
          // Global watchers (shared account / usage / auto-switch), fed this
          // session's output.
          this.plugin.accounts.maybeAutoSwitch(this, msg.d);
          this.plugin.accounts.maybeAutoSaveAccount();
          this.plugin.accounts.maybeProbeOnActivity();
          break;
        case "exit":
          this.exited = true; // stop sending resizes to the dead pty
          this.closeWikilinkPicker();
          this.setBusy(false); // settle the heartbeat dot
          this.clearAwaiting(); // drop the awaiting flag; the tab is now "exited"
          if (this.busyTimer != null) {
            window.clearTimeout(this.busyTimer);
            this.busyTimer = null;
          }
          if (this.awaitScanTimer != null) {
            window.clearTimeout(this.awaitScanTimer);
            this.awaitScanTimer = null;
          }
          this.term.writeln(
            "\r\n\x1b[2m[claude exited — use the tab's Restart, or close the tab]\x1b[0m"
          );
          this.remoteOn = false;
          this.plugin.header.updateRemoteBtn();
          this.plugin.header.rebuildHeader(); // mark the tab as exited
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
  sessions: Session[] = []; // (read by AccountManager)
  activeIndex = 0; // (read/written by SessionHistory)
  // Tab persistence + reopen stack + history sidebar (see history.ts).
  history = new SessionHistory(this);
  viewRoot: HTMLElement | null = null; // (read by SessionHistory) // the panel contentEl while open

  private fontLink: HTMLLinkElement | null = null;
  // Header UI (tabs strip + toolbar) — see header.ts.
  header = new HeaderView(this);
  private tempImages: string[] = []; // temp PNGs from image paste, cleaned on unload
  // Bundled Token Dashboard server process (null when not running).
  tokenDashboardChild: any = null;

  // Accounts / usage / auto-switch / browser subsystem (see accounts.ts).
  accounts = new AccountManager(this);

  async onload() {
    await this.loadSettings();
    // Break the DEFAULT_SETTINGS aliases (loadSettings does a shallow assign):
    // on a fresh install these arrays ARE the module-level defaults, and every
    // in-place push/splice (closedSessions, autoSwitchExcluded, browserMap,
    // accountSchedules) would pollute them for later loads.
    this.settings.closedSessions = [...(this.settings.closedSessions || [])];
    this.settings.autoSwitchExcluded = [...(this.settings.autoSwitchExcluded || [])];
    this.settings.browserMap = [...(this.settings.browserMap || [])];
    this.settings.accountSchedules = [...(this.settings.accountSchedules || [])];
    // Queue the previous run's still-open tabs for restoration when the panel is
    // first shown — NOT now. Spawning a --resume session while detached (no panel,
    // so no real terminal size) makes Claude repaint its TUI at the spawn size and
    // then again after the fit, garbling the footer. Restoring on panel-open renders
    // cleanly (same as the Ctrl+Shift+Y reopen path).
    const saved = [...(this.settings.openSessions || [])].filter((s) => s.sessionId);
    this.history.pendingOpen = saved.length ? saved : null;
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
      id: "reload-claude-code",
      name: "Reload Claude Code session (same conversation)",
      callback: () => this.activeSession()?.reloadSession(),
    });

    this.addCommand({
      id: "reopen-closed-session",
      name: "Reopen closed Claude session",
      // Ctrl+Shift+T is taken by Obsidian (reopen closed note tab), so use Y.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "y" }],
      callback: () => void this.history.reopenClosedSession(),
    });

    this.addCommand({
      id: "toggle-pin-session",
      name: "Pin/unpin current Claude tab",
      callback: () => {
        const a = this.activeSession();
        if (a) this.setPinned(a, !a.pinned);
      },
    });

    this.addCommand({
      id: "open-session-history",
      name: "Open Claude session history",
      callback: async () => {
        await this.activateView();
        this.history.openHistoryMenu();
      },
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
      callback: () => this.accounts.saveCurrentAccount(),
    });

    this.addCommand({
      id: "diagnose-auto-switch",
      name: "Diagnose auto-switch (why no account change)",
      callback: () => this.accounts.diagnoseAutoSwitch(),
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

    // Start one blank background session now ONLY if there's nothing to restore.
    // If there is, we wait for the panel (restorePendingOpenSessions in attachView)
    // so restored tabs render at the right size without a garbled footer.
    if (!this.history.pendingOpen) this.ensureAtLeastOneSession();

    // Token keep-alive + live usage (see refreshAccount()). Every 3 min we CHECK
    // every account and refresh its OAuth token if it's expired/about to expire,
    // then re-probe usage; also once shortly after start.
    window.setTimeout(() => void this.accounts.refreshUsage({ refreshTokens: true }), 5000);
    this.registerInterval(
      window.setInterval(
        () => void this.accounts.refreshUsage({ refreshTokens: true }),
        3 * 60 * 1000
      )
    );

    // Enforce per-account forbidden time windows (jump away / stop Claude).
    window.setTimeout(() => this.accounts.enforceSchedule(), 8000);
    this.registerInterval(window.setInterval(() => this.accounts.enforceSchedule(), 20000));
  }

  onunload() {
    this.accounts.closeAccountMenu();
    this.history.closeHistorySidebar();
    // Best-effort final snapshot of the open tabs so Ctrl+Shift+Y can recover them
    // next launch (the debounced snapshot already covers a hard shutdown).
    if (this.history.persistOpenTimer !== null) {
      window.clearTimeout(this.history.persistOpenTimer);
      this.history.persistOpenTimer = null;
    }
    this.history.flushOpenSessions();
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
  newSession(opts?: {
    skill?: string;
    model?: string;
    args?: string;
    title?: string;
    sessionId?: string;
    resume?: boolean;
    cols?: number;
    rows?: number;
    pinned?: boolean;
  }): Session {
    if (this.viewRoot) this.activeSession()?.detachHost();
    const sess = new Session(this, opts);
    this.sessions.push(sess);
    this.activeIndex = this.sessions.length - 1;
    if (this.viewRoot) {
      this.header.rebuildHeader();
      sess.attachInto(this.viewRoot);
    }
    this.history.persistOpenSessions();
    return sess;
  }

  /** Switch the visible tab to session index `i`. */
  setActive(i: number) {
    if (i < 0 || i >= this.sessions.length) return;
    if (i === this.activeIndex && this.activeSession()?.host?.isConnected) return;
    this.history.closeHistorySidebar(); // stale overlay if the header/host is rebuilt
    if (this.viewRoot) this.activeSession()?.detachHost();
    this.activeIndex = i;
    this.header.rebuildHeader();
    if (this.viewRoot) this.activeSession()?.attachInto(this.viewRoot);
  }

  /** Pin/unpin a tab (Chrome-style). Pinning renders it compact (dot only) and
   *  moves it to the end of the pinned group at the left of the strip; unpinning
   *  leaves it in place (right after the pinned group). Pinned tabs are always
   *  persisted and restored across Obsidian runs until closed manually. */
  setPinned(sess: Session, pinned: boolean) {
    if (sess.pinned === pinned) return;
    sess.pinned = pinned;
    const idx = this.sessions.indexOf(sess);
    // Keep the pinned group contiguous at the left (the drag clamp relies on
    // it). The right slot is the same in both directions: pinning appends to
    // the end of the pinned group; unpinning (possibly from its middle) drops
    // the tab just after the remaining pinned ones.
    const target = this.sessions.filter((s) => s !== sess && s.pinned).length;
    if (idx >= 0 && idx !== target) {
      this.moveSession(idx, target); // rebuilds header + persists
      return;
    }
    this.header.rebuildHeader();
    this.history.persistOpenSessions();
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
    this.header.rebuildHeader();
    this.history.persistOpenSessions();
  }

  /** Restart a tab: archive its conversation and REPLACE it with a brand-new
   *  Session (same skill/model/args/pin and tab position, fresh conversation id).
   *  Deliberately the EXACT same code path as opening a new tab, so the startup
   *  injection (/skill) behaves identically — the previous in-place relaunch
   *  (kill + term.reset + startHost on the shared terminal) raced the dying
   *  claude and the /skill paste could get swallowed on some restarts. */
  restartSession(sess: Session) {
    const idx = this.sessions.indexOf(sess);
    if (idx < 0) return;
    // Same archival as closing the tab (reopenable via Ctrl+Shift+Y / history).
    if (sess.hasActivity()) this.history.rememberClosedSession(sess);
    const { skill, model, args, pinned } = sess;
    const cols = sess.lastCols;
    const rows = sess.lastRows;
    if (this.viewRoot && idx === this.activeIndex) sess.detachHost();
    sess.dispose();
    this.sessions.splice(idx, 1);
    this.newSession({ skill, model, args, cols, rows, pinned });
    // newSession appends + activates the fresh tab; put it back in the old slot
    // (moveSession keeps it active, rebuilds the header and re-persists the tabs).
    this.moveSession(this.sessions.length - 1, idx);
  }

  /** Close a tab: kill that instance's claude process and drop it. Keeps at
   *  least one session alive so the panel stays usable. */
  closeSession(sess: Session) {
    const idx = this.sessions.indexOf(sess);
    if (idx < 0) return;
    // Remember it for Ctrl+Shift+Y before we kill the process. Its conversation
    // survives on disk (~/.claude/projects/.../<sessionId>.jsonl), so reopening
    // can --resume it. Blank tabs are skipped (same guard as restart()): they
    // have no .jsonl, so --resume on reopen would fail on a dead conversation.
    if (sess.hasActivity()) this.history.rememberClosedSession(sess);
    if (this.viewRoot && idx === this.activeIndex) sess.detachHost();
    sess.dispose();
    this.sessions.splice(idx, 1);
    this.history.persistOpenSessions();
    if (!this.sessions.length) {
      this.activeIndex = 0;
      this.newSession(); // always keep one
      return;
    }
    if (this.activeIndex > idx) this.activeIndex--;
    else if (this.activeIndex >= this.sessions.length)
      this.activeIndex = this.sessions.length - 1;
    this.header.rebuildHeader();
    if (this.viewRoot) {
      const a = this.activeSession();
      if (a && !a.host?.isConnected) a.attachInto(this.viewRoot);
      else a?.scheduleFit();
    }
  }

  /** Mount the panel: restore the previous run's tabs (first open only), build the
   *  header (tabs + toolbar) and show the active session. Called from the view's
   *  onOpen. */
  attachView(root: HTMLElement) {
    this.viewRoot = root;
    this.history.restorePendingOpenSessions(); // re-create last session's tabs (once)
    this.ensureAtLeastOneSession(); // blank fallback if there were none
    // rebuildHeader (remove-then-build), not buildHeader: the restore loop may have
    // left a header behind, and rebuildHeader is idempotent (no-op remove on first open).
    this.header.rebuildHeader();
    const a = this.activeSession();
    if (a && !a.host?.isConnected) a.attachInto(root);
    else a?.scheduleFit();
  }

  /** Unmount the panel WITHOUT killing any session. Called from the view's onClose. */
  detachView() {
    this.history.closeHistorySidebar(); // it lives inside viewRoot
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
    if (this.header.zoomLabel) this.header.zoomLabel.setText(clamped + "px");
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
