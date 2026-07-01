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

**Varias instancias en paralelo.** Cada instancia de Claude Code es una
**`Session`** (clase en `main.ts`): su propia `Terminal` xterm, su `host` DOM y su
proceso forkeado pty-host (que lanza `claude`). El **plugin es el gestor**:
mantiene `sessions: Session[]` + `activeIndex` y un único panel con una **barra de
pestañas** (una por sesión). Solo la sesión activa está montada en el panel; el
resto siguen corriendo y bufferizando su salida en xterm (igual que cuando el
panel está cerrado). `pty-host.js` **no cambió**: una instancia = un fork (sin
multiplexar, protocolo IPC intacto).

Reparto de responsabilidades:

- **`Session`** (estado por-instancia): `term`/`host`/`child`/`fit`/`webgl`,
  resize/fit, clipboard, el **data handler**, y los watchers **propios de su TUI**
  (`maybeSendInitial`, `maybeConfirmModel`, remote-control: `toggleRemoteControl`/
  `maybeAfterRemoteActive`/`maybeCaptureRemoteUrl`/`fireRemoteMenu`), más su
  **config propia** (`skill`, `model`, `args`, `title`). `attachInto(parent)` monta
  el host (llama `term.open()` una sola vez; luego solo mueve el host dentro/fuera
  del DOM), `detachHost()` lo desmonta sin matar, `dispose()` mata y destruye.
- **Plugin** (gestor + servicios globales): `newSession`/`closeSession`/
  `setActive`/`activeSession`, `attachView`/`detachView`, y todo lo **compartido**
  porque depende de las credenciales comunes: cuentas, usage/keep-alive,
  auto-switch (decisión), navegador, tema, zoom y tamaño de rejilla. Los watchers
  globales se alimentan de la salida de cada sesión:
  `plugin.maybeAutoSwitch(session, chunk)` (usa el buffer **por-sesión**
  `session.autoSwitchBuf` pero la decisión —cooldown, baseline, verify— es
  **global**), `maybeAutoSaveAccount`, `maybeProbeOnActivity`.
- `onload()`: **encola** las pestañas que estaban abiertas al cerrar Obsidian en
  `pendingOpen` para restaurarlas al **abrir el panel** (NO en `onload`; ver
  `restorePendingOpenSessions` en la sección de persistencia — restaurar detached
  corrompía la TUI). Si no hay nada que restaurar, crea **una** `Session` en blanco
  (arranca aunque no se abra el panel). Hay un único `css-change` registrado que
  re-tematiza todas las sesiones (`s.applyTheme()`).
- La `View` (`ClaudeCodeView`, un único `VIEW_TYPE`/leaf) solo presenta: `onOpen()`
  -> `plugin.attachView(contentEl)` (construye cabecera+pestañas y monta el host de
  la activa), `onClose()` -> `plugin.detachView()` (desmonta **sin matar**).
- **Cierre de pestaña (×)** -> `closeSession()` mata esa instancia; si no queda
  ninguna, crea una nueva (el panel nunca queda muerto). **Cerrar el panel** no
  mata nada. `onunload()` mata **todas** las sesiones. Antes de `dispose()`,
  `closeSession` apila la config de la sesión (`sessionId`/skill/model/args/title/
  cols/rows) en `settings.closedSessions` (LIFO, tope `MAX_CLOSED_SESSIONS`=25,
  **persistido en disco** vía `saveSettings`) para poder reabrirla, vía el helper
  compartido **`rememberClosedSession(sess)`** (lo usa también `restart()` para
  archivar la conversación vieja al reiniciar). Ambos llamadores lo guardan con
  `if (hasActivity())`: una pestaña en blanco no tiene `.jsonl`, así que reabrirla
  lanzaría `claude --resume` sobre una conversación inexistente.
- **Persistencia entre sesiones de Obsidian (clave del reopen + auto-restauración).**
  La persistencia ya NO es solo en memoria: `closedSessions` (pila de reopen) vive en
  `settings` (data.json) y, además, las pestañas que siguen **abiertas** se snapshotean
  en `settings.openSessions`.
  - `persistOpenSessions()` (debounce ~1,5 s) vuelca a `settings.openSessions` los
    tabs abiertos **con actividad O pineados** (`Session.hasActivity()` =
    `firstPromptDone || titleRank>0 || resume`, para no restaurar tabs en blanco;
    el `resume` incluye los tabs reabiertos/restaurados, que nacen con `titleRank=0`
    y sin primer prompt pero sí tienen conversación —si no, se descartarían y no se
    podrían re-restaurar—; un tab **pineado** se snapshotea SIEMPRE, con `blank:true`
    si aún no tiene conversación para que la restauración use `--session-id` en vez
    de `--resume`). Se llama
    desde `newSession`/`closeSession`/`moveSession`/`Session.restart` (cambia el
    `sessionId`) y `Session.setTitleFrom` (el título se persiste). `onunload` hace
    un `flushOpenSessions()` directo (best-effort; el debounce ya cubre el apagón
    duro, porque `saveData` es asíncrono y puede no vaciarse al cerrar el SO).
  - **`restorePendingOpenSessions()` (auto-restauración; corre en el PRIMER
    `attachView`, no en `onload`):** re-abre **automáticamente** cada tab encolado en
    `pendingOpen` (snapshot de `settings.openSessions` leído en `onload`) como pestaña
    **viva**, vía `newSession({...info, resume:true})` (recupera su conversación con
    `--resume`), en su orden original, y deja activa la **primera** (detacha la última,
    que `newSession` deja montada, y pone `activeIndex=0`). `attachView` luego usa
    `rebuildHeader()` (idempotente) en vez de `buildHeader` —el bucle de restauración
    deja una cabecera— y monta el host activo. Consume `pendingOpen` (`=null`) para
    restaurar **una sola vez** por ejecución. Así, al reabrir Obsidian y abrir el panel,
    **reaparecen las mismas pestañas** que tenías, sin reabrirlas a mano.
    - **CLAVE (por qué en `attachView` y no en `onload`):** restaurar detached (panel
      cerrado, sin tamaño de terminal real) hacía que `claude --resume` **repintara su
      TUI al tamaño de arranque** en el buffer de xterm y, al abrir el panel, `term.open()`
      sobre ese buffer lleno + el fit al tamaño real mandaba **otro** repintado encima →
      **footer duplicado/entremezclado** (bug real observado con "bypass permissions").
      Restaurando en `attachView`, cada `newSession` monta su tab en el panel **ya
      dimensionado**: `term.open()`+fit ocurren sobre buffer **vacío** al tamaño real
      **antes** de que Claude renderice (misma ruta limpia que Ctrl+Shift+Y). Incluso los
      tabs no-activos se montan un instante durante su iteración del bucle (buffer vacío →
      open+fit correcto), así que renderizan bien al cambiarse a ellos.
    - **NO** vacía `settings.openSessions`: los tabs restaurados (vivos) se re-persisten
      solos (`flushOpenSessions` **reemplaza**, no anexa → idempotente); `flushOpenSessions`
      además **no pisa** el snapshot mientras `pendingOpen` siga sin consumir
      (cerraste Obsidian sin abrir el panel → conserva los tabs para el próximo
      arranque, aunque exista alguna sesión creada sin llegar a montar el panel).
    - Los `cols`/`rows` archivados viajan por las opts de `newSession`/`Session`
      hasta `lastCols/lastRows`, así el `claude --resume` arranca al tamaño que
      tenía la pestaña (también en el reopen de Ctrl+Shift+Y / historial).
    - En `onload` **no** se crea sesión en blanco si hay `pendingOpen` (se espera al
      panel); sí se crea una si no hay nada que restaurar (comportamiento previo).
    - CAVEAT (honesto): al abrir el panel se lanzan **N procesos `claude --resume`** (uno
      por tab). Las pestañas cerradas con × siguen yendo a `closedSessions` (historial /
      Ctrl+Shift+Y), no se auto-restauran.
- **Reabrir pestaña cerrada (Ctrl+Shift+Y, estilo Chrome)** -> `reopenClosedSession()`
  hace `pop()` de `settings.closedSessions` (+ `saveSettings` para no re-popearla) y
  `newSession({...info, resume:true})`. CLAVE: cada
  `Session` lleva un **`sessionId` UUID propio** (`newConversationId()` en el
  constructor) que se inyecta como `--session-id <uuid>` al arrancar `claude` (en
  `startHost`, **NO** en `settings.args`, que es global). Eso fija el id de la
  conversación de Claude Code (`~/.claude/projects/<cwd>/<id>.jsonl`) de forma
  **determinista** —imprescindible porque hay varias sesiones en el mismo cwd y
  "el .jsonl más reciente" no las desambigua—, así que al reabrir se lanza
  `claude --resume <uuid>` y se **recupera la conversación** exacta. Con `resume:true`,
  `maybeSendInitial` sale temprano (**no** reinyecta `/skill` ni startup commands: la
  conversación ya los trae). `restart()` regenera el `sessionId` (conversación nueva,
  evita choque de `--session-id` con el `.jsonl` ya existente) y, **antes de regenerarlo**,
  **archiva la conversación vieja en el historial** (`plugin.rememberClosedSession(this)`,
  solo si `hasActivity()`) para que NO se pierda: queda reabrible con **Ctrl+Shift+Y** y en
  el **sidebar de historial**, con su `.jsonl` intacto en disco. Tras archivar, `restart`
  **resetea la identidad del tab** (`title`=skill|"Claude", `titleRank=0`, `firstPromptDone`
  =false, `firstPromptBuf`="") para que la conversación nueva estrene su propio nombre y la
  archivada conserve su título en el historial. `startHost` no inyecta
  el flag si el usuario ya puso `--session-id`/`--resume`/`-c` en "Extra arguments".
  VERIFICADO (en `-p`): `claude --session-id <uuid>` crea el `.jsonl` y
  `claude --resume <uuid>` recupera la conversación. CAVEAT (honesto): solo se probó
  en modo `--print`; el arranque interactivo con `--session-id` es muy probable pero
  no se verificó turno a turno; y cuánto scrollback repinta la TUI al resumir es
  variable (el contexto sí se recupera).
- Comando "Restart Claude Code session" -> `activeSession().restart()`. Comando
  **"New Claude Code session"** y el botón **+** de la barra -> `newSession({skill})`.
  Comando **"Reopen closed Claude session"** (hotkey **`Mod+Shift+Y`**) + intercepción
  de **Ctrl+Shift+Y** en el key handler del terminal (como Ctrl+R) ->
  `reopenClosedSession()`. NO se usa Ctrl+Shift+T: Obsidian lo reserva para reabrir
  pestañas de notas y lo captura globalmente antes de que llegue al harness.
- **Sidebar de historial (drawer estilo ChatGPT/Claude web)** -> `openHistoryMenu()`
  (toggle) / `closeHistorySidebar()`: botón de cabecera (icono `history`, toggle
  `btnHistory`, colocado **a la izquierda del todo, junto al botón @**) + comando
  **"Open Claude session history"**. En vez de un popup, abre un **cajón lateral que
  se SUPERPONE** sobre la conversación (no la comprime): un `div` `.cch-history-overlay`
  montado **dentro del `viewRoot`** (posición `absolute`, `top` inline = altura del
  `.cch-header` medida con `offsetHeight`, así la toolbar sigue usable), que atenúa el
  resto y contiene el `.cch-history-sidebar` (ancho ~340px, desliza desde la izquierda).
  Cierre por su × / Escape / click en el backdrop (`overlay.onmousedown` cuando
  `target===overlay`); refs `historyOverlay`/`historyOverlayCleanup`, limpiadas en
  `onunload`, `detachView` (vive dentro de `viewRoot`) y `setActive` (evita overlay
  obsoleto al reconstruir header/host). REQUIERE panel montado (`viewRoot`); el comando
  hace `activateView()` antes. Reutiliza **la misma pila persistida
  `settings.closedSessions`** que alimenta Ctrl+Shift+Y (no una fuente nueva): la
  renderiza como lista **más-reciente-primero** (`[...closedSessions].reverse()`), cada
  fila con el título + subtítulo (`relativeTime(closedAt)` "3h ago"/"yesterday" ·
  skill/modelo). Click en la fila -> `reopenSession(info)` reabre **esa** conversación
  (no solo la última) en una **pestaña nueva** vía `--resume` y la **quita** de la pila
  (por `sessionId`, para que no quede en el historial mientras está abierta; al cerrarla
  se re-apila). La × de cada fila -> `deleteClosedSession(info)` la borra del historial
  **sin** reabrir (el `.jsonl` en disco queda intacto) y re-renderiza la lista in situ.
  `reopenClosedSession`/`reopenSession` comparten `reopenInfo(info)` (activateView +
  `newSession({...info, resume:true})` + Notice). CAVEAT: el historial es la pila de
  reopen (tope `MAX_CLOSED_SESSIONS`=25 metadatos, cerradas + plegadas de la sesión
  anterior); NO lista **todas** las conversaciones del disco (los `.jsonl` viejos no
  purgados no aparecen si su metadato ya salió de la pila). `ClosedSessionInfo` lleva
  ahora `closedAt?` (epoch ms, opcional; sellado en `closeSession` y `flushOpenSessions`).

Por eso cada `host` (el div donde xterm pinta) se conserva en su `Session` y solo
se mueve entre fuera-del-DOM y el `contentEl` del panel; `term.open()` nunca se
llama dos veces por sesión (xterm no lo soporta).

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
     ROBUSTEZ (bug del cambio de theme): `fitNow`/`setFontSize` solo mandan resize
     si `cols>=2 && rows>=2` y `!this.exited`. El reflow al cambiar de theme dejaba
     el panel a 0px un instante y se enviaba un resize degenerado que mataba al
     conpty; y tras `exit` los resizes seguían golpeando un pty muerto. El flag
     `exited` (set en `case "exit"`, reset en `startHost`) corta eso, y `pty-host`
     ahora traga errores de `resize`/`input` (con guarda `cols>0 && rows>0`) sin
     inundar la terminal con `Cannot resize a pty that has already exited`.
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
  4. **Scroll congelado tras cambiar de pestaña (`resyncAfterReattach`)**. Solo la
     sesión activa está montada; al cambiar de pestaña `setActive` hace
     `detachHost()` (saca el host del DOM) + `attachInto()` (lo re-mete). Como el
     panel NO cambia de tamaño, `fitNow()`/`fit.fit()` son **no-op** y xterm nunca
     recalcula la **altura scrollable de su viewport** → la rueda/scrollbar se
     quedan **congeladas** (no subes ni bajas) hasta que la siguiente escritura del
     pty fuerza un render; pulsar una tecla saltaba al fondo (scroll-on-input de
     xterm), que parecía la única forma de "desbloquearlo". Fix: `attachInto`
     detecta el re-montaje (`reattach = this.opened`) y llama `resyncAfterReattach()`
     (en el rAF y a 120ms), que fuerza el recálculo con un **round-trip de resize
     `rows-1 → rows` sobre xterm SOLO** (nunca manda `{t:"resize"}` al pty, así que
     Claude no repinta su banner; el tamaño intermedio no llega a pintarse porque
     ambos resizes corren en el mismo frame) + `refresh()`.
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
- **Zoom de fuente**: Ctrl + / Ctrl - / Ctrl 0, **Ctrl + rueda del ratón**
  (listener `wheel` en el `host`, `passive:false`, llama `zoomBy`), y botones en la
  cabecera (persistido en `settings.fontSize`). `setFontSize()` (plugin) es
  **global**: persiste y recorre las sesiones llamando a `session.applyFontSize`,
  que cambia `fontSize` y hace **un único `fit.fit()` + resize** por sesión. NO se
  llama a `clearTextureAtlas()` ni a `term.refresh()`: el renderer WebGL
  reconstruye su atlas de glifos al cambiar la fuente, y forzar un refresh a mitad
  del resize era justo lo que dejaba el frame duplicado/garabateado al hacer zoom.
- **Copiar/pegar**: Ctrl+C (con selección) / Ctrl+Shift+C copian; Ctrl+V pega
  texto o **imagen** (guarda PNG temporal y pega la ruta); Ctrl+Shift+V fuerza
  texto; clic derecho copia/pega.
- **Ctrl+Z / Ctrl+Shift+Z**: Claude no tiene undo por carácter, asi que se mapean
  a su borrar-línea (0x15) y restaurar (0x19 = Ctrl+Y).
- **Ctrl+Enter / Shift+Enter**: nueva línea (LF 0x0a) sin enviar.
- **Cabecera** (`buildHeader`): dos filas dentro de `.cch-header` (que ahora es
  `flex-direction:column`):
  1. **Barra de pestañas** (`.cch-tabs`): una pestaña `.cch-tab` por `Session`
     (etiqueta = `session.title`, con × `.cch-tab-close` → `closeSession`; click en
     la pestaña → `setActive(i)`; `.cch-tab-active` marca la activa; `.cch-tab-exited`
     tacha la que salió). Al final, botón **+** (`.cch-tab-new`) → `openNewSessionMenu()`
     (crea sesión con skill por defecto / sin skill / con una skill de `listSkills()`).
     - **Pestañas pineadas (estilo Chrome)** (`Session.pinned`, persistido como
       `ClosedSessionInfo.pinned`): **click derecho** en una pestaña abre un menú
       (Obsidian `Menu`) con "Pin/Unpin tab" y "Close tab"; también hay comando
       **"Pin/unpin current Claude tab"**. `setPinned(sess, on)` marca la sesión y
       la **mueve al final del grupo pineado** (los pineados ocupan siempre los
       huecos de la izquierda; `beginTabDrag` **clampa** el índice destino a la
       región del tab arrastrado para que los grupos no se entremezclen). Una
       pestaña pineada se pinta **compacta** (`.cch-tab-pinned`: ancho fijo 30px,
       solo el punto de estado; label y × ocultos por CSS — se cierra desde su menú
       contextual, como en Chrome) y su tooltip lleva `📌 título — estado`
       (`tabTooltip`, usado por `buildHeader` y `refreshTabStatus`). CLAVE de la
       persistencia: un tab pineado **se restaura SIEMPRE** al reabrir Obsidian
       (entra en `settings.openSessions` aunque no tenga actividad; si está en
       blanco se marca `blank:true` y se restaura con `--session-id` en vez de
       `--resume`), hasta que el usuario lo cierre manualmente. El pin viaja
       también por `closedSessions` (reabrir desde historial/Ctrl+Shift+Y recupera
       el estado pineado) y sobrevive a `restart()`.
     - **Compresión + ancho uniforme (no scroll lateral por defecto)**: todas las
       pestañas tienen **el mismo ancho** en todo momento y se **encogen** juntas
       al abrir más (`.cch-tab` = `flex: 1 1 0`: basis cero + grow/shrink iguales,
       reparte el strip a partes iguales; crecen juntas hasta `max-width:180px`) en
       vez de aparecer un scroll horizontal. El piso es
       `min-width:52px`, suficiente para mostrar **siempre** el punto + el × (la
       etiqueta `.cch-tab-label` es `flex:0 1 auto; min-width:0` y se recorta con
       ellipsis primero; el dot y `.cch-tab-close` son `flex:0 0 auto`, no encogen).
       Solo si ni a ese piso caben todas, `.cch-tabs` (`overflow-x:auto`) hace
       scroll. El drag de reorden sigue intacto: `beginTabDrag` mide los anchos
       reales con `getBoundingClientRect()`, así que opera sobre el ancho comprimido.
     - **Reordenar (drag interactivo, estilo Chrome)**: NO usa HTML5 DnD (no anima
       los hermanos). Cada `.cch-tab` engancha `pointerdown` → `beginTabDrag(e, tabs, i)`:
       umbral de 4px para distinguir clic de arrastre (un clic sin mover llama
       `setActive(from)`); al arrastrar, la pestaña sigue al puntero con
       `translateX(dx)` (clase `.cch-tab-dragging`, elevada) y **los hermanos se
       deslizan** (con transición) para abrir el hueco donde caerá (cada uno se
       desplaza ±`slot` = ancho de la arrastrada + gap 4px). El índice destino `to`
       = nº de pestañas que deben quedar **antes** de la arrastrada: cada vecino
       reacciona cuando el centro visual de la arrastrada cruza un punto a `frac`
       (0.25) dentro de él desde el borde que mira al arrastre (umbral pequeño =
       se aparta antes; 0.5 sería el punto medio). Al soltar (`pointerup`),
       `moveSession(from, to)` hace splice del
       array `sessions` (= orden de pestañas) dejándola en el índice final `to` y
       **conservando la sesión activa** (re-localiza por referencia). El rebuild de
       la cabecera limpia los estilos inline del drag.
     - **Auto-título** (precedencia `manual(3) > osc(2) > prompt(1) > default(0)`,
       campo `Session.titleRank` + `setTitleFrom(raw, source)`): el nombre se
       actualiza solo para distinguir pestañas. Fuente primaria = **título de
       terminal que Claude emite por OSC** (`term.onTitleChange` → `"osc"`, sigue
       vivo según la tarea; `setTitleFrom` recorta el glifo de estado inicial
       —✳/✶/✻…— que Claude antepone a su título OSC, porque el heartbeat ya indica
       eso, e **ignora títulos OSC genéricos** —"Claude", "Claude Code" o el nombre
       del vault— para que NO bloqueen el respaldo: en la práctica el título OSC de
       Claude suele ser genérico, así que el nombre real de la pestaña casi siempre
       sale del primer prompt). Respaldo = **primer prompt que escribes**
       (`captureFirstPrompt` en `term.onData`: acumula la primera línea, commit en
       Enter como `"prompt"`, una sola vez vía `firstPromptDone`; ignora ctrl/escapes,
       maneja backspace; los comandos de arranque/skill van por `pasteToPty`, NO por
       `onData`, así que no contaminan el título). **Doble clic** en la etiqueta →
       `startTabRename()` (input inline, Enter/blur = `"manual"`, Escape cancela);
       el rango manual gana a las fuentes automáticas. `setTitleFrom` limpia control
       chars + colapsa espacios + trunca a 40, y refresca con `refreshTabTitles()`
       (actualiza solo los `.cch-tab-label` in situ, sin rebuild completo).
     - **Heartbeat por pestaña** (`.cch-tab-dot` **+ el borde de la `.cch-tab`**,
       estados `is-busy`/`is-idle`/`is-exited`/`is-limit`/`is-await`): un punto sólido
       (sin animación) **y el reborde de la pestaña del mismo color** indican si Claude
       está **trabajando** (amarillo), **ha terminado/inactivo** (verde), **salió**
       (gris), **se detuvo al alcanzar el límite de uso/tokens** (rojo, con leve
       tinte de fondo) o **está esperando tu respuesta** (también rojo con leve tinte
       —mismo color que el límite, se distinguen por el tooltip—; ver "Estado rojo
       esperando respuesta"). Un único helper `tabState(sess)` decide clase+etiqueta
       con prioridad `exited > limitReached > awaitingInput > busy > idle`, y lo usan
       **buildHeader** (al construir) y **refreshTabStatus** (in situ: recorre
       `.cch-tab` y `.cch-tab-dot`, quita los 5 estados y re-aplica). El busy se infiere de la
       **actividad del PTY**: `markActivity()` (en `case "data"`) marca `busy=true`
       y rearma un timer de hueco silencioso (1200 ms) que lo devuelve a idle
       —Claude emite tokens / anima su spinner mientras piensa o responde, y enmudece
       al devolver el control—. Para no pulsar mientras **tú** escribes, ignora la
       salida que llega <600 ms tras una pulsación (eco de teclado; `lastKeyAt` se
       fija en `term.onData`). El `case "exit"` y `dispose()` apagan el timer; salir
       asienta el punto.
       - **Estado rojo "límite alcanzado"** (`limitReached`): `maybeLimitReached(chunk)`
         (en `case "data"`, tras `markActivity`) vigila la salida con un buffer
         rodante propio (ANSI quitado) y, si casa `LIMIT_STOP_RE` —regex **best-effort**,
         estricta a propósito: SIN el `resets at` suelto que sale en la barra de
         estado normalmente, para no dar falsos positivos (es también el disparador
         de respaldo del auto-switch; la antigua `LIMIT_RE`, que sí incluía `resets at`,
         se eliminó porque provocaba switches espurios en cada cooldown)—,
         **engancha** el flag (deja de
         escanear mientras esté activo, así el texto viejo en pantalla no re-dispara) y
         pinta la pestaña de rojo. Se **limpia** al teclear (`clearLimitReached` en
         `term.onData`: seguir escribiendo = continuar) o en `restart()`. CAVEAT honesto:
         el texto exacto de Claude al agotar el límite puede cambiar; si el rojo nunca
         se enciende o se enciende mal, ajustar `LIMIT_STOP_RE`. NO cubre la parada por
         **franja horaria** (eso es otra cosa; ver auto-switch), solo el límite de uso.
       - **Estado rojo "esperando tu respuesta"** (`awaitingInput`): resuelve el
         problema de que cuando Claude **te pregunta** (prompt de permiso, aprobación de
         plan, o un **cuestionario `AskUserQuestion`**) se queda **en silencio**
         esperando, así que el heartbeat lo daba por **terminado** (verde) y no se
         distinguía "acabó" de "necesita que respondas". Pinta la pestaña de **rojo**
         (clase `is-await`, mismo color rojo que `is-limit`; ahora se distinguen a
         simple vista porque **`is-await` PARPADEA** —flash duro on/off ~1s vía
         `@keyframes cch-await-blink` (punto) y `cch-await-tab-blink` (borde+fondo de la
         pestaña), con `steps(1,end)` para un parpadeo brusco y no un fundido— mientras
         que `is-limit` queda en rojo **fijo**; el parpadeo señala que hay una **acción
         pendiente** que debes hacer para que Claude continúe. Además el tooltip los
         separa: "Waiting for your answer" vs "Usage limit reached".
         - **Parpadea SOLO si el cuestionario está en una pestaña NO activa** (te dice
           "ve a esa pestaña a responder"); si el cuestionario está en la pestaña **activa**,
           se queda en **rojo fijo** (te recuerda "aún no has respondido; hazlo para que
           Claude siga"). Puro CSS: las reglas de 3 clases
           `.cch-tab.is-await.cch-tab-active` y `.cch-tab-active .cch-tab-dot.is-await` ponen
           `animation:none` + rojo fijo, y ganan por especificidad a las reglas de parpadeo
           de 2 clases. Funciona en vivo porque `setActive`→`rebuildHeader` reasigna
           `cch-tab-active` al cambiar de pestaña, y `refreshTabStatus` (que actualiza las
           clases `is-*` in situ) no toca `cch-tab-active`.
         - **Detección leyendo la PANTALLA renderizada, no el flujo de bytes**
           (`screenShowsPrompt`): recorre las filas **visibles** del buffer de xterm
           (`term.buffer.active`, de `baseY` a `baseY+rows`, `translateToString(true)`) y
           casa `PROMPT_WAIT_RE` contra ese texto. CLAVE (bug que dejaba la pestaña
           clavada en verde): el primer intento usaba un **buffer rodante de bytes** de
           2500 chars, pero Claude **refresca su barra de estado** periódicamente aunque
           esté inactivo, y esos bytes **empujaban el pie del formulario fuera de la
           ventana** → la lógica creía que el prompt ya no estaba → verde. Leer la
           pantalla real es inmune a eso (la barra de estado no "desplaza" lo visible) y
           además **navegar el formulario** (que lo repinta) lo mantiene detectado.
         - **`looksLikePrompt(text)`** (best-effort, con **guarda anti-falsos-positivos**):
           los fragmentos sueltos del pie ("Esc to cancel"…) también pueden salir en la
           **prosa** de Claude (p. ej. explicando un atajo), así que un solo fragmento NO
           basta. Da true si: (a) casa una **frase específica** de permiso/plan
           (`PROMPT_SENTENCE_RE`: "Do you want to proceed/make/…", "No, and tell Claude
           what to do…", "Would you like to proceed" — frases completas, raras de pasada);
           **o** (b) aparecen **a la vez** una pista de **navegación** (`PROMPT_NAV_HINT_RE`:
           "keys to navigate", "arrow/tab … navigate", **o los glifos de flecha `↑ ↓ ← →` …
           navigate** —algunas versiones del CLI imprimen "↑/↓ to navigate" sin la palabra
           "arrow"/"keys", y eso se colaba antes dejando la pestaña en verde—) **y** una de **acción**
           (`PROMPT_ACT_HINT_RE`: "enter to select/submit/confirm", "esc to cancel"), que es
           el **pie multi-parte** que imprimen los menús reales ("Enter to select · Tab/Arrow
           keys to navigate · Esc to cancel") y que la prosa casi nunca combina. Las pistas
           del pie son **independientes del idioma** (el pie va en inglés aunque la pregunta
           esté en español; verificado contra un formulario `AskUserQuestion` en español).
           Como **seguro barato** por si un CLI futuro/localizado tradujera el pie, las regex
           aceptan **también los verbos franceses** ("naviguer", "Entrée/Échap pour
           sélectionner/valider/annuler", con o sin acentos); no verificado en vivo (nunca se
           ha visto el pie traducido), pero no añade falsos positivos porque sigue exigiendo
           nav+act juntos.
         - **Disparo y limpieza**: `scheduleAwaitScan()` (en `case "data"` tras
           `maybeLimitReached`, y en `term.onData`) **deduplica** los escaneos con un
           timer de ~80 ms —xterm parsea sus writes de forma asíncrona, así que se espera
           a que el buffer se asiente antes de leerlo—. `maybeAwaitingInput()` es
           **bidireccional**: refleja exactamente si la pantalla muestra el prompt, así
           que cuando Claude **reanuda** (el formulario desaparece de pantalla) o tú
           respondes, el siguiente escaneo lo apaga solo. `restart()` y `case "exit"`
           (vía `clearAwaiting`) lo resetean y matan el timer. Prioriza sobre `busy`.
         CAVEAT honesto: el texto/glifo exactos de Claude pueden cambiar entre versiones
         del CLI; si un cuestionario concreto no enciende el rojo (o enciende de más),
         ajustar `PROMPT_SENTENCE_RE`/`PROMPT_NAV_HINT_RE`/`PROMPT_ACT_HINT_RE`
         (idealmente copiando el texto real del prompt).
  2. **Toolbar** (`.cch-toolbar`): botón @ (enviar nota activa, a la activa), **botón
     de historial** (icono `history`, pegado al @ en el extremo izquierdo;
     `openHistoryMenu()` abre el drawer lateral —ver "Sidebar de historial"), selector
     de modelo (Haiku/Sonnet/Opus → `activeSession().selectModel`), selector de
     cuenta (icono `user-round`; **global**), selector de skill (icono `sparkles`;
     skills de `~/.claude/skills` **+ "Open skills folder"** → `activeSession().selectSkill`),
     **toggle remote control** (icono `smartphone`; `activeSession().toggleRemoteControl()`),
     **toggle auto-switch** (icono `repeat`; **global**; `openAutoSwitchMenu()` con
     modo Threshold/Rotate y presets —threshold 70/80/85/90/95; rotate +5/10/15/20/25—;
     estado por `updateAutoSwitchBtn()`), **Token Dashboard** (icono `bar-chart-3`),
     zoom (**global**, aplica a todas), ajustes (`openSettings()`), reiniciar
     (`activeSession().restart()`).
  Los botones modelo/skill/remote reflejan la **sesión activa**
  (`updateModelBtn`/`updateSkillBtn`/`updateRemoteBtn` leen `activeSession()`); cuenta,
  auto-switch e historial son globales. Cada botón (salvo ajustes/reiniciar) se oculta
  desde ajustes (`btnSendNote/btnAccount/btnModel/btnSkill/btnRemote/btnAutoSwitch/
  btnTokenDashboard/btnHistory/btnZoom`).
  `rebuildHeader()` (alias `refreshHeader()` para la página de ajustes) borra
  `.cch-header` y la reconstruye **conservando el host montado** (es un hijo aparte
  del contenedor); `buildHeader` resetea las refs a null y hace `container.prepend(header)`
  para que la cabecera quede como primer hijo. Se rellama en cada `setActive`/
  `newSession`/`closeSession` y al salir una sesión (para marcar la pestaña).
- **Cambio de cuenta (hot-swap, sin reinicio)**: Claude Code guarda su auth en el
  fichero plano `~/.claude/.credentials.json` (`claudeAiOauth`) y los metadatos de
  cuenta en `~/.claude.json` (`oauthAccount`). El plugin snapshotea ambos por cuenta
  en `~/.claude/cch-accounts/<email>.json` (`saveCurrentAccount`). `switchToAccount`
  **escribe** las credenciales guardadas de vuelta y actualiza `oauthAccount`, y
  **NO reinicia**: un proceso claude vivo re-lee `.credentials.json` y usa la cuenta
  nueva en su **siguiente petición** (confirmado por el usuario: las instancias ya
  abiertas cambian solas), así que la sesión sigue sin interrupción y sin perder la
  conversación. ORDEN seguro: lee y valida TODO (el snapshot destino y
  `~/.claude.json`) **antes** de escribir nada — si una lectura falla se aborta con
  los ficheros intactos (escribir las credenciales primero dejaba un estado a
  medias que un auto-save posterior podía convertir en un snapshot corrupto de la
  cuenta saliente). Antes de escribir, re-snapshotea la cuenta saliente (conserva su
  token recién refrescado; mitiga la rotación de refresh tokens). Como no hay
  reinicio, la skill NO se reinyecta al cambiar (sin lógica extra). UI: botón de
  cabecera (icono `user-round`; "Save current account" + lista para cambiar),
  comando "Save current Claude account", y sección "Claude accounts" en ajustes
  (guardar / cambiar / borrar + auto-switch). `~/.claude/cch-accounts` NO se
  versiona (tokens sensibles).
  **Auto-guardado** (`maybeAutoSaveAccount`, enganchado en `data`, throttle ~10s):
  cuando la cuenta activa (`currentAccountEmail`) cambia respecto a la última vista
  (p. ej. tras un `/login`), se snapshotea sola; así cada cuenta en la que inicias
  sesión queda guardada sin pulsar nada (avisa la primera vez que guarda una nueva).
- **Auto-switch** (`maybeAutoSwitch`, enganchado en el handler `data`): opt-in
  (`settings.autoSwitch`, off por defecto). Fuente del % de uso de 5h de la cuenta
  activa: **primero el scraping** de la barra de estado
  (`/5h:[^\n]{0,40}?(\d{1,3})\s*%/`, con la guarda de anclaje) y, si no hay lectura
  raspable, **fallback a la API** (`usagePct()`, ver "Live usage" abajo), para que
  el cambio de cuenta siga funcionando aunque algún día se oculte la barra.
  - **Techo duro del 90 % (`SWITCH_CEILING_PCT`, siempre 10 % de margen)**: regla
    **absoluta** que **prevalece sobre los modos/threshold**. En cuanto la cuenta
    activa llega a **≥90 %**, el plugin intenta saltar a la **cuenta elegible menos
    gastada que siga por debajo del 90 %**. **Única excepción**: si **todas** las
    demás cuentas están **≥90 %** (o ninguna es elegible), **se queda** en la cuenta
    actual y la apura hasta el límite —saltar no ganaría margen—. Implementado en
    `decide()` con `leastUsedBelow(90)` (destino con hueco) + `haveFreshUsageData()`
    (distingue "todas maxeadas" de "aún sin datos"): si no hay **ningún** dato
    fresco de uso cae a `pickNextAccount()` (round-robin) para no quedarse clavado
    en setups sin sondeo; si hay datos pero nadie baja del 90 %, se queda a propósito.
  - **Por debajo del 90 %** mandan los **modos** (`settings.autoSwitchMode`):
    **threshold** (intenta cambiar al cruzar `autoSwitchThreshold`, def. 90 → con el
    techo del 90 % coincide; pon un valor menor, p. ej. 70, para cambiar antes) y
    **rotate** (cada vez que el % sube `autoSwitchDelta` puntos, def. 10, desde el
    baseline `rotateBaselinePct` capturado al activarse la cuenta; con low-water mark
    para resets de la ventana de 5h → reparte el gasto rotando). En **ambos** modos
    el salto pasa por el mismo guard de margen (`leastUsedBelow(90)`): nunca aterriza
    en una cuenta ≥90 %, así que un threshold puesto por encima de 90 queda **capado
    de hecho al 90 %**. Si el modo pide cambiar pero ninguna cuenta tiene margen, se
    queda (diagnóstico en `lastDiagInfo`/"Diagnose auto-switch").
  Destino base = `pickNextAccount()` = **cuenta menos gastada** (menor % 5h sondeado,
  saltando las de token muerto **y las bloqueadas**; fallback a round-robin por email
  si no hay datos frescos); el techo/guard del 90 % lo restringe a las que tienen hueco.
  - **Techo semanal del destino (`WEEKLY_CEILING_PCT` = 95 %)**: además del techo de
    5h, el auto-switch **nunca salta A una cuenta cuyo uso de 7d (semanal) sea ≥95 %**,
    para no aterrizar en una cuenta que está a punto de agotar su límite semanal en
    mitad de una respuesta. Es un **filtro de candidatos** (`weeklyMaxedOut(email)`:
    true solo con lectura 7d **fresca** ≥95 %; fail-open si no hay dato), aplicado en
    `pickNextAccount()` (ambas rutas: menos-gastada y round-robin) y en
    `leastUsedBelow()`. NO fuerza a la cuenta activa a moverse (no toca la decisión de
    *cuándo* saltar, solo *adónde*). Si **todos** los destinos están al ≥95 % semanal,
    `leastUsedBelow` devuelve null y, como sí hay datos frescos
    (`haveFreshUsageData`), el plugin **se queda** en la cuenta actual en vez de saltar
    a una semanalmente agotada.
  Hot-swap sin reinicio → no corta el turno (la cuenta nueva aplica a la siguiente
  petición). Cooldown de 10 s evita bucles y deja que la barra se asiente.
  - **Cuentas bloqueadas para auto-switch** (`settings.autoSwitchExcluded`, lista de
    emails en minúscula; def. `[]`): cuentas que el auto-switch **nunca** elige como
    destino —p. ej. cuentas de amigos, para no gastar sus tokens automáticamente—.
    `isAccountEligible(email)`/`toggleAccountEligible(email)` consultan/alternan la
    lista; `pickNextAccount()` las salta (en el camino "menos gastada" y en el
    round-robin). UI: el menú 👤 (`openAccountMenu(anchor)`) ya **no** es un `Menu`
    de Obsidian sino un **popup DOM propio** (clase `.cch-account-menu`,
    `position:fixed`, montado en `document.body`, **clampeado al viewport** —mide
    `getBoundingClientRect()` y corrige `left`/`top` con 8px de margen para no
    salirse de pantalla—, cerrado por click-fuera/Escape vía `closeAccountMenu()`;
    refs `accountPopup`/`accountPopupCleanup`, limpiado en `onunload`). Tiene **UNA
    sola lista** de cuentas (no dos): cada fila `.cch-acct-row` lleva a la
    **izquierda** un toggle `.cch-acct-toggle` (verde = habilitada; gris =
    deshabilitada; `onclick` → `toggleAccountEligible` + actualiza `is-on` y la clase
    `cch-acct-blocked` de la fila **sin cerrar** el popup, para conmutar varias) y,
    en medio la **etiqueta** `.cch-acct-label` (texto de `accountMenuTitle` si
    `usageProbe`, si no el email; la cuenta activa lleva `.cch-acct-current` con ✓)
    y, a la **derecha**, un botón **abrir-login** `.cch-acct-open` (icono `log-in`)
    por cuenta → `openLoginForAccount(email)`: abre `CLAUDE_LOGIN_URL`
    (`https://claude.ai/`) en el **navegador mapeado a ESA cuenta** (no la activa)
    en `settings.browserMap` —el navegador donde vive su cookie/SSO—, con fallback
    a `defaultBrowser`. Sirve para **volver a iniciar sesión** rápido en una cuenta
    caducada sin recordar qué navegador usa cada una. Usa el mismo `launchBrowser`
    que el remote-control pero con `fullscreen=false` (solo trae la ventana al
    frente, sin pulsar F11; `focusFullscreen(proc, fullscreen)` omite el SendKeys
    `{F11}` cuando es false). El `aria-label`/Notice nombran el navegador vía
    `browserLabelForAccount(email)`.
    **Deshabilitación TOTAL en este popup**: una cuenta off recibe `cch-acct-blocked`
    (sombreada + tachada) y su etiqueta es **inerte** —`switchToAccount` NO se llama
    al clicarla; muestra un `Notice` pidiendo reactivar el toggle—, así que no se
    puede ni usar manualmente desde aquí. Arriba, acciones "Save current account" y
    "Refresh usage" (filas `.cch-acct-action`, estilo `menu-item`). NOTA: el flag
    sigue siendo `autoSwitchExcluded`; fuera del popup (página de ajustes, botón
    `repeat`/`ban`) el bloqueo solo afecta al auto-switch (el cambio manual desde
    ajustes sigue funcionando). Si todas las demás cuentas están bloqueadas,
    `requestSwitch` avisa una vez ("every other account is blocked").
    **Resaltado de "destino capado" (`cch-acct-capped`)**: además del bloqueo
    manual, cada fila se pinta en **rojo** (mismo tinte/acento que `cch-acct-blocked`,
    pero la etiqueta **sigue clicable**) cuando la cuenta está **inelegible como
    DESTINO de auto-switch** por las restricciones ya codificadas —espejo de los
    guards de `pickNextAccount`/`leastUsedBelow` vía el helper `isSwitchTargetCapped`:
    token caducado (`error==="auth"`), **5h fresco ≥90 %** (`SWITCH_CEILING_PCT`) o
    **7d fresco ≥95 %** (`WEEKLY_CEILING_PCT`, vía `weeklyMaxedOut`)—. Es **solo
    aviso visual**: el cambio MANUAL sí ignora los topes (la etiqueta no se vuelve
    inerte). Fail-open con datos viejos/ausentes (sin lectura fresca → no se pinta,
    coherente con la decisión real). La cuenta **activa** se excluye (nunca es un
    destino; conserva su ✓ `cch-acct-current`). `title` de la fila explica el motivo.
  - **Bloqueo por franjas horarias** (`settings.accountSchedules`): por cuenta se
    configuran ventanas prohibidas `{start,end,days}` (`HH:MM`, 24h; `days` =
    números de día JS 0=Dom…6=Sáb; `start>end` cruza medianoche; franja sin días no
    bloquea). `isTimeBlocked(email, now?)` decide si "ahora" cae dentro (maneja
    franjas normales y nocturnas, comprobando la pertenencia de día de **ayer** para
    el tramo tras medianoche). Una cuenta en franja se **descarta como destino** de
    auto-switch (`continue` añadido en `pickNextAccount` ×2 y `leastUsedBelow`) y se
    pinta del mismo **rojo clicable** `cch-acct-capped` en el menú 👤 (el `capped`
    incluye `|| isTimeBlocked`; el cambio MANUAL sigue permitido, como pidió el
    usuario). **Enforcement** (`enforceSchedule`, intervalo de 20 s + uno a 8 s,
    corre **aunque autoSwitch esté OFF**): si la cuenta **activa** está en franja,
    salta a otra elegible (`pickNextAccount` → `triggerSwitch(next,"blocked by
    schedule")`); si **no hay destino**, **parada dura** = interrumpe (Esc vía
    `Session.interrupt`) cualquier sesión `busy` y avisa una vez
    (`notifyScheduleStop`/`scheduleStopNotified`, re-armado al salir de la franja).
    Corte **inmediato** además del tick: `markActivity` consulta
    `isScheduleHardStop()` (activa en franja + sin destino) y corta la generación en
    cuanto Claude empieza a producir, aproximando "como si se acabase el uso".
    CAVEAT (honesto): NO bloquea el teclado (puedes seguir escribiendo); corta toda
    **generación** mientras dure la franja, no deshabilita la entrada (evita dejarte
    atrapado). UI: editor por cuenta en ajustes, dentro de la tarjeta de la cuenta
    (ver "Ajustes consolidados por cuenta"): una **cabecera** `.cch-schedule-head`
    ("Forbidden time windows" + botón "Add range") y por franja una fila compacta
    `.cch-schedule-row` (`from HH:MM to HH:MM` con labels `.cch-schedule-lead`/
    `.cch-schedule-dash`, + grupo `.cch-day-group` de 7 chips de día —`<button>`
    reales con clase `.cch-day-toggle`/`.cch-day-on`, NO `addExtraButton`, para que
    sean cuadrados y no óvalos solapados— + papelera). `scheduleFor(email,create?)`
    localiza/crea la entrada y `scheduleBlockLabel(email)` da la etiqueta para
    tooltips/desc.
- **Ajustes consolidados por cuenta** (`HarnessSettingTab.display`): toda la
  configuración de una cuenta vive en **una sola tarjeta** bajo el encabezado
  "Per-account settings", no desperdigada por la página. Por cada cuenta de
  `listSavedAccounts()`: (1) fila principal (email + `usageLabel`, toggle de
  elegibilidad `repeat`/`ban`, botón **Switch**, papelera); (2) sub-fila
  **"Browser"** (`.cch-account-sub`): desplegable de navegador con opción
  "Use default" (sin entrada en `browserMap` → cae al "Default browser" global) +
  ruta `custom`, vía `browserFor(email, create?)`; (3) editor de **franjas
  prohibidas** (cabecera `.cch-schedule-head` + filas `.cch-schedule-row`). Los ajustes
  **globales** de cuentas (Save current, auto-switch on/mode/threshold, Live usage,
  probe model, usage regex, **"Default browser"**) quedan agrupados **antes** de las
  tarjetas. La antigua sección separada "Remote control — browser per account"
  desapareció: ahora solo queda un grupo **"Other browser mappings"** que aparece
  cuando hay entradas de `browserMap` cuyo email **no** es una cuenta guardada
  (poco habitual, porque las cuentas se auto-guardan al `/login`), más un botón "Add
  browser mapping (unsaved account)" para pre-mapear una cuenta aún no logueada. Las
  sub-filas se indentan con `.cch-account-sub`/`.cch-schedule-head`/`.cch-schedule-row`
  (margen + borde izquierdo) para leerse como un bloque bajo su cuenta.
  - **El watcher corre SIEMPRE** (no solo con autoSwitch), porque también: lee el
    **email de la barra** (filtrado contra `knownAccountEmails()`) para anclar el
    %↔cuenta, **etiquetar el botón 👤 en vivo** y **verificar el swap**
    (`pendingVerifyEmail`/`verifyDeadline`: "✓ Active account: X" al confirmarse;
    aviso si tras ~45 s sigue en la cuenta vieja habiendo actividad).
  - **Anclaje**: si el email de la barra ≠ `currentAccountEmail()`, no actúa (la
    barra aún no refleja el último swap) → evita cambios espurios por leer el % de
    la cuenta vieja justo tras cambiar.
  - **Disparador de respaldo** `LIMIT_STOP_RE` (mensaje de "límite alcanzado")
    aunque no haya % — la misma regex estricta del estado rojo de pestaña (la
    antigua `LIMIT_RE`, con `resets at`, casaba con la barra de estado normal y
    provocaba switches en bucle; se eliminó). Tras cada `triggerSwitch` se vacían
    los `autoSwitchBuf` de todas las sesiones para que el texto disparador no
    re-dispare otro salto en el siguiente cooldown. **Regex de uso configurable**
    (`settings.autoSwitchUsageRegex`, default `DEFAULT_USAGE_RE`, compilada con
    fallback seguro); del buffer rodante se toma **la ÚLTIMA coincidencia** (la
    primera era el % más viejo aún visible → lecturas desfasadas), igual que el
    escaneo de emails.
  - **Auto-recuperación por auth-fail** (`AUTH_FAIL_RE` dentro de `authWatchUntil`
    tras un swap): avisa y, en auto, salta a la siguiente cuenta (tope
    `recoverAttempts`). `LIMIT_STOP_RE`/`AUTH_FAIL_RE` son best-effort: el texto
    real de Claude puede cambiar, ajustar si hace falta.
  - **Caché de disco (`ACCOUNT_CACHE_MS` = 5 s)**: `currentAccountEmail()` y
    `listSavedAccounts()` cachean su lectura (el watcher corre en **cada chunk**
    del PTY y releer `~/.claude.json` —que puede ser enorme— más todos los
    snapshots decenas de veces por segundo producía jank real).
    `saveCurrentAccount`/`switchToAccount`/`deleteSavedAccount` invalidan la caché
    (`invalidateAccountCaches`); un `/login` externo se detecta dentro del TTL.
  - **Aviso si <2 cuentas** al activar auto-switch o al intentar rotar
    (`warnedNoAccounts`, one-shot).
- **Live usage (sondeo por API)** (`settings.usageProbe`, on por defecto): lee el
  % **autoritativo** de uso de 5h/7d desde las **cabeceras de rate-limit** de la
  API de Anthropic, en vez de depender del scraping. `probeUsage(token)` hace una
  llamada mínima a `POST /v1/messages` (`max_tokens:1`, modelo `USAGE_PROBE_MODEL`
  = `claude-haiku-4-5-20251001`, ajustable con `settings.usageProbeModel`) con
  `authorization: Bearer <accessToken>` + `anthropic-version: 2023-06-01` +
  `anthropic-beta: oauth-2025-04-20`, y parsea
  `anthropic-ratelimit-unified-5h-utilization` (fracción 0–1 → ×100),
  `…-5h-reset` (epoch), `…-7d-utilization`, `…-7d-reset` (epoch; nombre por
  simetría con el de 5h, NO verificado en vivo, con respaldo que escanea cualquier
  header con "7d"+"reset"). Usa `https` de Node (no `requestUrl`)
  para exponer todos los headers. **Verificado en vivo** que el OAuth token de
  Claude Code autentica esa llamada. `accessTokenFor(email)` saca el token de
  `.credentials.json` (cuenta activa, `claudeAiOauth` en raíz) o del snapshot
  `cch-accounts/<email>.json` (`credentials.claudeAiOauth`), así que **se sondea
  cada cuenta sin cambiarse a ella**. `refreshUsage({activeOnly?})` recorre las
  cuentas secuencialmente (~300 ms de desfase, guard `usageProbing`) y cachea en
  `accountUsage: Map<email, AccountUsage>`. Programación: todas al arrancar (~5 s)
  y al abrir el menú 👤 (en background; el menú es síncrono, muestra lo cacheado y
  el siguiente abrir sale fresco; hay ítem "Refresh usage"); **cada 3 min**
  (`registerInterval`) se hace `refreshUsage({refreshTokens:true})` sobre **todas**
  las cuentas (keep-alive + sondeo, ver abajo) —3 min < 6 min = `USAGE_FRESH_MS`,
  así `pickNextAccount` siempre tiene datos frescos—; y tras actividad solo la
  activa (`maybeProbeOnActivity`, debounce 60 s). Al **activar** el auto-switch
  (toggle de cabecera o ajustes) se dispara un `refreshUsage({refreshTokens:true})`
  inmediato para revivir y calentar todas las cuentas sin esperar al siguiente tick. El menú 👤 renderiza con `accountMenuTitle()` un
  `DocumentFragment` **monospace + `white-space:pre`** que alinea en columnas
  (email padded → `5h` num→ countdown 5h padded → `7d` num → countdown 7d) y
  **colorea** los % por nivel (`usageColor`: <50 verde, 50-74 amarillo, 75-89
  naranja, ≥90 rojo). Ambas cuentas atrás (hasta el reseteo de cada ventana) se
  formatean con `resetCountdown(epoch)` (días+horas para 7d, horas+minutos para
  5h; "" si falta/pasó). La lista de ajustes usa el texto plano `usageLabel(email)`
  (`5h NN% (Hh Mm) · 7d NN% (Dd Hh)`, o `expired` si 401, `rate-limited` si 429). 401 → `error:"auth"`: `pickNextAccount`
  la salta. OJO: 401 en la **cuenta activa** suele ser falso (su access token
  caducó pero `claude` lo refresca en la siguiente petición); por eso la etiqueta
  es `expired`, no "necesita login".
  CAVEATS (best-effort): nombres de header / valor `oauth-2025-04-20` / id de
  modelo pueden cambiar; el factor fracción→% (×100) se infiere de
  `…-fallback-percentage: 0.5` (contrastar una vez con la barra); el probe consume
  un pelín y cuenta mínimamente (por eso Haiku, secuencial, no en ráfaga).
- **Keep-alive de tokens** (`refreshAccount` + `oauthRefresh`, opción
  `refreshUsage({refreshTokens:true})`): para que las cuentas **inactivas** no
  deriven a `expired` (su access token caduca en horas y nada las refresca si no
  las usas → se excluían como destino del auto-switch), el plugin **refresca el
  token OAuth** igual que hace `claude` por dentro: `POST OAUTH_TOKEN_URL`
  (`https://platform.claude.com/v1/oauth/token`) con `{grant_type:"refresh_token",
  refresh_token, client_id: OAUTH_CLIENT_ID}` (endpoint y client_id verificados
  extrayéndolos del binario `claude.exe`; pueden cambiar con futuras versiones del
  CLI). En cada tick de 3 min se **revisa** cada cuenta **inactiva** pero solo
  se refresca de verdad si está caducada o le quedan <`REFRESH_SKEW_MS` (30 min);
  ese throttle mantiene el ritmo de refresco cercano al de `claude` (~1 por vida de
  token) y evita machacar el endpoint de tokens, que **limita por tasa con dureza
  (429 confirmado en vivo)**. SEGURIDAD: el refresh token **rota** en cada
  refresco (la respuesta trae uno nuevo e invalida el viejo); por eso `refreshAccount`
  solo toca el fichero en **HTTP 200** (cualquier error → credenciales intactas, el
  refresh token viejo sigue válido) y escribe **atómico** (`writeJsonAtomic`),
  fusionando los tokens nuevos sin perder los demás campos (`scopes`,
  `subscriptionType`…) y conservando la unidad de `expiresAt` (ms aquí).
  **La cuenta ACTIVA NO se refresca desde el plugin**: `refreshAccount` la salta
  (`if (isActive) return true`) y deja que de ella se ocupe el propio `claude`,
  que re-lee `.credentials.json` y rota su refresh token de forma perezosa en cada
  petición. Antes el plugin también la refrescaba, lo que **competía** por el mismo
  refresh token (si el plugin rotaba RT1→RT2 mientras `claude` aún tenía RT1, el
  siguiente refresco de `claude` usaba un token muerto → 401 → `/login`); ese era
  el "riesgo residual" que provocaba caducidades aleatorias, ahora eliminado. Coste
  asumido: la barra de uso de la cuenta activa puede mostrar `expired` un instante
  tras caducar su access token, hasta el siguiente mensaje (falso positivo benigno).
  **Diagnóstico**: todos los refrescos emiten logs `[cch keepalive] …` en la
  consola de DevTools (`skip active`, `refreshing`, `refreshed … ok`,
  `refresh FAILED`, y la causa HTTP/red: `token endpoint HTTP <status>` —401 token
  muerto, 429 rate-limit—, `network error`, `timeout`), para saber con certeza por
  qué cae una cuenta sin tener que adivinar.
- **Escrituras atómicas** (`writeJsonAtomic`): `switchToAccount`/`saveCurrentAccount`
  escriben a temp + `rename` para que la `claude` viva nunca lea un
  `.credentials.json`/`.claude.json` a medio escribir. `switchToAccount` valida que
  el snapshot tenga `claudeAiOauth.accessToken` antes de escribir.
- **Manual exhaustivo**: ver `README_TECNICO.md` para el pipeline completo del
  cambio de cuenta (pensado para replicarlo en otros harness).
- **Enviar notas a Claude** (`sendPathsToClaude`): @-menciona una o varias rutas
  del vault (abre el panel y arranca la sesión si hace falta). Lo usan el botón @
  (`sendActiveNote`), el menú contextual del explorador (eventos `file-menu` /
  `files-menu` → "Send to Claude") y el **drag-and-drop** sobre el terminal
  (`handleDrop`: lee `app.dragManager.draggable` para arrastres internos,
  `dataTransfer.files` para archivos del SO —vía `electron.webUtils.getPathForFile`,
  con fallback a `File.path` en Electron <32, que fue donde se eliminó esa API—,
  y un fallback de `text/plain` que resuelve `[[wikilinks]]` vía
  `metadataCache.getFirstLinkpathDest`).
- **Autocompletado `[[` → referencia `@`** (suggester estilo Obsidian dentro del
  terminal; ajuste `wikilinkPicker`, on por defecto): al escribir **`[[`** en el
  input se abre un **desplegable flotante** (`.cch-wikilink-menu`, mismo patrón DOM
  que `openAccountMenu`: `div` en `document.body`, `position:fixed`, anclado al
  **cursor del terminal** y clampeado al viewport, cierre por click-fuera) con las
  notas más parecidas a lo que vas escribiendo. Flechas mueven la selección,
  Enter/Tab/click eligen, Escape cancela. Al elegir, lo tecleado (`[[consulta`) se
  **sustituye por `@<ruta> `** (formato de `mention()`), NO por un `[[wikilink]]`.
  - Estado y métodos viven en `Session` (`wlActive`/`wlQuery`/`wlBracketRun`/
    `wlPopup`/`wlItems`/`wlSel`): `feedWikilink` (máquina de estados del trigger),
    `openWikilinkPicker`/`closeWikilinkPicker`, `searchWikilink`, `queryNotes`,
    `renderWikilinkResults`/`highlightWikilink`/`moveWikilinkSel`, `acceptWikilink`,
    `positionWikilinkPopup`. `searchWikilink` es **async** (la firma se mantiene por
    compatibilidad) con `wlSearchSeq` para descartar respuestas obsoletas / picker ya
    cerrado.
  - **Fuente de sugerencias = suggester NATIVO de Obsidian** (`nativeNotes`):
    `metadataCache.getLinkSuggestions()` (cada fichero linkable + sus alias) matcheado
    sobre el **nombre/alias** con el mismo fuzzy matcher (`prepareFuzzySearch`) +
    `sortSearchResults`, de modo que el orden coincide con el popup `[[` del editor.
    `queryNotes` solo delega en `nativeNotes` (la indirección se conserva por si en el
    futuro se quiere otra fuente); mapea a `{path, basename}` (path = ruta de vault para
    el `@`-ref). Para la **consulta vacía** muestra la lista nativa tal cual (reciente/
    ordenada). HISTORIA: primero fue OmniSearch, luego nativo para "igualar el `[[` de
    una nota", luego OmniSearch (full-text) a petición del usuario, y finalmente
    **de vuelta al nativo** porque el usuario lo prefiere (funciona mejor para él).
  - **Insensible a acentos**: `nativeNotes` usa `stripDiacritics` (helper a nivel de
    módulo: NFD → quita `\p{Diacritic}` → NFC, sobre consulta y candidato) porque el
    `prepareFuzzySearch` nativo es **sensible a diacríticos**. OJO: esto solo afecta a
    ESTE picker del terminal; el `[[` nativo del editor y el Quick Switcher (Ctrl+O)
    de Obsidian siguen siendo sensibles a acentos (limitación del núcleo, sin ajuste).
  - **Inline como Obsidian**: el `[[` y la consulta SÍ se reenvían a Claude (eco
    inline). Al aceptar, `acceptWikilink` **borra con `\x7f` × (2 + wlQuery.length)**
    y manda `@<ruta> `. El contador es exacto porque cada char tecleado pasa por
    `feedWikilink` (que controla el reenvío y el `wlQuery`). LIMITACIÓN: emojis /
    grafemas multi-celda en la consulta podrían desincronizar el conteo de
    backspaces; las notas rara vez los llevan.
  - **GOTCHA teclado internacional (CLAVE):** en el teclado español `[` llega por
    la **rama AltGr** de `attachCustomKeyEventHandler` (`Ctrl+Alt`), que envía el
    char y `return false` → **nunca pasa por `onData`**. Por eso `feedWikilink` se
    llama desde **ambas** rutas: `onData` (`alreadySent=false`) y la rama AltGr
    (`alreadySent=true`, no reenvía, solo actualiza estado). Las teclas de
    navegación/aceptar/cancelar se capturan al principio del key handler (con
    `wlActive`), las de texto caen a `onData`/`feedWikilink`.
  - El popup es **puramente visual** (no roba foco; xterm mantiene el foco). Se
    cierra en `detachHost`/`dispose`/`case "exit"` para no quedar huérfano.
- **Referencias a notas clicables** (`computeNoteLinks` + `term.registerLinkProvider`):
  cada `Session` registra un link provider de xterm; en hover, `computeNoteLinks`
  (en el plugin) crea `ILink`s para: (1) `[[wikilinks]]` (independiente del color) y
  (2) **runs de celdas coloreadas** (fg no-default, `cell.isFgDefault()`) cuyo texto
  resuelva a una nota `.md` existente (`resolveNote` →
  `metadataCache.getFirstLinkpathDest`, filtra `extension==="md"`, quita
  `[[ ]]`/`|alias`/`#heading`). Un run se prueba entero y partido por `,;|·•`,
  recortando puntuación alrededor (`. , : ; ! ¿ ? ( ) [ ] { } " ' « » \` * < > →`;
  NO `-` ni `_`).
  **Nombres partidos por salto de línea (CLAVE):** la TUI de Claude envuelve el
  texto **ella misma** con saltos reales + **sangría de 2 espacios** en la
  continuación (la fila siguiente NO es `isWrapped`), partiendo un `[[wikilink]]`
  largo en un límite de palabra. Por eso `computeNoteLinks` **reconstruye el bloque
  contiguo de filas no vacías** alrededor de `y` (expande arriba/abajo hasta una
  línea en blanco, tope ±6) **uniéndolas con un solo espacio** (recortando la
  sangría y los espacios finales de cada fila), y guarda `cx`/`cy`/`colored` por
  carácter. El espacio de unión hereda la columna/fila de la fila anterior (se funde
  en su segmento) y es "coloreado" solo si ambos lados lo son (así un nombre
  coloreado partido se reúne en un run). Se casa `[[...]]` + runs sobre el texto
  unido, y `add(s,e)` **parte la coincidencia por fila** emitiendo un `ILink` de
  **una sola fila** por cada fila que toca, devolviendo **solo el segmento de la
  fila consultada `y`** (rangos multi-fila / fuera de `y` rompen el matching de
  xterm). Así cada mitad de un nombre partido se resalta desde su propia consulta y
  el clic en cualquiera abre la nota. **Corte a mitad de palabra:** Claude corta a
  ancho fijo, a veces dentro de una palabra ("inves|tigación") y a veces en un
  espacio ("se|supone"), así que el espacio de unión sintético puede sobrar o hacer
  falta. `resolveSpan(s,e,raw)` prueba el candidato tal cual y, si no resuelve, con
  cada subconjunto de sus **espacios de unión** (marcados en `isJoin[]`) eliminados,
  devolviendo la variante que resuelve (tope 4 cortes). Al activar, `openNoteLink` abre con
  `workspace.openLinkText(path)` (Ctrl/Cmd+clic = pestaña nueva). Ajuste
  `settings.linkifyNotes` (por defecto on). Si el subrayado/clic sale desalineado,
  revisar el off-by-one de `range` (1-based, `y` = índice de fila del buffer).
- **Ctrl+R**: toggle del remote control. Hay un comando "Toggle remote control"
  con hotkey `Mod+R`; además el handler de teclas del terminal intercepta Ctrl+R
  (preventDefault + stopPropagation, para que no llegue al pty ni recargue la
  página de Electron) y llama `toggleRemoteControl()`.
- **Aviso por bell** (`term.onBell`): si `settings.notifyOnBell` (por defecto
  true), muestra un `Notice` cuando el terminal suena la campana (`\x07`), que
  Claude tiende a sonar al terminar una tarea larga.
- **Remote control (toggle de dos estados)** (`toggleRemoteControl`): clave del
  comportamiento de `/remote-control`: la **primera** ejecución solo **conecta**
  (muestra `/rc connecting…` → `/rc active` en la barra de estado) y NO imprime la
  URL; ejecutarlo **estando ya conectado** abre un menú (Disconnect · Show QR code
  · Continue) que sí imprime la URL `https://claude.ai/code/session_…`.
  - **OFF→ON**: envía el comando (conecta) y, para reabrir el menú y sacar la URL,
    usa `fireRemoteMenu()` (one-shot, guardado por `remoteMenuFired`): vía rápida =
    `maybeAfterRemoteActive` lo dispara al ver `/rc active`; respaldo = un timer a
    ~3,5 s (el menú aparece aunque siga en "connecting…", así que no se depende de
    parsear la barra de estado). `fireRemoteMenu` reenvía `/remote-control`, arma
    `awaitRemoteUrl` y, tras ~1,5 s, manda Esc para seguir conectado.
    `maybeCaptureRemoteUrl` saca la URL de la salida del PTY (regex), la copia al
    portapapeles y la abre en el navegador (`openInBrowser`). Abrir el navegador
    con la URL reutiliza la ventana existente -> pestaña nueva -> entra directo a
    la sesión. El botón se pone verde (clase CSS `cch-active`).
  - **Navegador por cuenta**: la URL solo funciona en el navegador donde está
    logueada la misma cuenta de Claude que la sesión. `currentAccountEmail()` lee
    `~/.claude.json` -> `oauthAccount.emailAddress` (la cuenta activa, se actualiza
    al hacer `/login`). `openInBrowser` busca ese email en `settings.browserMap`
    (`{email, browser, path}[]`); si no hay match usa `settings.defaultBrowser`
    (por defecto `chrome`). `launchBrowser(browser, customPath, url)` lanza Chrome/
    Firefox/Edge/Brave/Opera/Opera GX/Zen/Helium/Vivaldi/Waterfox/Floorp/Mullvad
    (rutas conocidas por `BROWSERS`,
    con `%VARS%` expandidas; OJO: Helium es Chromium y su exe se llama `chrome.exe`,
    en `…\imput\Helium\Application\`, así que su `proc` colisiona con el de Chrome
    en `focusFullscreen`; si no
    existe el `.exe`, `cmd /c start <alias>`), una ruta `custom`, o `default`
    (`shell.openExternal`); cualquier fallo cae a `shell.openExternal`. Devuelve un
    label para el `Notice`. La correlación email→navegador se edita en ajustes
    **dentro de la tarjeta de cada cuenta** (ver "Ajustes consolidados por cuenta"
    abajo) + un "Default browser" global; el helper `browserFor(email, create?)`
    localiza/crea la entrada en `settings.browserMap`. Tras lanzar, `focusFullscreen(proc)` pone
    la ventana del navegador en primer plano y la pasa a pantalla completa: como
    los flags `--start-fullscreen` se ignoran si el navegador ya está abierto,
    dispara un PowerShell breve (fire-and-forget) que espera ~1,8 s, hace
    `WScript.Shell.AppActivate($p.Id)` sobre el proceso (`proc` de `BROWSERS`,
    p. ej. `chrome`/`msedge`/`opera`) y envía `{F11}`. Best-effort: F11 es un
    toggle, así que si la ventana ya estaba en fullscreen lo desactivaría.
  - **ON→OFF**: reenvía el comando y, tras ~0,7 s, manda flecha arriba ×2
    (Continue→QR→Disconnect) + Enter para desconectar. OJO: las flechas se inyectan
    en crudo (sin pasar por el manejo de teclas de xterm), así que hay que usar la
    secuencia que corresponde al **DECCKM** real (`term.modes.applicationCursorKeysMode`):
    application cursor keys -> Up = `\x1bOA`, no `\x1b[A`. La TUI de Claude activa
    ese modo, y mandar `\x1b[A` no movía el cursor (el Enter caía en "Continue" y no
    desconectaba). Cada pulsación se envía con un pequeño desfase para que el TUI
    las registre.
  Los tres watchers (`maybeAfterRemoteActive`, `maybeCaptureRemoteUrl`,
  `maybeConfirmModel`) cuelgan del handler `data` de **cada `Session`**. `remoteOn`
  vive en la `Session` y se resetea en `restart()` y cuando claude sale;
  `plugin.updateRemoteBtn()` refleja el estado de la **sesión activa** en el botón
  (se reconstruye con la cabecera). La regex de captura es
  `https://claude\.ai/code/[\w-]+` (acepta cualquier id tras `/code/`, no solo
  `session_…`, pero **sin `.` ni `/`**: el menú imprime las etiquetas de sus
  opciones —"Disconnect this session", "Show QR code"— pegadas tras la URL al
  quitar los ANSI, así que incluir `.` colaba `.Disconnectthissession…` en la URL
  y la rompía; parar en `.` da la URL limpia). **Captura con reintentos** (`runRemoteMenuAttempt`,
  bucle guardado por `remoteMenuLoopActive`/`remoteUrlCaptured`, hasta 6 intentos
  cada ~3,5 s): el menú solo imprime la URL cuando la sesión ya está **conectada**,
  cosa que puede tardar más que un único intento temprano —por eso antes hacía
  falta pulsar Ctrl+R dos veces—; el bucle reabre el menú hasta que la URL aparece,
  la captura, abre el navegador y cierra el menú con Esc para seguir conectado. Si
  agota los intentos, avisa al usuario en vez de fallar en silencio. Hay logs
  `[cch remote] …` (console) para diagnosticar el flujo toggle→menú→captura→abrir.
  La URL capturada se abre **siempre en un navegador externo** (`openInBrowser` →
  `launchBrowser`), elegido por cuenta/por defecto en ajustes.
- **Selector de modelo** (`selectModel`): envía `\x15/model <id>\r` (el Ctrl+U
  inicial limpia cualquier borrador para que el comando vaya en su propia línea;
  restaurable con Ctrl+Y). Argumentos válidos comprobados: `haiku`, `sonnet`,
  `opus`.
- **Comandos**: "Open Claude Code panel", **"New Claude Code session"** (abre el
  panel y crea otra instancia con `newSession()`), "Restart Claude Code session"
  (sobre la activa), **"Reopen closed Claude session"** (hotkey `Mod+Shift+Y`;
  `reopenClosedSession()` reabre la última pestaña cerrada con `--resume`),
  **"Pin/unpin current Claude tab"** (`setPinned()` sobre la activa),
  **"Open Claude session history"** (`openHistoryMenu()` abre la lista de
  conversaciones cerradas para reabrir cualquiera en pestaña nueva),
  "Send active note to Claude" (inserta `@<ruta>` de la nota
  activa en la activa), "Toggle remote control" (hotkey `Mod+R`; sobre la activa),
  "Save current Claude account", "Diagnose
  auto-switch (why no account change)" (`diagnoseAutoSwitch()`: muestra en un
  `Notice` el último resultado de la evaluación del auto-switch —motivo en
  lenguaje claro, `%`/fuente, baseline o threshold, cuenta activa vs. barra,
  nº de cuentas— a partir de `lastDiagInfo`, que `maybeAutoSwitch` rellena en
  cada chunk; útil para saber por qué no cambia).
- **Instrucciones predefinidas**: ajuste "Extra arguments" (se anexa al comando,
  p. ej. `--append-system-prompt "..."`) y "Skill". `maybeSendInitial` envía
  primero `/model <id>` (para que el modelo de la pestaña sea REAL: antes la
  cabecera mostraba `session.model` pero claude arrancaba con su propio default),
  luego corre los `startupCommands` (p. ej. `/remote-control`) y por último invoca
  la skill activa (`/<skill>`) cuando llega la primera salida de claude, **se abra
  o no el panel**. En tabs con `resume:true` no se envía nada (la conversación ya
  trae su modelo/skill). Cada paso se manda al pty con `pasteToPty()` (entrada IPC directa, con
  marcadores de bracketed-paste si el modo está activo) en vez de `term.paste()`,
  que requería la vista montada — por eso antes fallaba si nunca se abría la
  ventana.
- **Skills de Claude Code** (carpeta `~/.claude/skills`, propiedad de Claude, NO
  versionada con el plugin): cada subcarpeta con un `SKILL.md` es una skill
  seleccionable, invocable como `/<nombre-de-carpeta>`. El ajuste `skill` guarda
  el nombre de la skill activa (por defecto `second-brain-assistant`). La cabecera
  tiene un botón (icono `sparkles`) que abre un menú con las skills disponibles
  (`listSkills()`, lee `~/.claude/skills` y filtra subcarpetas con `SKILL.md`) más
  una opción "(none)"; al elegir una, `selectSkill()` persiste la elección y, si
  hay sesión viva, envía `\x15/<nombre>\r` al instante (mismo patrón que el
  selector de modelo). El ajuste "Skill" es un desplegable con esas skills. El
  menú de skills incluye al final un ítem **"Open skills folder"**
  (`openSkillsFolder()`) que abre `~/.claude/skills` y, vía `focusFolderWindow()`,
  pone esa ventana del Explorador en primer plano y la **maximiza** (Win11 no tiene
  F11 real para el Explorador; se maximiza la ventana exacta localizada por su ruta
  con `Shell.Application` + `ShowWindowAsync`/`SetForegroundWindow`). (No hay
  migración del antiguo sistema de "Initial Prompts": el campo viejo se ignora.)
- **Token Dashboard** (botón `bar-chart-3` en la cabecera, a la derecha del de
  auto-switch; toggle `btnTokenDashboard`; comando "Open Token Dashboard"):
  sustituye al `.bat` "Lanzar Token Dashboard". `launchTokenDashboard()` hace
  `spawn(python, ["-u","cli.py","dashboard","--no-open"], {cwd:<pluginDir>/token-dashboard,
  detached, windowsHide})`, espera la línea `listening on` por stdout (o sondea
  `http://127.0.0.1:8080/` hasta 90 s como respaldo) y abre la URL en el navegador
  **por defecto** (`shell.openExternal`). Si ya hay server vivo
  (`tokenDashboardChild.exitCode === null`) solo abre otra pestaña. `resolvePythonPath()`
  (espejo de `resolveNodePath`): ajuste `pythonPath` → `%LOCALAPPDATA%\Programs\Python\*`
  / `C:\Program Files\Python\*` → `where python`/`where py` → `python`. El proceso se
  mata en `onunload`. El programa Python (stdlib, sin deps) vive en `token-dashboard/`
  y escanea `~/.claude/projects` a una SQLite `~/.claude/token-dashboard.db`.
  - **Carga sin parpadeo (gráficas vacías hasta listo)**: el **escaneo inicial**
    (~1 min) ya **no bloquea** `cmd_dashboard`; el servidor arranca al instante (la
    línea `listening on` sale enseguida → el navegador abre de inmediato) y el primer
    escaneo corre en el hilo de fondo `_scan_loop`. `server.py` mantiene una bandera
    `READY` (`threading.Event`), expone `GET /api/status` (`{ready}`) y, al terminar
    ese primer escaneo, emite **un** evento SSE `{"type":"ready"}` (si falla, marca
    `ready` igual para no clavar la UI). El frontend (`web/app.js`) guarda
    `state.ready` (consultado al arrancar, fail-open) y solo **rellena las gráficas
    al llegar `ready`**, ignorando los eventos `scan` mientras tanto;
    `web/routes/overview.js` dibuja el layout con **KPIs en 0 + gráficas vacías** y
    el aviso `.analyzing` ("Analyzing your usage…") hasta entonces. Así, durante el
    procesado se ven las gráficas vacías y se rellenan **una sola vez** al acabar.
    `run(..., initial_scan=not no_scan)` (la flag `--no-scan` salta el escaneo de
    arranque y marca `ready` al instante).
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
main.ts              todo el plugin: Session (instancia) + Plugin (gestor) +
                     ClaudeCodeView + SettingTab
main.js              artefacto compilado (cargado por Obsidian)
pty-host.js          proceso ayudante: corre node-pty fuera del renderer (NO se
                     empaqueta; se forkea con ELECTRON_RUN_AS_NODE)
styles.css           xterm.css + layout del panel
token-dashboard/     programa Python (stdlib) del Token Dashboard, copiado de
                     ~/.token-dashboard (cli.py + token_dashboard/ + web/ +
                     pricing.json). Lo lanza el botón de la cabecera.
node_modules/        incluye node-pty con su prebuild win32-x64
```
