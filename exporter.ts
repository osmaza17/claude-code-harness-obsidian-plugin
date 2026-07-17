// Export the active session's conversation to a new note in the vault root.
// Data source: the Claude Code conversation .jsonl on disk
// (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl) — structured and reliable,
// unlike scraping the xterm buffer. Used by the floating bottom-right buttons
// and the two "Export …" commands.

import { moment, Notice, TFile } from "obsidian";
import * as path from "path";
import { nodeRequire } from "./utils";
import type ClaudeCodeHarnessPlugin from "./main";

type ConvMessage = { role: "user" | "assistant"; text: string };

/** Claude Code's project-slug encoding: each of `:`, `\`, `/`, space, `.` → one
 *  `-` (NOT collapsed — "BRAIN\.obsidian" gives "BRAIN--obsidian"). The `.` was
 *  verified against real ~/.claude/projects folders (".ade" → "-ade"); the full
 *  charset the CLI replaces is unknown — extend if a path with other punctuation
 *  ever resolves wrong. Mirrors token-dashboard/token_dashboard/db.py:_encode_slug. */
export function encodeProjectSlug(cwd: string): string {
  return cwd.replace(/[:\\/ .]/g, "-");
}

/** Path to the conversation .jsonl Claude Code writes for this session. */
function conversationJsonlPath(cwd: string, sessionId: string): string {
  const os = nodeRequire("os");
  return path.join(
    os.homedir(), ".claude", "projects", encodeProjectSlug(cwd), sessionId + ".jsonl"
  );
}

/** Text of a jsonl record's message.content: the string itself, or the joined
 *  `text` blocks when content is a block list (tool_use/tool_result are skipped). */
function contentText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

/** Parse a conversation .jsonl into ordered user/assistant text messages.
 *  Best-effort (the record format belongs to the Claude Code CLI and may change):
 *  each line is parsed in its own try/catch, records without extractable text are
 *  dropped, and obvious noise is filtered (isMeta records, `<command-…>` /
 *  `<local-command-…>` user lines from slash commands).
 *
 *  Snapshot gotcha: Claude writes 2–3 lines per assistant response (partial →
 *  final) sharing message.id but with different uuids. We dedupe by message.id,
 *  updating the earlier entry in place so the FINAL snapshot wins while the
 *  message keeps its position in the flow. */
function readConversation(file: string): ConvMessage[] {
  const fs = nodeRequire("fs");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseConversation(raw);
}

/** Pure jsonl-text → messages parser (exported for test/tests.ts). */
export function parseConversation(raw: string): ConvMessage[] {
  const msgs: ConvMessage[] = [];
  const byMsgId = new Map<string, number>(); // assistant message.id -> index in msgs
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const role = rec?.type;
      if ((role !== "user" && role !== "assistant") || rec?.isMeta) continue;
      const text = contentText(rec?.message?.content);
      if (!text) continue;
      if (role === "user" && /^<(command-|local-command)/.test(text)) continue;
      if (role === "assistant") {
        const id = rec?.message?.id;
        if (id && byMsgId.has(id)) {
          msgs[byMsgId.get(id)!].text = text; // later snapshot of the same response
          continue;
        }
        if (id) byMsgId.set(id, msgs.length);
      }
      msgs.push({ role, text });
    } catch {
      /* skip unparseable line */
    }
  }
  return msgs;
}

/** Text of Claude's last message, or null if there is none yet. */
function lastAssistantText(msgs: ConvMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return msgs[i].text;
  }
  return null;
}

/** Whole conversation as Markdown: header + alternating Usuario/Claude sections.
 *  Consecutive same-role messages are merged into one section (a single Claude
 *  turn interleaved with tool calls is stored as several assistant records). */
function conversationMarkdown(msgs: ConvMessage[], title: string): string {
  const parts = [`# ${title}`, `*Conversación de Claude Code — ${stamp()}*`];
  let prevRole: string | null = null;
  for (const m of msgs) {
    if (m.role !== prevRole) parts.push(m.role === "user" ? "## Usuario" : "## Claude");
    parts.push(m.text);
    prevRole = m.role;
  }
  return parts.join("\n\n") + "\n";
}

/** Local timestamp for note names/headers: YYYY-MM-DD HH.mm (dots — `:` is not
 *  allowed in filenames). */
function stamp(): string {
  // Obsidian's moment is typed as a namespace but callable at runtime.
  return (moment as any)().format("YYYY-MM-DD HH.mm");
}

/** Strip characters Obsidian/Windows reject in note names. */
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^\[\]]/g, "").replace(/\s+/g, " ").trim();
}

/** Create a note in the vault ROOT (deliberately — that's where the user wants
 *  these exports), dodging name collisions with a " (2)"/" (3)" suffix, then open
 *  it in a new tab. */
async function createRootNote(
  plugin: ClaudeCodeHarnessPlugin,
  baseName: string,
  content: string
): Promise<TFile | null> {
  const vault = plugin.app.vault;
  let name = `${baseName}.md`;
  for (let i = 2; vault.getAbstractFileByPath(name); i++) name = `${baseName} (${i}).md`;
  try {
    const file = await vault.create(name, content);
    void plugin.app.workspace.openLinkText(file.path, "", "tab");
    return file;
  } catch (e) {
    new Notice("Could not create the note: " + ((e as Error)?.message || e));
    return null;
  }
}

/** Messages of the active session's conversation, or null (with a Notice) when
 *  there is nothing to export yet (blank tab / .jsonl not written yet). */
function activeConversation(plugin: ClaudeCodeHarnessPlugin): ConvMessage[] | null {
  const sess = plugin.activeSession();
  if (!sess) {
    new Notice("No Claude session.");
    return null;
  }
  const file = conversationJsonlPath(plugin.vaultPath(), sess.sessionId);
  const msgs = readConversation(file);
  if (!msgs.length) {
    new Notice("This tab has no conversation to export yet.");
    return null;
  }
  return msgs;
}

/** Button 1: copy Claude's LAST message into a new note in the vault root. */
export async function exportLastMessage(plugin: ClaudeCodeHarnessPlugin) {
  const msgs = activeConversation(plugin);
  if (!msgs) return;
  const text = lastAssistantText(msgs);
  if (!text) {
    new Notice("Claude has not answered yet in this tab.");
    return;
  }
  const title = sanitizeName(plugin.activeSession()?.title || "Claude");
  const file = await createRootNote(
    plugin,
    `Claude - ${title} - último mensaje - ${stamp()}`,
    text + "\n"
  );
  if (file) new Notice("Last message saved to " + file.path);
}

/** Button 2: copy the WHOLE conversation into a new note in the vault root. */
export async function exportConversation(plugin: ClaudeCodeHarnessPlugin) {
  const msgs = activeConversation(plugin);
  if (!msgs) return;
  const title = sanitizeName(plugin.activeSession()?.title || "Claude");
  const file = await createRootNote(
    plugin,
    `Claude - ${title} - conversación - ${stamp()}`,
    conversationMarkdown(msgs, title)
  );
  if (file) new Notice("Conversation saved to " + file.path);
}
