"use strict";
/**
 * pty-host.js — runs node-pty in a separate Node process.
 *
 * Obsidian's renderer cannot create worker_threads, and node-pty 1.x always
 * spins up a Worker to drain the conout pipe. So we fork this file with
 * ELECTRON_RUN_AS_NODE=1 (Obsidian's binary running as plain Node, where
 * worker_threads works) and bridge data to the renderer over the IPC channel.
 *
 * Protocol (messages over process IPC):
 *   renderer -> host:  { t: "spawn", shell, args, opts }
 *                      { t: "input", d }     (keystrokes, string)
 *                      { t: "resize", cols, rows }
 *                      { t: "kill" }
 *   host -> renderer:  { t: "ready" }
 *                      { t: "data", d }      (terminal output, string)
 *                      { t: "exit", code }
 *                      { t: "error", message }
 */
const path = require("path");

let pty;
try {
  pty = require(path.join(__dirname, "node_modules", "node-pty"));
} catch (e) {
  send({ t: "error", message: "load node-pty: " + (e && e.message) });
  process.exit(1);
}

let term = null;

function send(msg) {
  if (process.send) process.send(msg);
}

process.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  try {
    switch (msg.t) {
      case "spawn": {
        const opts = Object.assign({ env: process.env }, msg.opts);
        term = pty.spawn(msg.shell, msg.args, opts);
        term.onData((d) => send({ t: "data", d }));
        term.onExit((e) => send({ t: "exit", code: e.exitCode }));
        break;
      }
      case "input":
        // Swallow errors (e.g. writing after the pty exited) so a dead session
        // doesn't flood the renderer terminal with error lines.
        try {
          if (term) term.write(msg.d);
        } catch (_) {
          /* pty gone */
        }
        break;
      case "resize":
        // Guard against degenerate sizes and a dead pty; ignore errors silently
        // (node-pty throws "Cannot resize a pty that has already exited").
        try {
          if (term && msg.cols > 0 && msg.rows > 0) term.resize(msg.cols, msg.rows);
        } catch (_) {
          /* pty gone or invalid size */
        }
        break;
      case "kill":
        cleanup();
        break;
    }
  } catch (e) {
    send({ t: "error", message: (e && e.message) || String(e) });
  }
});

// Kill the PTY and exit. Called on an explicit "kill" message and when the IPC
// channel closes (plugin unload / renderer gone) — without this the cmd/claude
// child would be orphaned, since node.kill() on the host doesn't kill its tree.
function cleanup() {
  try {
    if (term) term.kill();
  } catch (_) {
    /* already gone */
  }
  term = null;
  process.exit(0);
}

process.on("disconnect", cleanup);

// Tell the renderer we're up and node-pty loaded.
send({ t: "ready" });
