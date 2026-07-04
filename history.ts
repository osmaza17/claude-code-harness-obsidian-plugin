// Tab persistence + reopen + history sidebar, extracted from main.ts. One
// SessionHistory lives on the plugin (plugin.history): the persisted reopen
// stack (settings.closedSessions, Ctrl+Shift+Y), the live open-tab snapshot
// (settings.openSessions) with its restore-on-first-panel-open pass, and the
// ChatGPT-style history drawer.

import { Notice, setIcon } from "obsidian";
import type { ClosedSessionInfo } from "./types";
import { MAX_CLOSED_SESSIONS } from "./constants";
import type ClaudeCodeHarnessPlugin from "./main";
import type { Session } from "./main";

export class SessionHistory {
  constructor(readonly plugin: ClaudeCodeHarnessPlugin) {}
  // Chrome-style "reopen closed tab" (Ctrl+Shift+Y): the LIFO stack of reopenable
  // tabs now lives in settings.closedSessions (persisted), so it survives an
  // Obsidian restart. reopenClosedSession() pops one and recreates the tab with
  // --resume <sessionId> to recover its conversation. The currently-open tabs are
  // snapshotted (debounced) into settings.openSessions so they're reopenable too.
  persistOpenTimer: number | null = null;
  // Previous run's open tabs, awaiting restoration on the FIRST panel open (see
  // restorePendingOpenSessions). Non-null until consumed; while non-null and no
  // sessions exist yet, flushOpenSessions won't clobber the saved snapshot.
  pendingOpen: ClosedSessionInfo[] | null = null;

  /** Push a session's conversation metadata onto the reopen stack (Ctrl+Shift+Y /
   *  history) so it can be recovered later — its .jsonl survives on disk, so a
   *  reopen can --resume it. Capped at MAX_CLOSED_SESSIONS and persisted. Used both
   *  when closing a tab (×) and when restarting a conversation (the old one is
   *  archived before the sessionId is regenerated). No-op without a sessionId. */
  rememberClosedSession(sess: Session) {
    if (!sess.sessionId) return;
    this.plugin.settings.closedSessions.push({
      sessionId: sess.sessionId,
      skill: sess.skill,
      model: sess.model,
      args: sess.args,
      title: sess.title,
      cols: sess.lastCols,
      rows: sess.lastRows,
      closedAt: Date.now(),
      pinned: sess.pinned || undefined,
    });
    while (this.plugin.settings.closedSessions.length > MAX_CLOSED_SESSIONS)
      this.plugin.settings.closedSessions.shift();
    void this.plugin.saveSettings();
  }

  /** Chrome-style Ctrl+Shift+Y: reopen the most recently closed tab and recover
   *  its conversation via `claude --resume <sessionId>`. The stack is persisted
   *  in settings, so this works across Obsidian restarts. (Tabs left open at quit
   *  are auto-restored by restoreOpenSessions, so they don't land here.) */
  async reopenClosedSession() {
    const info = this.plugin.settings.closedSessions.pop();
    if (!info) {
      new Notice("No closed Claude sessions to reopen");
      return;
    }
    void this.plugin.saveSettings(); // persist the shorter stack so it isn't re-popped
    await this.reopenInfo(info);
  }

  /** Reopen a SPECIFIC closed session (used by the history menu, which can pick
   *  any entry — not just the most recent). Removes it from the reopen stack (by
   *  sessionId) so it doesn't linger in history while it's open again, then
   *  recreates the tab with --resume. */
  async reopenSession(info: ClosedSessionInfo) {
    const i = this.plugin.settings.closedSessions.findIndex(
      (c) => c.sessionId === info.sessionId
    );
    if (i >= 0) this.plugin.settings.closedSessions.splice(i, 1);
    void this.plugin.saveSettings();
    await this.reopenInfo(info);
  }

  /** Shared body of reopenClosedSession/reopenSession: open the panel and spawn a
   *  new tab that resumes the stored conversation. */
  async reopenInfo(info: ClosedSessionInfo) {
    await this.plugin.activateView(); // open the panel if it isn't already
    this.plugin.newSession({
      skill: info.skill,
      model: info.model,
      args: info.args,
      title: info.title,
      sessionId: info.sessionId,
      resume: true,
      cols: info.cols,
      rows: info.rows,
      pinned: info.pinned,
    });
    new Notice("Reopened session: " + info.title);
  }

  /** Remove a session from the history stack without reopening it (the × in the
   *  history menu). Its .jsonl on disk is left untouched. */
  deleteClosedSession(info: ClosedSessionInfo) {
    const i = this.plugin.settings.closedSessions.findIndex(
      (c) => c.sessionId === info.sessionId
    );
    if (i >= 0) {
      this.plugin.settings.closedSessions.splice(i, 1);
      void this.plugin.saveSettings();
    }
  }

  /** Snapshot the currently-open tabs into settings.openSessions (debounced), so
   *  that on the NEXT launch restoreOpenSessions() can re-open them automatically
   *  even though Obsidian quit without closing them. Only tabs with real activity
   *  are kept, to avoid restoring pristine blank tabs. */
  persistOpenSessions() {
    if (this.persistOpenTimer !== null) window.clearTimeout(this.persistOpenTimer);
    this.persistOpenTimer = window.setTimeout(() => {
      this.persistOpenTimer = null;
      this.flushOpenSessions();
    }, 1500);
  }

  /** Write the open-tab snapshot immediately (used by the debounce and onunload). */
  flushOpenSessions() {
    // If restoration is still pending (the panel was never opened this run), keep
    // the saved snapshot rather than clobbering it with the live session list —
    // otherwise closing Obsidian without opening the panel would lose the tabs.
    // This holds even if some session exists (rare: created without the panel
    // ever mounting), since flushing then would drop the unrestored tabs.
    if (this.pendingOpen && this.pendingOpen.length) return;
    // Pinned tabs are ALWAYS snapshotted (that's the point of the pin); unpinned
    // ones only with real activity, so blank tabs aren't restored. A pinned tab
    // with no conversation yet is marked `blank` so the restore starts it with
    // --session-id instead of --resume (there is no .jsonl to resume).
    this.plugin.settings.openSessions = this.plugin.sessions
      .filter((s) => s.sessionId && (s.hasActivity() || s.pinned))
      .map((s) => ({
        sessionId: s.sessionId,
        skill: s.skill,
        model: s.model,
        args: s.args,
        title: s.title,
        cols: s.lastCols,
        rows: s.lastRows,
        closedAt: Date.now(),
        pinned: s.pinned || undefined,
        blank: s.hasActivity() ? undefined : true,
      }));
    void this.plugin.saveSettings();
  }

  /** First panel open: RE-OPEN the tabs that were still open when Obsidian last
   *  quit, each resuming its conversation (claude --resume <sessionId>), so the user
   *  gets their workspace back automatically. Consumes pendingOpen (runs once).
   *
   *  Deferred to here (not onload) on purpose: newSession mounts each tab into the
   *  now-sized panel, so every terminal is term.open()'d and fit at the REAL size
   *  BEFORE Claude --resume renders. Doing it detached at onload made Claude paint
   *  its TUI at the spawn size and then repaint after the fit, garbling the footer.
   *
   *  newSession leaves the LAST-created tab active + mounted; we detach it and set
   *  the first tab active so attachView mounts a single host. Each tab was briefly
   *  mounted during its newSession iteration (empty buffer → clean open+fit), so
   *  even the non-active tabs render correctly when later switched to.
   *
   *  Tabs closed with × are unaffected: they still go to the history stack. We do
   *  NOT clear settings.openSessions — the restored (live) tabs re-persist themselves
   *  via persistOpenSessions (flushOpenSessions replaces, never appends → idempotent). */
  restorePendingOpenSessions() {
    const saved = this.pendingOpen;
    this.pendingOpen = null; // consume: restore at most once per run
    if (!saved || !saved.length) return;
    for (const info of saved) {
      this.plugin.newSession({
        skill: info.skill,
        model: info.model,
        args: info.args,
        title: info.title,
        sessionId: info.sessionId,
        // A blank pinned tab has no conversation → fresh start (--session-id
        // with the same id); anything else resumes its .jsonl.
        resume: !info.blank,
        cols: info.cols,
        rows: info.rows,
        pinned: info.pinned,
      });
    }
    // Detach the last-created (currently active + mounted) tab and make the first
    // active; attachView then mounts exactly that one.
    if (this.plugin.viewRoot) this.plugin.activeSession()?.detachHost();
    this.plugin.activeIndex = 0;
  }

  // --- History sidebar (reopen any past session, ChatGPT-style drawer) ------
  // A drawer that slides in from the LEFT, OVERLAYING the conversation (it does
  // not compress it) so the full session titles are readable. Mounted inside the
  // panel (viewRoot) below the header, dismissed by its × / Escape / backdrop.
  historyOverlay: HTMLElement | null = null;
  historyOverlayCleanup: (() => void) | null = null;

  closeHistorySidebar() {
    this.historyOverlayCleanup?.();
    this.historyOverlay?.remove();
    this.historyOverlay = null;
    this.historyOverlayCleanup = null;
  }

  /** Compact "3h ago" / "yesterday" label for a close timestamp. */
  relativeTime(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 0) return "just now";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day === 1) return "yesterday";
    if (day < 30) return `${day}d ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  }

  /** Toggle the conversation-history drawer: a scrollable list of previously
   *  closed sessions (most recent first), reusing the persisted closedSessions
   *  stack that also feeds Ctrl+Shift+Y. Clicking an entry reopens it in a NEW
   *  tab (via --resume). The drawer overlays the conversation from the left. */
  openHistoryMenu() {
    if (this.historyOverlay) {
      this.closeHistorySidebar();
      return;
    }
    const root = this.plugin.viewRoot;
    if (!root) return; // panel not mounted (the command opens it first)

    // Overlay covers the area BELOW the header (so the toolbar stays usable),
    // dimming the conversation; the drawer sits on its left edge.
    const headerH = root.querySelector<HTMLElement>(".cch-header")?.offsetHeight ?? 0;
    const overlay = root.createDiv({ cls: "cch-history-overlay" });
    overlay.style.top = headerH + "px";
    this.historyOverlay = overlay;

    const drawer = overlay.createDiv({ cls: "cch-history-sidebar" });

    // Title bar with a close ×.
    const bar = drawer.createDiv({ cls: "cch-hist-bar" });
    bar.createDiv({ cls: "cch-hist-title", text: "Session history" });
    const close = bar.createDiv({ cls: "cch-hist-close" });
    setIcon(close, "x");
    close.setAttr("aria-label", "Close history");
    close.onclick = () => this.closeHistorySidebar();

    const body = drawer.createDiv({ cls: "cch-hist-list" });
    const render = () => {
      body.empty();
      // Newest first: closedSessions is a stack pushed at the end.
      const list = [...this.plugin.settings.closedSessions].reverse();
      if (!list.length) {
        body.createDiv({ cls: "cch-hist-empty", text: "No closed sessions yet" });
        return;
      }
      for (const info of list) {
        const row = body.createDiv({ cls: "cch-hist-row" });
        const main = row.createDiv({ cls: "cch-hist-main" });
        main.createDiv({
          cls: "cch-hist-name",
          text: info.title || "Untitled session",
        });
        const sub = main.createDiv({ cls: "cch-hist-sub" });
        const bits: string[] = [];
        if (info.closedAt) bits.push(this.relativeTime(info.closedAt));
        if (info.skill) bits.push("/" + info.skill);
        else if (info.model) bits.push(info.model);
        sub.setText(bits.join(" · "));
        main.setAttr("aria-label", "Reopen this conversation in a new tab");
        main.onclick = () => {
          this.closeHistorySidebar();
          void this.reopenSession(info);
        };

        // × removes it from history without reopening (the .jsonl stays on disk).
        const del = row.createDiv({ cls: "cch-hist-del" });
        setIcon(del, "x");
        del.setAttr("aria-label", "Remove from history");
        del.onclick = (e) => {
          e.stopPropagation();
          this.deleteClosedSession(info);
          render(); // rebuild the list in place
        };
      }
    };
    render();

    // Click on the dim backdrop (outside the drawer) or Escape closes it.
    overlay.onmousedown = (e) => {
      if (e.target === overlay) this.closeHistorySidebar();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeHistorySidebar();
      }
    };
    setTimeout(() => document.addEventListener("keydown", onKey, true), 0);
    this.historyOverlayCleanup = () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }
}
