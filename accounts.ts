// Accounts / usage / auto-switch / browser subsystem, extracted from main.ts.
// One AccountManager lives on the plugin (plugin.accounts). Everything here is
// GLOBAL (shared credentials): account snapshots + hot-swap, the live usage
// probe + OAuth keep-alive, the auto-switch decision, schedule enforcement,
// the 👤 popup and the per-account browser launching.

import { Notice, setIcon } from "obsidian";
import * as path from "path";
import type { AccountUsage } from "./types";
import {
  DEFAULT_USAGE_RE,
  SWITCH_CEILING_PCT,
  WEEKLY_CEILING_PCT,
  AUTH_FAIL_RE,
  LIMIT_STOP_RE,
  EMAIL_RE,
  USAGE_API_URL,
  USAGE_PROBE_MODEL,
  OAUTH_BETA,
  ANTHROPIC_VERSION,
  OAUTH_TOKEN_URL,
  OAUTH_CLIENT_ID,
  CLAUDE_LOGIN_URL,
  REFRESH_SKEW_MS,
  H_5H_UTIL,
  H_5H_RESET,
  H_7D_UTIL,
  H_7D_RESET,
  USAGE_FRESH_MS,
  OWNER_ACTIVE_MS,
  ACCOUNT_CACHE_MS,
  BROWSERS,
} from "./constants";
import { nodeRequire } from "./utils";
import type ClaudeCodeHarnessPlugin from "./main";
import type { Session } from "./main";

export class AccountManager {
  constructor(readonly plugin: ClaudeCodeHarnessPlugin) {}
  // --- Global account / auto-switch / usage state (shared by all sessions,
  // because every claude process reads the same ~/.claude/.credentials.json). ---
  autoSwitchCooldownUntil = 0;
  // Rotate mode: usage % captured when the current account became active.
  rotateBaselinePct: number | null = null;
  // Account email currently shown in the status bar.
  barAccountEmail: string | null = null;
  // Swap verification.
  pendingVerifyEmail: string | null = null;
  verifyDeadline = 0;
  sawStatusSinceSwitch = false;
  // Auth-failure recovery after a switch.
  authWatchUntil = 0;
  recoverAttempts = 0;
  warnedNoAccounts = false; // one-shot "need ≥2 accounts" notice
  // Schedule enforcement: throttle the "Claude stopped" notice while the active
  // account is in a forbidden window with nowhere to jump. `scheduleHardStopActive`
  // is the CACHED hard-stop state (recomputed by the 20s enforceSchedule tick) so
  // the per-output-chunk check in markActivity stays cheap (no disk I/O).
  scheduleStopNotified = false;
  scheduleHardStopActive = false;
  // Auto-save the active account whenever it changes (throttled).
  lastAutoSavedEmail = "";
  lastAutoSaveCheck = 0;
  // Disk-read caches (see ACCOUNT_CACHE_MS): maybeAutoSwitch runs on every pty
  // chunk, so these two reads must not hit the filesystem each time.
  cachedEmail: { v: string | null; at: number } = { v: null, at: 0 };
  cachedAccounts: { v: { email: string; file: string }[]; at: number } = {
    v: [],
    at: 0,
  };
  // Live usage probe cache + guards.
  accountUsage = new Map<string, AccountUsage>();
  // Owner-activity: last time each INACTIVE account's 5h % was seen rising
  // between probes — only its real owner can be spending it, so this flags
  // "hands off, the owner is using it" (blinking person icon in the 👤 menu).
  ownerActiveAt = new Map<string, number>();
  usageProbing = false;
  lastActiveProbe = 0;
  lastAutoSwitchDiag = 0; // throttle for the rotate/threshold console log
  // Last auto-switch evaluation, surfaced by the "Diagnose auto-switch" command.
  lastDiagInfo:
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


  /** Header 👤 menu: save / refresh / switch accounts, plus a section to allow or
   *  block each saved account as an AUTO-switch destination. Blocking an account
   *  (e.g. a friend's) stops the percentage-based auto-switch from ever spending
   *  its tokens; you can still switch to it manually from the list above. */
  /** Currently-open account popup, so re-opening / closing is idempotent. */
  accountPopup: HTMLElement | null = null;
  accountPopupCleanup: (() => void) | null = null;

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
    if (this.plugin.settings.usageProbe) void this.refreshUsage({});
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
    if (this.plugin.settings.usageProbe) {
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

        // Cuenta "capada" como destino de auto-switch (tope 5h/7d o token muerto):
        // rojo de aviso, PERO el cambio MANUAL sigue permitido (ignora topes), así
        // que la etiqueta sigue clicable — a diferencia de cch-acct-blocked, inerte.
        // La cuenta activa se excluye (nunca es un destino).
        const timeBlocked = this.isTimeBlocked(a.email);
        const capped =
          cur !== a.email.trim().toLowerCase() &&
          (this.isSwitchTargetCapped(a.email) || timeBlocked);
        if (capped) {
          row.addClass("cch-acct-capped");
          row.setAttr(
            "title",
            timeBlocked
              ? `Prohibida ahora por horario (${this.scheduleBlockLabel(a.email)}) — el auto-switch no salta aquí`
              : "El auto-switch no salta aquí (5h ≥90%, 7d ≥95% o token caducado)"
          );
        }

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
        if (this.plugin.settings.usageProbe) {
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

        // Blinking person = the owner is using their account right now (its
        // 5h % rose while inactive here) — don't spend it yourself.
        if (this.ownerActive(a.email)) {
          const owner = row.createDiv({ cls: "cch-acct-owner" });
          setIcon(owner, "user");
          owner.setAttr(
            "title",
            "Owner is using this account right now — avoid using it"
          );
        }

        // Right shortcut: open claude.ai in the browser mapped to THIS account
        // (where its SSO/cookie lives) so you can re-login it if it expired —
        // no need to remember which browser each account uses.
        const open = row.createDiv({ cls: "cch-acct-open" });
        setIcon(open, "log-in");
        open.setAttr(
          "aria-label",
          `Open ${this.browserLabelForAccount(a.email)} to log in to this account`
        );
        open.onclick = (e) => {
          e.stopPropagation();
          this.closeAccountMenu();
          const browserLabel = this.openLoginForAccount(a.email);
          new Notice(`Opening ${browserLabel} to log in to ${a.email}…`);
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


  // --- Account email ------------------------------------------------------

  /** The Claude account currently logged in, from ~/.claude.json. Cached for
   *  ACCOUNT_CACHE_MS (this runs on every pty chunk via maybeAutoSwitch, and
   *  ~/.claude.json can be megabytes); plugin-side writes invalidate the cache. */
  currentAccountEmail(): string | null {
    const now = Date.now();
    if (now - this.cachedEmail.at < ACCOUNT_CACHE_MS) return this.cachedEmail.v;
    let email: string | null = null;
    try {
      const fs = nodeRequire("fs");
      const os = nodeRequire("os");
      const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
      const e = JSON.parse(raw)?.oauthAccount?.emailAddress;
      email = e ? String(e).trim().toLowerCase() : null;
    } catch {
      email = null;
    }
    this.cachedEmail = { v: email, at: now };
    return email;
  }

  /** Drop the cached account email + saved-account list so the next read is
   *  fresh. Called after every plugin-side write that changes them. */
  invalidateAccountCaches() {
    this.cachedEmail.at = 0;
    this.cachedAccounts.at = 0;
  }

  // --- Account switching --------------------------------------------------
  // Claude Code stores its CLI auth in the plain file ~/.claude/.credentials.json
  // (claudeAiOauth), and the account metadata in ~/.claude.json (oauthAccount).
  // We snapshot both per account under ~/.claude/cch-accounts/<email>.json and
  // switch by writing them back — WITHOUT restarting: a live claude re-reads the
  // credentials and uses the new account on its next request (see README_TECNICO).

  accountsDir(): string {
    return path.join(nodeRequire("os").homedir(), ".claude", "cch-accounts");
  }
  credsPath(): string {
    return path.join(nodeRequire("os").homedir(), ".claude", ".credentials.json");
  }
  claudeJsonPath(): string {
    return path.join(nodeRequire("os").homedir(), ".claude.json");
  }
  accountFileName(email: string): string {
    return email.replace(/[^a-zA-Z0-9._@-]/g, "_") + ".json";
  }

  /** Write JSON atomically (temp file + rename) so a concurrent reader (the live
   *  claude re-reading credentials per request) never sees a half-written file. */
  writeJsonAtomic(file: string, obj: any) {
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
      // claude escribe .credentials.json con tokens VACÍOS al hacer logout (o
      // tras un 401 que limpia credenciales); snapshotear ese estado machacaría
      // un snapshot bueno con tokens muertos (visto en vivo: cuentas que quedan
      // "expired" para siempre). Nunca sobrescribir con credenciales vacías.
      const liveOauth = creds?.claudeAiOauth;
      if (!liveOauth?.accessToken || !liveOauth?.refreshToken) {
        console.warn(
          "[claude-code-harness] saveCurrentAccount: empty tokens for",
          email,
          "— snapshot NOT overwritten (logged out?)"
        );
        if (notify) new Notice("Not saving " + email + ": credentials are empty (logged out?).");
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
      this.invalidateAccountCaches();
      if (notify) new Notice("Saved Claude account: " + email);
      return email;
    } catch (e) {
      if (notify) new Notice("Could not save the current account.");
      console.warn("[claude-code-harness] saveCurrentAccount:", e);
      return null;
    }
  }

  /** Saved accounts (from cch-accounts/*.json), sorted by email. Cached for
   *  ACCOUNT_CACHE_MS (called from the per-chunk auto-switch path); plugin-side
   *  saves/deletes invalidate the cache. */
  listSavedAccounts(): { email: string; file: string }[] {
    const now = Date.now();
    if (now - this.cachedAccounts.at < ACCOUNT_CACHE_MS) return this.cachedAccounts.v;
    const list = this.readSavedAccounts();
    this.cachedAccounts = { v: list, at: now };
    return list;
  }

  private readSavedAccounts(): { email: string; file: string }[] {
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
      // Read ~/.claude.json BEFORE writing anything: if this read throws we
      // abort with every file intact. (Writing the credentials first left a
      // half-switched state — new tokens + old oauthAccount — and a later
      // auto-save could then snapshot the NEW account's tokens under the OLD
      // account's email, destroying its saved refresh token.)
      let cj: any = null;
      if (saved.oauthAccount) {
        cj = JSON.parse(fs.readFileSync(this.claudeJsonPath(), "utf8"));
      }
      const current = this.currentAccountEmail();
      if (current && current !== email.trim().toLowerCase()) {
        this.saveCurrentAccount(false); // preserve the outgoing account's latest token
      }
      // Atomic writes so the live claude never reads a half-written file.
      this.writeJsonAtomic(this.credsPath(), saved.credentials);
      if (cj) {
        cj.oauthAccount = saved.oauthAccount;
        this.writeJsonAtomic(this.claudeJsonPath(), cj);
      }
      this.invalidateAccountCaches();
      const target = email.trim().toLowerCase();
      this.lastAutoSavedEmail = target;
      this.rotateBaselinePct = null; // new account re-establishes its own baseline
      this.pendingVerifyEmail = target;
      this.verifyDeadline = Date.now() + 45000;
      this.sawStatusSinceSwitch = false;
      this.authWatchUntil = Date.now() + 60000;
      if (this.plugin.header.accountBtn) this.plugin.header.accountBtn.title = "Account: " + target; // optimistic
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
      this.invalidateAccountCaches();
    } catch (e) {
      console.warn("[claude-code-harness] deleteSavedAccount:", e);
    }
  }

  /** Is this saved account allowed as an AUTO-switch destination? Friends'
   *  accounts can be blocked so the plugin never spends their tokens on its own;
   *  manual switching from the menu is always allowed regardless. */
  isAccountEligible(email: string): boolean {
    return !this.plugin.settings.autoSwitchExcluded.includes(email.trim().toLowerCase());
  }

  /** Allow/block an account as an auto-switch destination (persisted). */
  async toggleAccountEligible(email: string) {
    const lower = email.trim().toLowerCase();
    const list = this.plugin.settings.autoSwitchExcluded;
    const i = list.indexOf(lower);
    if (i >= 0) list.splice(i, 1);
    else list.push(lower);
    await this.plugin.saveSettings();
  }

  /** Parse "HH:MM" → minutes since midnight, or null if malformed. */
  parseHM(s: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
    if (!m) return null;
    const h = +m[1], mn = +m[2];
    if (h > 23 || mn > 59) return null;
    return h * 60 + mn;
  }

  /** Locate (or, if create, append) the schedule entry for an account email. */
  scheduleFor(email: string, create = false) {
    const lower = email.trim().toLowerCase();
    let e = this.plugin.settings.accountSchedules.find(
      (s) => s.email.trim().toLowerCase() === lower
    );
    if (!e && create) {
      e = { email: lower, ranges: [] };
      this.plugin.settings.accountSchedules.push(e);
    }
    return e;
  }

  /** Locate (or, if create, append) the browser-map entry for an account email. */
  browserFor(email: string, create = false) {
    const lower = email.trim().toLowerCase();
    let m = this.plugin.settings.browserMap.find(
      (b) => b.email.trim().toLowerCase() === lower
    );
    if (!m && create) {
      m = { email: lower, browser: "chrome", path: "" };
      this.plugin.settings.browserMap.push(m);
    }
    return m;
  }

  /** True when `now` falls inside any forbidden window of the account. Handles
   *  same-day ranges (S<E) and overnight ranges (S>E: the post-midnight portion
   *  belongs to the START day, so the t<E slice checks YESTERDAY's day membership).
   *  Fail-safe: no schedule / no days / malformed times → false. */
  isTimeBlocked(email: string, now = new Date()): boolean {
    const e = this.scheduleFor(email);
    if (!e || !e.ranges.length) return false;
    const t = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay(); // 0=Sun … 6=Sat
    const prevDay = (day + 6) % 7;
    for (const r of e.ranges) {
      const s = this.parseHM(r.start);
      const en = this.parseHM(r.end);
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

  /** Human label of an account's forbidden ranges, for tooltips/desc. */
  scheduleBlockLabel(email: string): string {
    const e = this.scheduleFor(email);
    if (!e || !e.ranges.length) return "";
    const dn = ["D", "L", "M", "X", "J", "V", "S"]; // Sun..Sat (ES single-letter)
    return e.ranges
      .map((r) => {
        const days = (r.days || []).slice().sort((a, b) => a - b).map((d) => dn[d]).join("");
        return `${r.start}–${r.end}${days ? " " + days : ""}`;
      })
      .join(", ");
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
  weeklyMaxedOut(email: string): boolean {
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u || u.error || u.pct7d == null) return false;
    if (Date.now() - u.checkedAt >= USAGE_FRESH_MS) return false;
    return u.pct7d >= WEEKLY_CEILING_PCT;
  }

  /** True cuando `email` está INELEGIBLE como DESTINO de auto-switch por un tope de
   *  uso o un token muerto — espejo de los guards de pickNextAccount/leastUsedBelow:
   *  token caducado, 5h FRESCO ≥ techo (90), o 7d FRESCO ≥ techo semanal (95). Para
   *  marcar esas filas en rojo en el menú 👤. NO mira la lista de bloqueo manual
   *  (eso ya lo cubre cch-acct-blocked). Fail-open con datos ausentes/viejos (igual
   *  que la decisión real: sin lectura fresca → no se excluye → no rojo). */
  isSwitchTargetCapped(email: string): boolean {
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u) return false;
    if (u.error === "auth") return true;
    const fresh = Date.now() - u.checkedAt < USAGE_FRESH_MS;
    if (fresh && u.pct5h != null && u.pct5h >= SWITCH_CEILING_PCT) return true;
    if (this.weeklyMaxedOut(email)) return true; // ya gestiona frescura + ≥95
    return false;
  }

  /** Account to switch to: the **least-used** one (lowest probed 5h %), skipping
   *  dead-token accounts and any whose 7d usage is ≥ the weekly ceiling. Falls
   *  back to round-robin. Null if nowhere to go. */
  pickNextAccount(): string | null {
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
      if (this.isTimeBlocked(e)) continue; // forbidden time window
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
      if (this.isTimeBlocked(cand)) continue; // forbidden time window
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
  leastUsedBelow(maxPct: number): { email: string; pct: number } | null {
    const cur = this.currentAccountEmail();
    let best: string | null = null;
    let bestPct = Infinity;
    for (const a of this.listSavedAccounts()) {
      const lower = a.email.trim().toLowerCase();
      if (lower === cur) continue;
      if (!this.isAccountEligible(a.email)) continue;
      if (this.isTimeBlocked(a.email)) continue; // forbidden time window
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
  haveFreshUsageData(): boolean {
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
  maybeWarnNoAccounts() {
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
  accessTokenFor(email: string): string | null {
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
  async refreshAccount(email: string): Promise<boolean> {
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
      // Las rotaciones de claude solo viven en .credentials.json: si luego se
      // sale de esta cuenta con /login (no con el selector del plugin), el
      // snapshot se quedaría con un refresh token ya rotado (muerto) → 401
      // permanente en el keep-alive. Capturar aquí cada rotación lo evita.
      this.maybeResnapshotActive(lower);
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

    // Best-effort fallback when the response omits expires_in: assume hours,
    // not 0 — a zero TTL writes an already-expired expiresAt, which re-refreshed
    // (and rotated) the token on every 3-min tick against an endpoint that
    // rate-limits hard (429 observed).
    const ttl = resp.expires_in || 8 * 3600;
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

  /** If claude rotated the ACTIVE account's tokens since the last snapshot,
   *  re-save the snapshot so it always holds a live refresh token. Called from
   *  refreshAccount on each 3-min tick (cheap: two small file reads + compare). */
  maybeResnapshotActive(lower: string) {
    try {
      const fs = nodeRequire("fs");
      const live = JSON.parse(fs.readFileSync(this.credsPath(), "utf8"))?.claudeAiOauth;
      if (!live?.accessToken || !live?.refreshToken) return; // logged out — nothing to capture
      let snap: any = null;
      try {
        snap = JSON.parse(
          fs.readFileSync(path.join(this.accountsDir(), this.accountFileName(lower)), "utf8")
        );
      } catch {
        /* no snapshot yet — save below */
      }
      const so = snap?.credentials?.claudeAiOauth;
      if (so?.refreshToken === live.refreshToken && so?.accessToken === live.accessToken) return;
      console.log("[cch keepalive] active account rotated — re-snapshot", lower);
      this.saveCurrentAccount(false);
    } catch (e) {
      console.warn("[cch keepalive] resnapshot active failed:", e);
    }
  }

  /** POST the OAuth refresh-token grant. Resolves to the parsed token response on
   *  HTTP 200, or null on any error (never rejects). */
  oauthRefresh(
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
  probeUsage(token: string): Promise<AccountUsage> {
    const now = Date.now();
    const empty = (error: AccountUsage["error"]): AccountUsage => ({
      pct5h: null,
      reset5h: null,
      pct7d: null,
      reset7d: null,
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
      const model = this.plugin.settings.usageProbeModel?.trim() || USAGE_PROBE_MODEL;
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
    if (!this.plugin.settings.usageProbe || this.usageProbing) return;
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
            error: "auth",
            checkedAt: Date.now(),
          });
          continue;
        }
        const usage = await this.probeUsage(token);
        // Owner-activity detection: an INACTIVE account's 5h % can only rise
        // if its real owner is spending it (our own probe is ~1 Haiku token,
        // never a whole rounded point). Same 5h window only — a reset
        // re-baselines instead of comparing across windows.
        const prev = this.accountUsage.get(email);
        if (
          email !== cur &&
          prev != null && !prev.error && prev.pct5h != null &&
          !usage.error && usage.pct5h != null &&
          prev.reset5h === usage.reset5h &&
          usage.pct5h > prev.pct5h
        ) {
          this.ownerActiveAt.set(email, Date.now());
        }
        this.accountUsage.set(email, usage);
        await new Promise((r) => setTimeout(r, 300)); // gentle spacing
      }
      this.plugin.header.updateAutoSwitchBtn();
    } finally {
      this.usageProbing = false;
    }
  }

  /** True if this account's 5h % rose recently while inactive here — i.e. its
   *  real owner is (or just was) using it. */
  ownerActive(email: string): boolean {
    const at = this.ownerActiveAt.get(email.trim().toLowerCase());
    return at != null && Date.now() - at < OWNER_ACTIVE_MS;
  }

  /** Fresh probed 5h % for an account, or null if missing/stale/errored. */
  usagePct(email: string | null): number | null {
    if (!email) return null;
    const u = this.accountUsage.get(email.trim().toLowerCase());
    if (!u || u.error || u.pct5h == null) return null;
    if (Date.now() - u.checkedAt > USAGE_FRESH_MS) return null;
    return u.pct5h;
  }

  /** "Time left until `epoch`" as a short countdown, or "" if missing/past.
   *  Scales the units: days+hours for the 7d window, hours+minutes (or just
   *  minutes) for the 5h window. */
  resetCountdown(epoch: number | null): string {
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
  usageColor(pct: number): string {
    if (pct >= 90) return "var(--color-red)";
    if (pct >= 75) return "var(--color-orange)";
    if (pct >= 50) return "var(--color-yellow)";
    return "var(--color-green)";
  }

  /** Aligned, colour-coded title for an account in the 👤 menu. */
  accountMenuTitle(email: string, emailWidth: number): DocumentFragment {
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
    if (!this.plugin.settings.usageProbe) return;
    const now = Date.now();
    if (now - this.lastActiveProbe < 60000) return;
    this.lastActiveProbe = now;
    void this.refreshUsage({ activeOnly: true });
  }

  /** Emails of accounts we know about (saved snapshots ∪ the active one). */
  knownAccountEmails(): Set<string> {
    const set = new Set(this.listSavedAccounts().map((a) => a.email.trim().toLowerCase()));
    const cur = this.currentAccountEmail();
    if (cur) set.add(cur);
    return set;
  }

  /** Compiled usage-% regex (settings override, safe fallback to the default). */
  usageRegex(): RegExp {
    const src = this.plugin.settings.autoSwitchUsageRegex?.trim() || DEFAULT_USAGE_RE;
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
      if (this.plugin.header.accountBtn) this.plugin.header.accountBtn.title = "Account: " + barEmail;
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
      if (this.plugin.settings.autoSwitch && this.recoverAttempts < this.listSavedAccounts().length) {
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
    // Keep the LAST match in the rolling buffer: old status-bar repaints linger
    // in it, so the first match is the OLDEST % (a stale reading that delayed
    // threshold crossings). Same policy as the email scan above.
    const re = this.usageRegex();
    const gre = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpMatchArray | null = null;
    for (const mm of clean.matchAll(gre)) m = mm;
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
      if (!this.plugin.settings.autoSwitch) return "auto-switch is OFF";
      const cd = this.autoSwitchCooldownUntil - Date.now();
      if (cd > 0) return `in cooldown (${Math.ceil(cd / 1000)}s left after last switch)`;
      if (LIMIT_STOP_RE.test(clean)) {
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
      if (this.plugin.settings.autoSwitchMode === "rotate") {
        const delta = this.plugin.settings.autoSwitchDelta || 10;
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
      const th = this.plugin.settings.autoSwitchThreshold;
      if (pct < th) return `at ${pct}% (${src}); threshold is ${th}%`;
      return switchOrStay(
        `at ${pct}%`,
        `at ${pct}% ≥ threshold ${th}% — but no account has margin (<${SWITCH_CEILING_PCT}%); staying`
      );
    };

    const reason = decide();
    this.lastDiagInfo = {
      at: Date.now(),
      mode: this.plugin.settings.autoSwitchMode,
      enabled: this.plugin.settings.autoSwitch,
      pct,
      src,
      cur,
      bar: this.barAccountEmail,
      baseline: this.rotateBaselinePct,
      delta: this.plugin.settings.autoSwitchDelta,
      threshold: this.plugin.settings.autoSwitchThreshold,
      savedAccounts: this.listSavedAccounts().length,
      reason,
    };
    if (Date.now() - this.lastAutoSwitchDiag > 4000) {
      this.lastAutoSwitchDiag = Date.now();
      console.log("[cch auto-switch]", this.lastDiagInfo);
    }
  }

  /** Show the last auto-switch evaluation (why no account change fired). */
  diagnoseAutoSwitch() {
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
  requestSwitch(reason: string) {
    const next = this.pickNextAccount();
    if (!next) {
      this.maybeWarnNoAccounts();
      return;
    }
    this.triggerSwitch(next, reason);
  }

  /** Enforce per-account forbidden time windows. Runs on a timer regardless of the
   *  `autoSwitch` setting (it's a separate hard rule). If the ACTIVE account is in a
   *  forbidden window: jump to another eligible account if one exists; otherwise
   *  stop Claude (interrupt any in-flight generation) and notify once. The 20s
   *  tick is a backstop — markActivity() also cuts generations promptly. */
  enforceSchedule() {
    const cur = this.currentAccountEmail();
    if (!cur || !this.isTimeBlocked(cur)) {
      this.scheduleHardStopActive = false;
      this.scheduleStopNotified = false;
      return;
    }
    const next = this.pickNextAccount(); // skips time-blocked/capped/ineligible/dead
    if (next) {
      this.scheduleHardStopActive = false;
      this.scheduleStopNotified = false;
      if (Date.now() < this.autoSwitchCooldownUntil) return;
      this.triggerSwitch(next, "blocked by schedule");
    } else {
      this.scheduleHardStopActive = true;
      for (const s of this.plugin.sessions) if (s.busy) s.interrupt();
      this.notifyScheduleStop();
    }
  }

  /** One-shot "Claude stopped by schedule" notice (re-armed when the window ends). */
  notifyScheduleStop() {
    if (this.scheduleStopNotified) return;
    this.scheduleStopNotified = true;
    new Notice(
      "La cuenta activa está prohibida ahora por horario y no hay otra a la que saltar — Claude detenido."
    );
  }

  /** Common path for an automatic switch: set cooldown, reset state, notify, swap. */
  triggerSwitch(next: string, reason: string) {
    this.autoSwitchCooldownUntil = Date.now() + 10000;
    this.rotateBaselinePct = null; // recapture baseline for the new account
    // Drop the trigger text from every session's rolling buffer: a "limit
    // reached" message (or an old %) lingering there would re-fire another
    // switch after each cooldown until 3000 chars of new output pushed it out.
    for (const s of this.plugin.sessions) s.autoSwitchBuf = "";
    new Notice(`Claude account ${reason} — switching to ${next}…`);
    this.switchToAccount(next);
  }

  /** Open claude.ai in the browser MAPPED TO A SPECIFIC account (not the active
   *  one) so the user can re-login that account in the right browser — the one
   *  where its SSO/cookie lives — without remembering the pairing. Falls back to
   *  the default browser if the account has no mapping. Brings the window to the
   *  foreground but does NOT toggle fullscreen (you're logging in, not viewing). */
  openLoginForAccount(email: string): string {
    const e = email.trim().toLowerCase();
    const map = this.plugin.settings.browserMap.find(
      (m) => m.email.trim().toLowerCase() === e && !!e
    );
    const browser = map?.browser || this.plugin.settings.defaultBrowser || "chrome";
    return this.launchBrowser(browser, map?.path || "", CLAUDE_LOGIN_URL, false);
  }

  /** The browser this account is (or would be) opened in — for labels/tooltips. */
  browserLabelForAccount(email: string): string {
    const e = email.trim().toLowerCase();
    const map = this.plugin.settings.browserMap.find(
      (m) => m.email.trim().toLowerCase() === e && !!e
    );
    const browser = map?.browser || this.plugin.settings.defaultBrowser || "chrome";
    if (browser === "default") return "default browser";
    if (browser === "custom")
      return map?.path ? path.basename(map.path) : "default browser";
    return BROWSERS[browser]?.label || browser;
  }

  /** Launch a specific browser with the URL (new tab in the running instance). */
  launchBrowser(
    browser: string,
    customPath: string,
    url: string,
    fullscreen = true
  ): string {
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
          this.focusFullscreen(
            path.basename(customPath).replace(/\.exe$/i, ""),
            fullscreen
          );
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
      this.focusFullscreen(def.proc, fullscreen);
      return def.label;
    } catch {
      openDefault();
      return "default browser";
    }
  }

  /** Bring the just-launched browser window to the foreground and (optionally)
   *  toggle fullscreen (F11). Best-effort, fire-and-forget. Pass fullscreen=false
   *  to only raise the window (e.g. a re-login flow). */
  focusFullscreen(proc: string, fullscreen = true) {
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
        ...(fullscreen
          ? ["  Start-Sleep -Milliseconds 350", "  $w.SendKeys('{F11}')"]
          : []),
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
}
