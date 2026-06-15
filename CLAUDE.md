# CLAUDE.md

Guía para Claude Code trabajando en este plugin.

## Qué es

Plugin de Obsidian (escritorio) que abre la **TUI real de Claude Code** dentro
de un panel lateral de Obsidian. La terminal corre `claude` con `cwd` = la raíz
del vault, así que Claude Code opera directamente sobre las notas. La estética
sigue el tema de Obsidian (variables CSS).

No es un embed de la app Electron de ejemplo (`../../../claude-code-harness-basico`);
esa solo sirvió de referencia de comportamiento.

## Stack

- **Obsidian Plugin API** (`obsidian`), TypeScript.
- **xterm.js** (`@xterm/xterm` + `@xterm/addon-fit`) para renderizar la terminal.
- **node-pty** (`node-pty` ^1.1.0) para el pseudo-terminal real, ejecutado en un
  proceso Node aparte (`pty-host.js`), no en el renderer (ver Gotchas).
- **esbuild** para empaquetar (igual que el plugin `obsidian-document-chat`).

## Comandos

```bash
npm install --ignore-scripts   # node-pty trae prebuilds N-API; no se compila
npm run build                  # empaqueta main.ts -> main.js (producción)
npm run dev                    # build con watch
```

Tras `npm run build`, recargar el plugin en Obsidian (Ajustes -> Complementos de
la comunidad -> recargar, o reiniciar Obsidian).

## Ciclo de vida (clave del diseño)

La sesión (proceso ayudante + terminal xterm) **vive en la clase Plugin, no en
la View**:

- `onload()` -> `ensureSession()`: crea la `Terminal` xterm y forkea el pty-host
  (que lanza `claude`).
  Arranca al abrir Obsidian aunque el usuario no abra el panel; xterm bufferiza
  toda la salida hasta que el panel se muestra.
- La `View` (`ClaudeCodeView`) solo presenta la terminal: en `onOpen()` llama a
  `plugin.attachTo(contentEl)` (mueve el `host` al panel; `term.open()` se llama
  una sola vez), en `onClose()` llama a `plugin.detach()` (saca el `host` del DOM
  **sin matar el proceso**).
- `onunload()` (Obsidian se cierra o se desactiva el plugin): mata el PTY y
  destruye la terminal.
- Comando "Restart Claude Code session": mata y relanza `claude` en la misma
  terminal (útil si `claude` sale).

Por eso el `host` (el div donde xterm pinta) se conserva como campo del plugin y
solo se mueve entre el holder detached y el `contentEl` de la view; `term.open()`
nunca se llama dos veces (xterm no lo soporta).

## Gotchas

- **node-pty NO puede correr en el renderer de Obsidian.** node-pty 1.x crea
  siempre un `worker_threads.Worker` para drenar el pipe de salida
  (`windowsConoutConnection.js`), y el renderer falla con "The V8 platform used
  by this instance of Node does not support creating Workers". Por eso node-pty
  vive en `pty-host.js`, en un proceso aparte.
- **Hay que forkear el Node REAL del sistema, no el binario de Obsidian.**
  Obsidian tiene deshabilitado el fuse `runAsNode` de Electron, así que
  `ELECTRON_RUN_AS_NODE=1` se ignora (relanzar Obsidian.exe arranca la app, no
  Node, con el mensaje "Command line interface is not enabled"). Solución:
  `child_process.fork(hostPath, [], { execPath: <node.exe real> })`.
  `resolveNodePath()` busca `node.exe` (ajuste manual -> rutas conocidas ->
  `where node`). La comunicación es por IPC (`process.send`/`on("message")`);
  protocolo documentado en `pty-host.js`.
- **El plugin solo usa `window.require("child_process")` y `"fs"`** (builtins
  externos). El `pty-host.js` es quien hace `require("node-pty")`, desde su propio
  `node_modules`. Por eso `node-pty` y los builtins están en `external` en
  `esbuild.config.mjs`, y `pty-host.js` NO se empaqueta (se ejecuta tal cual).
- **Requiere Node.js instalado** en el sistema (configurable en ajustes:
  "Node.js path"). Si no se encuentra, el panel muestra el error y pide la ruta.
- **Renderizado de la TUI de Claude (no regresar).** Tres cosas son necesarias
  para que se vea bien (aprendido del harness de ejemplo `terminalPool.ts` /
  `PtyTerminalView.tsx`):
  1. **Resize: fit de display por frame + sync al pty con debounce + tamaño
     recordado**. CLAVE: la TUI de Claude repinta **toda** su pantalla en cada
     cambio de ancho (SIGWINCH) y, como corre en el buffer principal (no el
     alternativo, para conservar el historial al salir), cada repintado deja el
     frame anterior como scrollback. O sea, **cada resize enviado al pty cuesta un
     banner duplicado**. Por eso `fitNow(syncPty)` separa las dos mitades y
     `onContainerResize()` (que llama el `ResizeObserver`) hace: (a) **cada frame**
     un `fitNow(false)` (`requestAnimationFrame`, campo `rafFit`) que solo
     reajusta xterm al contenedor (re-wrappea el buffer existente, sin gap visual
     y SIN avisar a claude -> sin repintado -> sin líneas nuevas); (b) **al
     asentarse** la ráfaga, `scheduleFit()` (debounce ~120ms) hace `fitNow(true)`
     que sí manda el tamaño real a claude UNA vez -> un solo repintado por gesto
     de arrastre, en vez de uno por cada columna cruzada. Además `fitNow` solo
     manda `resize` si cols/rows cambian de verdad, y el tamaño se **persiste**
     (`settings.cols/rows`) para spawnear claude a ese tamaño (primer fit = no-op).
     LÍMITE conocido: queda **un** banner duplicado por gesto de resize; es
     intrínseco a la TUI inline de Claude (cualquier terminal lo hace al
     redimensionar claude). Para cero duplicados habría que fijar el ancho de
     claude y no reflowear, a costa de no usar todo el ancho del panel.
  2. **Unicode11Addon** + `term.unicode.activeVersion = "11"`: Claude usa anchos
     de emoji modernos (2 celdas); sin esto los glifos se solapan.
  3. **WebglAddon** cargado tras `term.open()` (con fallback a DOM): mantiene la
     rejilla alineada (box-drawing, cursor).
  El fit inicial es una cascada (rAF x2, 60ms, 240ms, `document.fonts.ready`),
  toda deduplicada por `fitNow()`.
- node-pty 1.1.0 es **N-API**: el prebuilt de `prebuilds/win32-x64/*.node` carga
  sin recompilar. No usar electron-rebuild.
- xterm + addon-fit **sí** se empaquetan en `main.js` (son JS puro).
- `styles.css` = `node_modules/@xterm/xterm/css/xterm.css` + ajustes de layout.
  Si se actualiza xterm, regenerar `styles.css` concatenando de nuevo.
- `claude` debe estar en el PATH. Se lanza vía shell (`cmd /c claude` en Windows)
  para que resuelva el `.cmd` del PATH. El comando es configurable en ajustes.
- Solo escritorio (`isDesktopOnly: true`): usa Node, PATH del sistema y `process`.

## Funciones / atajos / ajustes

- **Tema dinámico**: `termTheme()` lee variables CSS de Obsidian (fondo, texto,
  cursor, selección) y elige paleta ANSI clara/oscura segun `theme-light`;
  se re-aplica en el evento `css-change`.
- **Zoom de fuente**: Ctrl + / Ctrl - / Ctrl 0 (persistido en `settings.fontSize`);
  tambien botones en la cabecera. `setFontSize()` solo cambia `fontSize` y hace
  **un único `fit.fit()` + resize** (igual que el harness de referencia). NO se
  llama a `clearTextureAtlas()` ni a `term.refresh()`: el renderer WebGL
  reconstruye su atlas de glifos al cambiar la fuente, y forzar un refresh a mitad
  del resize era justo lo que dejaba el frame duplicado/garabateado al hacer zoom.
- **Copiar/pegar**: Ctrl+C (con selección) / Ctrl+Shift+C copian; Ctrl+V pega
  texto o **imagen** (guarda PNG temporal y pega la ruta); Ctrl+Shift+V fuerza
  texto; clic derecho copia/pega.
- **Ctrl+Z / Ctrl+Shift+Z**: Claude no tiene undo por carácter, asi que se mapean
  a su borrar-línea (0x15) y restaurar (0x19 = Ctrl+Y).
- **Ctrl+Enter / Shift+Enter**: nueva línea (LF 0x0a) sin enviar.
- **Cabecera** (`buildHeader`): estado (verde/rojo), selector de modelo (menú
  Haiku 4.5 / Sonnet 4.6 / Opus 4.8 -> envía `/model <id>`), botón @ (enviar nota
  activa), zoom, reiniciar (`restart()`).
- **Selector de modelo** (`selectModel`): envía `\x15/model <id>\r` (el Ctrl+U
  inicial limpia cualquier borrador para que el comando vaya en su propia línea;
  restaurable con Ctrl+Y). Argumentos válidos comprobados: `haiku`, `sonnet`,
  `opus`.
- **Comandos**: "Open Claude Code panel", "Restart Claude Code session",
  "Send active note to Claude" (inserta `@<ruta>` de la nota activa).
- **Instrucciones predefinidas**: ajuste "Extra arguments" (se anexa al comando,
  p. ej. `--append-system-prompt "..."`) e "Initial prompt". `maybeSendInitial`
  corre los `startupCommands` (p. ej. `/remote-control`) y luego el initial prompt
  cuando llega la primera salida de claude, **se abra o no el panel**. Manda el
  texto al pty con `pasteToPty()` (entrada IPC directa, con marcadores de
  bracketed-paste si el modo está activo) en vez de `term.paste()`, que requería
  la vista montada — por eso antes fallaba si nunca se abría la ventana.
- **Limpieza**: los PNG temporales del pegado se registran y se borran en
  `onunload`; al cargar se barren los `cch-paste-*.png` viejos (`sweepTempImages`).
- Todos los atajos hacen `stopPropagation` para que Obsidian no se los quede.
- **Ciclo de vida del proceso (evitar huérfanos)**: `pty-host.js` mata el PTY y
  hace `process.exit(0)` tanto al recibir `{t:"kill"}` como en el evento
  `disconnect` (cierre del canal IPC = plugin descargado / renderer cerrado).
  `killChild()` en `main.ts` envía `{t:"kill"}` y deja que el host se cierre solo,
  con un `kill()` de respaldo a los 800ms. Sin esto, en Windows `child.kill()`
  sobre el host Node no mata su árbol y el `cmd /c claude` quedaba huérfano,
  acumulando `claude.exe` en cada recarga.
- **IPC seguro**: todos los envíos al host pasan por el helper `send()`, que
  traga `ERR_IPC_CHANNEL_CLOSED` si el proceso ya salió (el `'exit'` que pone
  `this.child = null` es asíncrono).

## Estructura

```
manifest.json        metadatos del plugin (id: claude-code-harness)
package.json         deps + scripts
esbuild.config.mjs   bundling (node-pty/obsidian/electron = external)
tsconfig.json
main.ts              todo el plugin: Plugin + ItemView + SettingTab
main.js              artefacto compilado (cargado por Obsidian)
pty-host.js          proceso ayudante: corre node-pty fuera del renderer (NO se
                     empaqueta; se forkea con ELECTRON_RUN_AS_NODE)
styles.css           xterm.css + layout del panel
node_modules/        incluye node-pty con su prebuild win32-x64
```
