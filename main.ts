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
  // Optional text inserted into the prompt once claude has started, then
  // submitted — "predefined instructions".
  initialPrompt: string;
  // Slash commands (one per line) run at session start, BEFORE the initial
  // prompt. E.g. /remote-control.
  startupCommands: string;
  // Last model picked from the header menu (for the button label). The actual
  // model is owned by Claude (/model saves it as the default).
  model: string;
}

const DEFAULT_SETTINGS: HarnessSettings = {
  command: "claude",
  nodePath: "",
  cols: 100,
  rows: 30,
  fontSize: 14,
  args: "",
  initialPrompt: "",
  startupCommands: "/remote-control",
  model: "opus",
};

const MIN_FONT = 8;
const MAX_FONT = 40;

// Models offered in the header menu. `id` is the /model argument.
const MODELS: { id: string; label: string }[] = [
  { id: "haiku", label: "Haiku 4.5" },
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.8" },
];

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
  // Last grid size sent to the pty. We only resize when it ACTUALLY changes:
  // every resize makes the Claude TUI repaint its whole screen and pushes the
  // previous frame into scrollback, so spurious resizes stack the boot banner.
  private lastCols = 0;
  private lastRows = 0;
  private fontLink: HTMLLinkElement | null = null;
  private resizeTimer: number | null = null;
  private rafFit: number | null = null; // pending per-frame display fit during a drag
  private zoomLabel: HTMLElement | null = null;
  private statusDot: HTMLElement | null = null;
  private modelBtn: HTMLElement | null = null;
  private webgl: any = null; // WebglAddon, kept so we can clear its glyph atlas on zoom
  // After a /model switch, Claude may show a "Switch model?" confirmation. We
  // watch the stream and auto-confirm (option 1 is pre-selected).
  private awaitModelConfirm = false;
  private modelConfirmBuf = "";
  private modelConfirmDeadline = 0;
  private tempImages: string[] = []; // temp PNGs from image paste, cleaned on unload
  private initialSent = false; // whether the initial prompt was inserted this session

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

    this.addSettingTab(new HarnessSettingTab(this.app, this));

    this.sweepTempImages(); // remove leftover paste PNGs from previous runs

    // Start the session as soon as Obsidian loads, even if the user never
    // opens the panel. xterm buffers all output until the panel is shown.
    this.ensureSession();
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
    await this.activateView();
    this.ensureSession();
    if (!this.child) {
      new Notice("Claude session is not running.");
      return;
    }
    this.send({ t: "input", d: "@" + file.path + " " });
    this.term?.focus();
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
          if (cols !== this.lastCols || rows !== this.lastRows) {
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

  private updateStatus() {
    if (!this.statusDot) return;
    const running = !!this.child;
    this.statusDot.style.background = running ? "#4ade80" : "#ef4444";
    this.statusDot.title = running ? "claude code · running" : "claude code · exited";
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

  /** Once claude is up, run the startup slash commands (e.g. /remote-control),
   *  then submit the predefined initial prompt — in order, with small gaps. */
  private maybeSendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;

    const steps: string[] = [];
    const startup = this.settings.startupCommands || "";
    for (const line of startup.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      steps.push(line);
    }
    const prompt = this.settings.initialPrompt?.trim();
    if (prompt) steps.push(prompt);
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

  /** Build the panel header (status · model selector · send note · zoom ·
   *  restart). Rebuilt each time a panel opens; the persistent terminal host is
   *  appended after it. */
  private buildHeader(container: HTMLElement) {
    const header = container.createDiv({ cls: "cch-header" });
    this.statusDot = header.createSpan({ cls: "cch-dot" });
    header.createSpan({ cls: "cch-title", text: "claude code" });
    header.createDiv({ cls: "cch-spacer" });

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

    // Model selector.
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

    iconBtn("at-sign", "Send active note to Claude", () => void this.sendActiveNote());
    iconBtn("minus", "Zoom out (Ctrl -)", () => this.zoomBy(-1));
    const zl = header.createEl("button", {
      cls: "cch-btn cch-zoom",
      text: (this.settings.fontSize || 14) + "px",
    });
    zl.title = "Reset zoom (Ctrl 0)";
    zl.onclick = () => this.setFontSize(14);
    this.zoomLabel = zl;
    iconBtn("plus", "Zoom in (Ctrl +)", () => this.zoomBy(1));
    iconBtn("rotate-ccw", "Restart session", () => this.restart());

    this.updateStatus();
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
      // Only poke the pty when the grid actually changed — otherwise the Claude
      // TUI repaints and stacks its banner in scrollback on every spurious fit.
      if (syncPty && (cols !== this.lastCols || rows !== this.lastRows)) {
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
    this.updateStatus();

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
          break;
        case "exit":
          this.term.writeln(
            "\r\n\x1b[2m[claude exited — run 'Restart Claude Code session' to start a new one]\x1b[0m"
          );
          this.updateStatus();
          break;
        case "error":
          this.term.writeln("\r\n\x1b[2m[pty-host error] " + msg.message + "\x1b[0m");
          break;
      }
    });

    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.updateStatus();
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
        "Slash commands run at session start, one per line, BEFORE the initial prompt. E.g. /remote-control."
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
      .setName("Initial prompt")
      .setDesc(
        "Optional text submitted to Claude when the session starts (after the startup commands). Your predefined instructions."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.initialPrompt).onChange(async (value) => {
          this.plugin.settings.initialPrompt = value;
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
      });

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
