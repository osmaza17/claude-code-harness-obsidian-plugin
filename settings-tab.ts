// The plugin's settings page (Obsidian PluginSettingTab), extracted from main.ts.
// Global settings first, then the consolidated per-account cards (browser +
// forbidden time windows), talking to the plugin/AccountManager via this.plugin.

import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import { BROWSERS, DEFAULT_USAGE_RE, USAGE_PROBE_MODEL } from "./constants";
import type ClaudeCodeHarnessPlugin from "./main";

export class HarnessSettingTab extends PluginSettingTab {
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
          this.plugin.accounts.saveCurrentAccount();
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
          this.plugin.accounts.resetRotationBaseline();
          await this.plugin.saveSettings();
          this.plugin.header.updateAutoSwitchBtn();
          if (v) {
            void this.plugin.accounts.refreshUsage({ refreshTokens: true });
            if (this.plugin.accounts.listSavedAccounts().length < 2) {
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
          this.plugin.accounts.resetRotationBaseline();
          await this.plugin.saveSettings();
          this.plugin.header.updateAutoSwitchBtn();
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
              this.plugin.header.updateAutoSwitchBtn();
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
              this.plugin.header.updateAutoSwitchBtn();
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
          if (v) void this.plugin.accounts.refreshUsage({});
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

    const browserOptions: Record<string, string> = Object.fromEntries(
      Object.entries(BROWSERS).map(([id, b]) => [id, b.label])
    );

    new Setting(containerEl)
      .setName("Default browser")
      .setDesc(
        "Browser used to open a remote/login URL when an account has no browser of its own set below (or its email can't be read). The remote session URL only works in the browser where that Claude account is logged in."
      )
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(browserOptions)) d.addOption(id, label);
        d.addOption("default", "System default");
        d.setValue(this.plugin.settings.defaultBrowser || "chrome");
        d.onChange(async (v) => {
          this.plugin.settings.defaultBrowser = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Per-account settings")
      .setDesc(
        "Everything for each saved account in one place: usage, whether auto-switch may use it, which browser its remote/login URL opens in, and the time windows when it's forbidden."
      )
      .setHeading();

    for (const a of this.plugin.accounts.listSavedAccounts()) {
      const name = this.plugin.settings.usageProbe
        ? a.email + " — " + this.plugin.accounts.usageLabel(a.email)
        : a.email;
      const eligible = this.plugin.accounts.isAccountEligible(a.email);
      const blockedNow = this.plugin.accounts.isTimeBlocked(a.email);
      let desc = eligible
        ? "Auto-switch: allowed"
        : "Auto-switch: blocked (e.g. a friend's account — its tokens won't be spent automatically)";
      if (blockedNow)
        desc += ` · ⛔ prohibida ahora por horario (${this.plugin.accounts.scheduleBlockLabel(a.email)})`;
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addExtraButton((b) =>
          b
            .setIcon(eligible ? "repeat" : "ban")
            .setTooltip(
              eligible
                ? "Eligible for auto-switch — click to block"
                : "Blocked from auto-switch — click to allow"
            )
            .onClick(async () => {
              await this.plugin.accounts.toggleAccountEligible(a.email);
              this.display();
            })
        )
        .addButton((b) =>
          b.setButtonText("Switch").onClick(() => this.plugin.accounts.switchToAccount(a.email))
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Delete saved account")
            .onClick(() => {
              this.plugin.accounts.deleteSavedAccount(a.email);
              this.display();
            })
        );

      // Browser this account's remote/login URL opens in (its SSO/cookie lives there).
      const bmap = this.plugin.accounts.browserFor(a.email);
      const browserRow = new Setting(containerEl)
        .setClass("cch-account-sub")
        .setName("Browser")
        .setDesc("Where this account's remote/login URL opens. Default = the browser above.");
      browserRow.addDropdown((d) => {
        d.addOption("", "Use default");
        for (const [id, label] of Object.entries(browserOptions)) d.addOption(id, label);
        d.addOption("custom", "Custom path…");
        d.setValue(bmap?.browser || "");
        d.onChange(async (v) => {
          if (!v) {
            const i = this.plugin.settings.browserMap.findIndex(
              (m) => m.email.trim().toLowerCase() === a.email.trim().toLowerCase()
            );
            if (i >= 0) this.plugin.settings.browserMap.splice(i, 1);
          } else {
            this.plugin.accounts.browserFor(a.email, true)!.browser = v;
          }
          await this.plugin.saveSettings();
          this.display(); // show/hide the custom-path field
        });
      });
      if (bmap?.browser === "custom") {
        browserRow.addText((t) =>
          t
            .setPlaceholder("C:\\path\\to\\browser.exe")
            .setValue(bmap.path)
            .onChange(async (v) => {
              this.plugin.accounts.browserFor(a.email, true)!.path = v.trim();
              await this.plugin.saveSettings();
            })
        );
      }

      // Forbidden time windows for this account (auto-switch never lands here while
      // inside one; if it's the active account, the plugin jumps away or stops).
      const sched = this.plugin.accounts.scheduleFor(a.email);
      const dayLabels = ["L", "M", "X", "J", "V", "S", "D"]; // Mon..Sun (display)
      const dayNums = [1, 2, 3, 4, 5, 6, 0]; // JS getDay for each label
      const ranges = sched?.ranges || [];

      // Header for the windows block + the "Add range" button (so the button isn't
      // floating alone in an empty row, and the rows below have a clear label).
      const schedHead = new Setting(containerEl)
        .setClass("cch-account-sub")
        .setClass("cch-schedule-head")
        .setName("Forbidden time windows")
        .setDesc(
          ranges.length
            ? "Auto-switch won't use this account during these windows; if it's active when one starts, it switches away (or stops Claude if there's nowhere to go)."
            : "None. Add a window below to forbid this account at certain hours/days."
        );
      schedHead.addButton((b) =>
        b.setButtonText("Add range").onClick(async () => {
          const e = this.plugin.accounts.scheduleFor(a.email, true)!;
          e.ranges.push({ start: "23:00", end: "07:00", days: [1, 2, 3, 4, 5] });
          await this.plugin.saveSettings();
          this.display();
        })
      );

      ranges.forEach((r, ri) => {
        const row = new Setting(containerEl).setClass("cch-schedule-row");
        row.infoEl.remove(); // compact: no name/desc column
        row.controlEl.createSpan({ text: "from", cls: "cch-schedule-lead" });
        row.addText((t) =>
          t
            .setPlaceholder("23:00")
            .setValue(r.start)
            .onChange(async (v) => {
              r.start = v.trim();
              await this.plugin.saveSettings();
            })
        );
        row.controlEl.createSpan({ text: "to", cls: "cch-schedule-dash" });
        row.addText((t) =>
          t
            .setPlaceholder("07:00")
            .setValue(r.end)
            .onChange(async (v) => {
              r.end = v.trim();
              await this.plugin.saveSettings();
            })
        );
        const days = row.controlEl.createDiv({ cls: "cch-day-group" });
        dayLabels.forEach((dl, di) => {
          const dn = dayNums[di];
          const on = (r.days || []).includes(dn);
          const chip = days.createEl("button", {
            text: dl,
            cls: "cch-day-toggle",
            attr: { type: "button", "aria-label": dl, title: dl },
          });
          chip.toggleClass("cch-day-on", on);
          chip.onclick = async () => {
            r.days = r.days || [];
            const i = r.days.indexOf(dn);
            if (i >= 0) r.days.splice(i, 1);
            else r.days.push(dn);
            await this.plugin.saveSettings();
            this.display();
          };
        });
        row.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove this window")
            .onClick(async () => {
              sched!.ranges.splice(ri, 1);
              await this.plugin.saveSettings();
              this.display();
            })
        );
      });
    }

    // Browser mappings for emails that are NOT saved accounts (saved accounts set
    // their browser inline in their card above). Lets you pre-map an account you
    // haven't logged into yet; normally empty since accounts auto-save on /login.
    const savedEmails = new Set(
      this.plugin.accounts.listSavedAccounts().map((a) => a.email.trim().toLowerCase())
    );
    const orphans = this.plugin.settings.browserMap
      .map((row, i) => ({ row, i }))
      .filter(({ row }) => !savedEmails.has(row.email.trim().toLowerCase()));

    if (orphans.length) {
      new Setting(containerEl)
        .setName("Other browser mappings")
        .setDesc(
          "Browser mappings for emails that aren't saved accounts yet. Once an account is saved, set its browser from its card above instead."
        )
        .setHeading();

      for (const { row, i } of orphans) {
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
      }
    }

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add browser mapping (unsaved account)").onClick(async () => {
        this.plugin.settings.browserMap.push({ email: "", browser: "chrome", path: "" });
        await this.plugin.saveSettings();
        this.display();
      })
    );

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
        | "btnHistory"
        | "btnReload"
        | "btnZoom"
    ) =>
      new Setting(containerEl).setName(name).addToggle((t) =>
        t.setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
          this.plugin.header.rebuildHeader();
        })
      );
    buttonToggle("Send active note (@)", "btnSendNote");
    buttonToggle("Account switcher", "btnAccount");
    buttonToggle("Model selector", "btnModel");
    buttonToggle("Skill selector", "btnSkill");
    buttonToggle("Remote control", "btnRemote");
    buttonToggle("Auto-switch toggle", "btnAutoSwitch");
    buttonToggle("Token Dashboard", "btnTokenDashboard");
    buttonToggle("Session history", "btnHistory");
    buttonToggle("Reload session (same conversation)", "btnReload");
    buttonToggle("Zoom controls", "btnZoom");
    // Not a header button — the floating export pair lives over the terminal, so
    // its refresh goes through refreshExportFab, not rebuildHeader.
    new Setting(containerEl)
      .setName("Export-to-note buttons (bottom-right)")
      .setDesc("Floating buttons that save Claude's last message / the whole conversation to a new note in the vault root.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.btnExportNotes).onChange(async (v) => {
          this.plugin.settings.btnExportNotes = v;
          await this.plugin.saveSettings();
          this.plugin.refreshExportFab();
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
