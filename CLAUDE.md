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
  cabecera (persistido en `settings.fontSize`). `setFontSize()` solo cambia `fontSize` y hace
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
- **Cabecera** (`buildHeader`): botón @ en la esquina izquierda (enviar nota
  activa), luego a la derecha: selector de modelo (menú Haiku 4.5 / Sonnet 4.6 /
  Opus 4.8 -> envía `/model <id>`), selector de cuenta (icono `user-round`; guardar
  cuenta actual / cambiar a una guardada), selector de skill (icono `sparkles`; menú con
  las skills de `~/.claude/skills` **+ ítem "Open skills folder"** al final →
  `openSkillsFolder()`; ya no hay botón de carpeta suelto), botón **toggle de
  remote control** (icono `smartphone`;
  `toggleRemoteControl()`), botón **toggle de auto-switch** (icono `repeat`;
  verde si está activo; `openAutoSwitchMenu()` abre un menú para activar/desactivar
  el auto-switch y elegir **modo** (Threshold / Rotate) y **porcentaje** con presets
  —threshold: 70/80/85/90/95; rotate: +5/10/15/20/25— sin abrir ajustes; estado
  reflejado por `updateAutoSwitchBtn()`, que también se llama desde los handlers de
  la página de ajustes para mantenerlo en sync), zoom, ajustes del plugin (icono
  `settings`; `openSettings()` → `app.setting.openTabById(manifest.id)`), reiniciar
  (`restart()`). Cada botón (salvo ajustes y reiniciar) se puede **ocultar** desde
  ajustes (`btnSendNote/btnAccount/btnModel/btnSkill/
  btnRemote/btnAutoSwitch/btnZoom`); al cambiarlos, `refreshHeader()` reconstruye
  la cabecera de los paneles abiertos sin reabrir. `buildHeader` resetea las refs a
  null al empezar y hace `container.prepend(header)` para que la cabecera quede
  como primer hijo tras un rebuild. No hay indicador de estado.
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
  de token muerto; fallback a round-robin por email si no hay datos frescos).
  Hot-swap sin reinicio → no corta el turno (la cuenta nueva aplica a la siguiente
  petición). Cooldown de 10 s evita bucles y deja que la barra se asiente.
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
  CLI). En cada tick de 3 min se **revisa** cada cuenta (incl. la activa) pero solo
  se refresca de verdad si está caducada o le quedan <`REFRESH_SKEW_MS` (30 min);
  ese throttle mantiene el ritmo de refresco cercano al de `claude` (~1 por vida de
  token) y evita machacar el endpoint de tokens, que **limita por tasa con dureza
  (429 confirmado en vivo)**. SEGURIDAD: el refresh token **rota** en cada
  refresco (la respuesta trae uno nuevo e invalida el viejo); por eso `refreshAccount`
  solo toca el fichero en **HTTP 200** (cualquier error → credenciales intactas, el
  refresh token viejo sigue válido) y escribe **atómico** (`writeJsonAtomic`),
  fusionando los tokens nuevos sin perder los demás campos (`scopes`,
  `subscriptionType`…) y conservando la unidad de `expiresAt` (ms aquí). RIESGO
  RESIDUAL: refrescar la cuenta **activa** puede competir con el refresco perezoso
  del propio `claude` por el mismo refresh token (ventana pequeña y rara, porque el
  throttle hace que solo coincidan cerca de la caducidad; `claude` re-lee
  `.credentials.json` por petición, así que en el caso normal adopta el token nuevo).
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
    Firefox/Edge/Brave/Opera/Opera GX (rutas conocidas por `BROWSERS`, con
    `%VARS%` expandidas; si no
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
  `maybeConfirmModel`) cuelgan del handler `data`. El estado `remoteOn` vive en el
  plugin y se resetea en `restart()` y cuando claude sale; `updateRemoteBtn()`
  refleja el estado en el botón (se reconstruye con la cabecera).
- **Selector de modelo** (`selectModel`): envía `\x15/model <id>\r` (el Ctrl+U
  inicial limpia cualquier borrador para que el comando vaya en su propia línea;
  restaurable con Ctrl+Y). Argumentos válidos comprobados: `haiku`, `sonnet`,
  `opus`.
- **Comandos**: "Open Claude Code panel", "Restart Claude Code session",
  "Send active note to Claude" (inserta `@<ruta>` de la nota activa), "Toggle
  remote control" (hotkey `Mod+R`), "Save current Claude account", "Diagnose
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
