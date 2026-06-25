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
- `onload()` -> `ensureAtLeastOneSession()`: crea **una** `Session` (arranca aunque
  no se abra el panel). Hay un único `css-change` registrado que re-tematiza todas
  las sesiones (`s.applyTheme()`).
- La `View` (`ClaudeCodeView`, un único `VIEW_TYPE`/leaf) solo presenta: `onOpen()`
  -> `plugin.attachView(contentEl)` (construye cabecera+pestañas y monta el host de
  la activa), `onClose()` -> `plugin.detachView()` (desmonta **sin matar**).
- **Cierre de pestaña (×)** -> `closeSession()` mata esa instancia; si no queda
  ninguna, crea una nueva (el panel nunca queda muerto). **Cerrar el panel** no
  mata nada. `onunload()` mata **todas** las sesiones.
- Comando "Restart Claude Code session" -> `activeSession().restart()`. Comando
  **"New Claude Code session"** y el botón **+** de la barra -> `newSession({skill})`.

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
     - **Heartbeat por pestaña** (`.cch-tab-dot`, estados `is-busy`/`is-idle`/
       `is-exited`): un punto sólido (sin animación) que indica si Claude está
       **trabajando** (amarillo) o **ha terminado/inactivo** (verde); gris si la
       sesión salió. Se infiere de la **actividad del PTY**:
       `markActivity()` (en `case "data"`) marca `busy=true` y rearma un timer de
       hueco silencioso (1200 ms) que lo devuelve a idle —Claude emite tokens /
       anima su spinner de forma continua mientras piensa o responde, y enmudece al
       devolver el control—. Para no pulsar mientras **tú** escribes, ignora la
       salida que llega <600 ms tras una pulsación (eco de teclado; `lastKeyAt` se
       fija en `term.onData`). `setBusy()` refresca vía `refreshTabStatus()` (actualiza
       solo los `.cch-tab-dot` in situ). El `case "exit"` y `dispose()` apagan el
       timer; salir asienta el punto.
  2. **Toolbar** (`.cch-toolbar`): botón @ (enviar nota activa, a la activa), selector
     de modelo (Haiku/Sonnet/Opus → `activeSession().selectModel`), selector de
     cuenta (icono `user-round`; **global**), selector de skill (icono `sparkles`;
     skills de `~/.claude/skills` **+ "Open skills folder"** → `activeSession().selectSkill`),
     **toggle remote control** (icono `smartphone`; `activeSession().toggleRemoteControl()`),
     **toggle auto-switch** (icono `repeat`; **global**; `openAutoSwitchMenu()` con
     modo Threshold/Rotate y presets —threshold 70/80/85/90/95; rotate +5/10/15/20/25—;
     estado por `updateAutoSwitchBtn()`), zoom (**global**, aplica a todas), ajustes
     (`openSettings()`), reiniciar (`activeSession().restart()`).
  Los botones modelo/skill/remote reflejan la **sesión activa**
  (`updateModelBtn`/`updateSkillBtn`/`updateRemoteBtn` leen `activeSession()`); cuenta
  y auto-switch son globales. Cada botón (salvo ajustes/reiniciar) se oculta desde
  ajustes (`btnSendNote/btnAccount/btnModel/btnSkill/btnRemote/btnAutoSwitch/btnZoom`).
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
  conversación. Antes de escribir, re-snapshotea la cuenta saliente (conserva su
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
  el cambio de cuenta siga funcionando aunque algún día se oculte la barra. Dos
  modos (`settings.autoSwitchMode`):
  **threshold** (cambia al cruzar `autoSwitchThreshold`, def. 90) y **rotate**
  (cambia cada vez que el % sube `autoSwitchDelta` puntos, def. 10, desde el
  baseline `rotateBaselinePct` capturado al activarse la cuenta; con low-water mark
  para resets de la ventana de 5h → reparte el gasto rotando). Elige destino con
  `pickNextAccount()` = **cuenta menos gastada** (menor % 5h sondeado, saltando las
  de token muerto **y las bloqueadas**; fallback a round-robin por email si no hay
  datos frescos).
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
    a la derecha, la **etiqueta** `.cch-acct-label` (texto de `accountMenuTitle` si
    `usageProbe`, si no el email; la cuenta activa lleva `.cch-acct-current` con ✓).
    **Deshabilitación TOTAL en este popup**: una cuenta off recibe `cch-acct-blocked`
    (sombreada + tachada) y su etiqueta es **inerte** —`switchToAccount` NO se llama
    al clicarla; muestra un `Notice` pidiendo reactivar el toggle—, así que no se
    puede ni usar manualmente desde aquí. Arriba, acciones "Save current account" y
    "Refresh usage" (filas `.cch-acct-action`, estilo `menu-item`). NOTA: el flag
    sigue siendo `autoSwitchExcluded`; fuera del popup (página de ajustes, botón
    `repeat`/`ban`) el bloqueo solo afecta al auto-switch (el cambio manual desde
    ajustes sigue funcionando). Si todas las demás cuentas están bloqueadas,
    `requestSwitch` avisa una vez ("every other account is blocked").
  - **El watcher corre SIEMPRE** (no solo con autoSwitch), porque también: lee el
    **email de la barra** (filtrado contra `knownAccountEmails()`) para anclar el
    %↔cuenta, **etiquetar el botón 👤 en vivo** y **verificar el swap**
    (`pendingVerifyEmail`/`verifyDeadline`: "✓ Active account: X" al confirmarse;
    aviso si tras ~45 s sigue en la cuenta vieja habiendo actividad).
  - **Anclaje**: si el email de la barra ≠ `currentAccountEmail()`, no actúa (la
    barra aún no refleja el último swap) → evita cambios espurios por leer el % de
    la cuenta vieja justo tras cambiar.
  - **Disparador de respaldo** `LIMIT_RE` (mensaje de "límite alcanzado") aunque no
    haya %. **Regex de uso configurable** (`settings.autoSwitchUsageRegex`, default
    `DEFAULT_USAGE_RE`, compilada con fallback seguro).
  - **Auto-recuperación por auth-fail** (`AUTH_FAIL_RE` dentro de `authWatchUntil`
    tras un swap): avisa y, en auto, salta a la siguiente cuenta (tope
    `recoverAttempts`). `LIMIT_RE`/`AUTH_FAIL_RE` son best-effort: el texto real de
    Claude puede cambiar, ajustar si hace falta.
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
  `…-5h-reset` (epoch), `…-7d-utilization`. Usa `https` de Node (no `requestUrl`)
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
  (email padded → `5h` num→ countdown padded → `7d`) y **colorea** los % por nivel
  (`usageColor`: <50 verde, 50-74 amarillo, 75-89 naranja, ≥90 rojo). La lista de
  ajustes usa el texto plano `usageLabel(email)` (`5h NN% (Hh Mm) · 7d NN%`, o
  `expired` si 401, `rate-limited` si 429). 401 → `error:"auth"`: `pickNextAccount`
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
  `dataTransfer.files` para archivos del SO, y un fallback de `text/plain` que
  resuelve `[[wikilinks]]` vía `metadataCache.getFirstLinkpathDest`).
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
    (lista dinámica + "Default browser"). Tras lanzar, `focusFullscreen(proc)` pone
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
  (sobre la activa), "Send active note to Claude" (inserta `@<ruta>` de la nota
  activa en la activa), "Toggle remote control" (hotkey `Mod+R`; sobre la activa),
  "Save current Claude account", "Diagnose
  auto-switch (why no account change)" (`diagnoseAutoSwitch()`: muestra en un
  `Notice` el último resultado de la evaluación del auto-switch —motivo en
  lenguaje claro, `%`/fuente, baseline o threshold, cuenta activa vs. barra,
  nº de cuentas— a partir de `lastDiagInfo`, que `maybeAutoSwitch` rellena en
  cada chunk; útil para saber por qué no cambia).
- **Instrucciones predefinidas**: ajuste "Extra arguments" (se anexa al comando,
  p. ej. `--append-system-prompt "..."`) y "Skill". `maybeSendInitial` corre los
  `startupCommands` (p. ej. `/remote-control`) y luego invoca la skill activa
  (`/<skill>`) cuando llega la primera salida de claude, **se abra o no el
  panel**. Cada paso se manda al pty con `pasteToPty()` (entrada IPC directa, con
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
