// Header UI, extracted from main.ts. One HeaderView lives on the plugin
// (plugin.header): the tabs strip (pinned/compressed tabs, Chrome-style drag,
// rename, per-tab heartbeat painting), the toolbar buttons reflecting the
// ACTIVE session, and the header menus (new-session, auto-switch config).

import { Notice, setIcon, Menu } from "obsidian";
import { MODELS } from "./constants";
import type ClaudeCodeHarnessPlugin from "./main";
import type { Session } from "./main";

export class HeaderView {
  constructor(readonly plugin: ClaudeCodeHarnessPlugin) {}
  // Header button refs (single header, reflecting the ACTIVE session + global state).
  zoomLabel: HTMLElement | null = null;
  modelBtn: HTMLElement | null = null;
  skillBtn: HTMLElement | null = null;
  accountBtn: HTMLElement | null = null; // (relabelled live by AccountManager)
  autoSwitchBtn: HTMLElement | null = null; // green while auto-switch is ON
  remoteBtn: HTMLElement | null = null;
  historyBtn: HTMLElement | null = null;

  /** Interactive Chrome-style tab drag. The dragged tab follows the pointer
   *  (translateX) while the other tabs slide to open a slot for it; on release
   *  the session order is committed. A press with no movement is a plain click
   *  that just activates the tab. Uses pointer events (HTML5 DnD can't animate
   *  the siblings smoothly). */
  beginTabDrag(e: PointerEvent, tabsEl: HTMLElement, from: number) {
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
    // Chrome-style pin regions: pinned tabs occupy the leftmost slots, and a
    // drag can't cross the boundary (a pinned tab stays in the pinned group,
    // an unpinned one stays after it).
    const draggedPinned = this.plugin.sessions[from]?.pinned ?? false;
    const pinnedCount = this.plugin.sessions.filter((s) => s.pinned).length;
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
      // Clamp to the dragged tab's pin region so the groups never interleave.
      if (draggedPinned) idx = Math.min(idx, pinnedCount - 1);
      else idx = Math.max(idx, pinnedCount);
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

    // Always clear the inline drag styles before committing: if the index didn't
    // change (e.g. dragged a corner tab past the edge) moveSession is a no-op and
    // won't rebuild, so without this the tab would stay where the cursor left it
    // instead of snapping back into its slot.
    const clearDragStyles = () => {
      for (const t of tabEls) {
        t.style.transform = "";
        t.style.transition = "";
        t.style.zIndex = "";
        t.style.position = "";
      }
      dragged.removeClass("cch-tab-dragging");
    };
    const unlisten = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };

    const onUp = () => {
      unlisten();
      if (started) {
        clearDragStyles();
        if (to !== from) this.plugin.moveSession(from, to); // rebuilds the header
      } else {
        this.plugin.setActive(from); // it was a click, not a drag
      }
    };

    // Aborted drag (pen/touch cancel, pointer capture lost): revert without
    // committing — previously this left the listeners and transforms hanging.
    const onCancel = () => {
      unlisten();
      if (started) clearDragStyles();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  }


  // --- Header buttons reflecting the active session -----------------------

  updateModelBtn() {
    if (!this.modelBtn) return;
    const id = this.plugin.activeSession()?.model ?? this.plugin.settings.model;
    this.modelBtn.setText(MODELS.find((m) => m.id === id)?.label ?? "Model");
  }

  updateSkillBtn() {
    if (!this.skillBtn) return;
    const skill = this.plugin.activeSession()?.skill ?? this.plugin.settings.skill;
    this.skillBtn.title = "Skill: " + (skill || "none");
  }

  /** Reflect the active session's remoteOn on the header button (green when ON). */
  updateRemoteBtn() {
    if (!this.remoteBtn) return;
    const on = this.plugin.activeSession()?.remoteOn ?? false;
    this.remoteBtn.toggleClass("cch-active", on);
    this.remoteBtn.title = on
      ? "Remote control ON — click to disconnect"
      : "Activate remote control (/remote-control)";
  }

  /** Reflect the auto-switch state on its header button (green = ON), with a
   *  tooltip summarising the active mode + percentage. */
  updateAutoSwitchBtn() {
    if (!this.autoSwitchBtn) return;
    const on = this.plugin.settings.autoSwitch;
    this.autoSwitchBtn.toggleClass("cch-active", on);
    const mode = this.plugin.settings.autoSwitchMode || "threshold";
    const detail =
      mode === "rotate"
        ? "rotate every +" + (this.plugin.settings.autoSwitchDelta || 10) + "%"
        : "at " + (this.plugin.settings.autoSwitchThreshold || 90) + "%";
    this.autoSwitchBtn.setAttr("aria-label", "Auto-switch accounts");
    this.autoSwitchBtn.title = on
      ? "Auto-switch ON (" + detail + ") — click to configure"
      : "Auto-switch OFF — click to enable";
  }

  /** Menu to toggle auto-switch and pick its mode + percentage from the header. */
  openAutoSwitchMenu(anchor: HTMLElement) {
    const menu = new Menu();
    const s = this.plugin.settings;

    menu.addItem((item) =>
      item
        .setTitle(s.autoSwitch ? "Auto-switch is ON" : "Auto-switch is OFF")
        .setIcon(s.autoSwitch ? "toggle-right" : "toggle-left")
        .setChecked(s.autoSwitch)
        .onClick(async () => {
          s.autoSwitch = !s.autoSwitch;
          this.plugin.accounts.resetRotationBaseline();
          await this.plugin.saveSettings();
          this.updateAutoSwitchBtn();
          if (s.autoSwitch) {
            // Refresh + probe every account now so the first destination pick uses
            // fresh, alive tokens instead of waiting for the next 3-min tick.
            void this.plugin.accounts.refreshUsage({ refreshTokens: true });
            if (this.plugin.accounts.listSavedAccounts().length < 2) {
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
            this.plugin.accounts.resetRotationBaseline();
            await this.plugin.saveSettings();
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
            this.plugin.accounts.resetRotationBaseline();
            await this.plugin.saveSettings();
            this.updateAutoSwitchBtn();
          })
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("More options…")
        .setIcon("settings")
        .onClick(() => this.plugin.openSettings())
    );

    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom });
  }


  // --- Header (tabs + toolbar) -------------------------------------------

  /** Build the panel header: a row of session tabs (each with a close ×, plus a
   *  + button to spawn a new instance) over the toolbar (@ · model · account ·
   *  skill · remote · auto-switch · zoom · settings · restart). The toolbar acts
   *  on the ACTIVE session. Rebuilt whenever the active session or the set of
   *  sessions changes; the terminal host is appended after it. */
  buildHeader(container: HTMLElement) {
    // Drop stale references from a previous build (a hidden button stays null).
    this.modelBtn = null;
    this.skillBtn = null;
    this.accountBtn = null;
    this.remoteBtn = null;
    this.autoSwitchBtn = null;
    this.historyBtn = null;
    this.zoomLabel = null;

    const header = container.createDiv({ cls: "cch-header" });
    const s = this.plugin.settings;

    // --- Tab strip: one tab per session + a "new session" button. ---
    const tabs = header.createDiv({ cls: "cch-tabs" });
    this.plugin.sessions.forEach((sess, i) => {
      const st = this.tabState(sess);
      const tab = tabs.createDiv({
        cls:
          "cch-tab " +
          st.cls +
          (i === this.plugin.activeIndex ? " cch-tab-active" : "") +
          (sess.pinned ? " cch-tab-pinned" : ""),
      });
      const dot = tab.createSpan({ cls: "cch-tab-dot " + st.cls });
      dot.setAttr("aria-label", st.label);
      tab.setAttr("title", this.tabTooltip(sess, st.label));
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
        this.plugin.closeSession(sess);
      };
      // Right-click: pin/unpin + close (a pinned tab hides its ×, like Chrome,
      // so this menu is also how it gets closed).
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle(sess.pinned ? "Unpin tab" : "Pin tab")
            .setIcon("pin")
            .onClick(() => this.plugin.setPinned(sess, !sess.pinned))
        );
        menu.addItem((item) =>
          item
            .setTitle("Close tab")
            .setIcon("x")
            .onClick(() => this.plugin.closeSession(sess))
        );
        menu.showAtMouseEvent(e);
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
        void this.plugin.sendActiveNote()
      );
    }

    bar.createDiv({ cls: "cch-spacer" });

    // Model selector (active session's model).
    if (s.btnModel) {
      const id = this.plugin.activeSession()?.model ?? s.model;
      const modelBtn = bar.createEl("button", {
        cls: "cch-btn cch-model",
        text: MODELS.find((m) => m.id === id)?.label ?? "Model",
      });
      modelBtn.title = "Select model";
      this.modelBtn = modelBtn;
      modelBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        const a = this.plugin.activeSession();
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
      const curEmail = this.plugin.accounts.barAccountEmail || this.plugin.accounts.currentAccountEmail();
      accountBtn.setAttr("aria-label", "Claude account");
      accountBtn.title = "Account: " + (curEmail || "unknown");
      accountBtn.onclick = (e) => {
        e.preventDefault();
        this.plugin.accounts.openAccountMenu(accountBtn);
      };
    }

    // Skill selector (active session's skill).
    if (s.btnSkill) {
      const skillBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(skillBtn, "sparkles");
      const cur = this.plugin.activeSession()?.skill ?? s.skill;
      skillBtn.setAttr("aria-label", "Skill");
      skillBtn.title = "Skill: " + (cur || "none");
      this.skillBtn = skillBtn;
      skillBtn.onclick = (e) => {
        e.preventDefault();
        const menu = new Menu();
        const a = this.plugin.activeSession();
        const skills = this.plugin.listSkills();
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
            .onClick(() => this.plugin.openSkillsFolder())
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
        this.plugin.activeSession()?.toggleRemoteControl();
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
        void this.plugin.launchTokenDashboard();
      };
    }

    if (s.btnZoom) {
      iconBtn("minus", "Zoom out (Ctrl -)", () => this.plugin.zoomBy(-1));
      const zl = bar.createEl("button", {
        cls: "cch-btn cch-zoom",
        text: (this.plugin.settings.fontSize || 14) + "px",
      });
      zl.title = "Reset zoom (Ctrl 0)";
      zl.onclick = () => this.plugin.setFontSize(14);
      this.zoomLabel = zl;
      iconBtn("plus", "Zoom in (Ctrl +)", () => this.plugin.zoomBy(1));
    }

    iconBtn("settings", "Plugin settings", () => this.plugin.openSettings());

    // History (right side, just left of Restart): a ChatGPT-style drawer of
    // previously-closed sessions reopenable in a new tab (reuses the reopen
    // stack; global). Right-to-left order: Restart · Reload · History · Settings · Zoom.
    if (s.btnHistory) {
      const histBtn = bar.createEl("button", { cls: "cch-btn" });
      setIcon(histBtn, "history");
      histBtn.setAttr("aria-label", "Session history");
      histBtn.title = "Session history (reopen a past conversation)";
      this.historyBtn = histBtn;
      histBtn.onclick = (e) => {
        e.preventDefault();
        this.plugin.history.openHistoryMenu();
      };
    }

    // Reload the SAME conversation (kill + `claude --resume` in a clean terminal).
    // Fixes the duplicated/garbled TUI left by an auto-restored tab after an
    // Obsidian restart, without losing the conversation. Distinct from Restart,
    // which starts a fresh conversation.
    if (s.btnReload) {
      iconBtn("refresh-cw", "Reload session (same conversation)", () =>
        this.plugin.activeSession()?.reloadSession()
      );
    }

    iconBtn("rotate-ccw", "Restart session", () => this.plugin.activeSession()?.restart());

    // Keep the header as the first child so it survives a rebuild (rebuildHeader
    // removes the old one and calls this while the terminal host is already in).
    container.prepend(header);
  }

  /** Menu shown by the + tab button: spawn a new session with a chosen skill. */
  openNewSessionMenu(anchor: HTMLElement) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("New session (default skill)")
        .setIcon("plus")
        .onClick(() => this.plugin.newSession())
    );
    menu.addItem((item) =>
      item.setTitle("New session (no skill)").onClick(() => this.plugin.newSession({ skill: "" }))
    );
    const skills = this.plugin.listSkills();
    if (skills.length) {
      menu.addSeparator();
      for (const sk of skills) {
        menu.addItem((item) =>
          item.setTitle("New: /" + sk).onClick(() => this.plugin.newSession({ skill: sk }))
        );
      }
    }
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom });
  }

  /** Rebuild the header in the open panel (tabs + toolbar), preserving the
   *  mounted terminal host. Also called from the settings tab as refreshHeader. */
  rebuildHeader() {
    if (!this.plugin.viewRoot) return;
    this.plugin.viewRoot.querySelector(".cch-header")?.remove();
    this.buildHeader(this.plugin.viewRoot);
  }

  refreshHeader() {
    this.rebuildHeader();
  }

  /** Update just the tab labels in place (cheap; avoids a full header rebuild on
   *  every auto-title change). Walks the TABS (in session order) and finds each
   *  one's label — a flat label list would shift indexes while one tab's label is
   *  replaced by the inline-rename input, mislabelling the tabs after it. */
  refreshTabTitles() {
    if (!this.plugin.viewRoot) return;
    const tabs = this.plugin.viewRoot.findAll(".cch-tabs .cch-tab");
    this.plugin.sessions.forEach((sess, i) =>
      tabs[i]
        ?.querySelector<HTMLElement>(".cch-tab-label")
        ?.setText(sess.title || "Claude")
    );
  }

  /** Update the per-tab heartbeat dot in place (busy / idle / exited) without a
   *  full header rebuild. Dots are in session order, so index aligns. */
  /** Shared tab state: drives both the heartbeat dot and the tab border colour.
   *  Priority: exited (grey) > limit reached (red) > awaiting user (orange) >
   *  busy (yellow) > idle (green). Awaiting outranks busy so the prompt-draw chunk
   *  (which also marks the session busy) shows orange immediately. */
  tabState(sess: Session): { cls: string; label: string } {
    if (sess.exited) return { cls: "is-exited", label: "Exited" };
    if (sess.limitReached) return { cls: "is-limit", label: "Usage limit reached" };
    if (sess.awaitingInput)
      return { cls: "is-await", label: "Waiting for your answer" };
    if (sess.busy) return { cls: "is-busy", label: "Working…" };
    return { cls: "is-idle", label: "Idle" };
  }

  /** Tab tooltip: a pinned tab hides its label, so hover must show its NAME
   *  (plus the state); a normal tab just shows the state. */
  tabTooltip(sess: Session, stateLabel: string): string {
    return sess.pinned
      ? `📌 ${sess.title || "Claude"} — ${stateLabel}`
      : stateLabel;
  }

  refreshTabStatus() {
    if (!this.plugin.viewRoot) return;
    const states = ["is-busy", "is-idle", "is-exited", "is-limit", "is-await"];
    const tabEls = this.plugin.viewRoot.findAll(".cch-tabs .cch-tab");
    const dots = this.plugin.viewRoot.findAll(".cch-tabs .cch-tab-dot");
    this.plugin.sessions.forEach((sess, i) => {
      const st = this.tabState(sess);
      const dot = dots[i];
      if (dot) {
        dot.removeClasses(states);
        dot.addClass(st.cls);
        dot.setAttr("aria-label", st.label);
      }
      const tab = tabEls[i];
      if (tab) {
        tab.removeClasses(states);
        tab.addClass(st.cls);
        tab.setAttr("title", this.tabTooltip(sess, st.label));
      }
    });
  }

  /** Inline-edit a tab title (double-click). Commits on Enter/blur as a "manual"
   *  title (which outranks the auto sources), cancels on Escape. */
  startTabRename(tab: HTMLElement, label: HTMLElement, sess: Session) {
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
}
