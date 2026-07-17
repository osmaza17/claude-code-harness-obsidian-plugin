# LOG

Registro de cambios del plugin. El historial anterior a esta fecha no quedó
documentado aquí; el LOG arranca en esta entrada.

## 2026-07-17

- **Auto-switch: fuente del % invertida — API primero, scraping de respaldo.**
  Antes `maybeAutoSwitch` leía primero la regex de la barra de estado y caía a
  la API; ahora consulta primero `usagePct()` (cabeceras de rate-limit, dato
  autoritativo, refrescado cada 1 min y ya usado por el menú 👤 y
  `pickNextAccount`) y solo si no hay lectura fresca (sondeo off, red caída,
  token muerto) raspa la barra. Motivo: no colgar la decisión de una regex
  frágil frente a cambios del CLI; coste extra cero (el sondeo ya corría).
  Peor caso: lectura hasta ~1 min vieja, absorbida por el margen del 10 % del
  techo. Sin cambios en la decisión en sí (techos, modos, cooldown, anclaje del
  valor scrapeado). Test añadido con el texto real de la barra actual
  (`5h: 5% (4h 54m)  7d: 12% …`). Actualizados settings-tab (desc. de "Live
  usage") y README_TECNICO §"Fuente del %".
- **CLAUDE.md adelgazado (93 KB → 16 KB).** Motivo: se carga entero en el
  contexto de cada sesión de Claude (~25k tokens quemados por sesión). El
  antiguo CLAUDE.md completo se movió ÍNTEGRO al final de `README_TECNICO.md`
  ("APÉNDICE — Referencia exhaustiva del plugin"); el nuevo CLAUDE.md conserva
  la versión operativa (arquitectura, reglas NO REGRESAR numeradas, inventario
  de subsistemas condensado) y enlaza al apéndice para el detalle.
- **Suite de tests para la lógica pura (`npm test`).** `test/tests.ts` (asserts
  a pelo, sin framework) + `test/run.mjs` (compila con esbuild, alias
  `obsidian` → `test/obsidian-stub.mjs`, ejecuta desde un temp que se borra).
  Cubre: `looksLikePrompt`/`LIMIT_STOP_RE`/`AUTH_FAIL_RE`/`DEFAULT_USAGE_RE`
  (incluido el caso de regresión "resets at" que provocaba switches en bucle),
  franjas horarias, slug de proyecto y el parser del `.jsonl` del exporter
  (dedupe por `message.id`, filtrado de meta/slash-commands). Refactor mínimo
  para testear sin Obsidian: `parseHM` + `timeBlockedAt` movidos de accounts.ts
  a utils.ts (accounts delega, misma lógica); `encodeProjectSlug` y
  `parseConversation` exportadas de exporter.ts; `nodeRequire` ahora usa
  `globalThis.window?.require` (importable desde Node sin window).
- **Bug fix: el slug de proyecto no convertía `.` → `-`.** El CLI de Claude
  Code sí lo hace (verificado contra `~/.claude/projects`: `.ade` → `-ade`,
  `SECOND BRAIN\.obsidian\…` → `SECOND-BRAIN--obsidian-…`), así que
  `conversationJsonlPath` habría construido una ruta errónea para cualquier
  cwd con un punto (el vault actual no lo tiene → nunca se manifestó). Fix de
  un carácter en el regex de `encodeProjectSlug` (exporter.ts) y en su espejo
  `_encode_slug` (token-dashboard/token_dashboard/db.py). El charset completo
  que reemplaza el CLI sigue sin verificarse (podría ser "todo lo no
  alfanumérico"); ampliar si alguna ruta resuelve mal.
- **Icono de dueño-activo movido a la izquierda de la etiqueta** (antes quedaba a
  la derecha de la fila, empujado por el `flex` de `.cch-acct-label`). Ahora se
  crea justo antes de la etiqueta, tras el toggle de elegibilidad, para leerse
  pegado al email. Solo cambia el orden del DOM en `openAccountMenu`; el CSS no
  se tocó.
- **Detección "el dueño está usando su cuenta" + icono parpadeante en el menú 👤.**
  Motivo: el usuario usa cuentas prestadas y quiere saber cuándo su dueño real las
  está usando para no pisarle el límite. Detección en `refreshUsage` (accounts.ts):
  si el 5h % de una cuenta **inactiva** sube entre dos sondeos de la misma ventana
  (mismo `reset5h`; un reset re-basea), solo puede ser el dueño gastándola (el
  probe propio es ~1 token Haiku, nunca mueve un punto redondeado) → se sella
  `ownerActiveAt[email]`. `ownerActive(email)` = sello < `OWNER_ACTIVE_MS`
  (30 min, constants.ts). UI: icono `user` rojo parpadeante (`.cch-acct-owner`,
  keyframes `cch-owner-blink` en styles.css) junto a la cuenta en el menú 👤, con
  tooltip. Solo aviso visual: no capa auto-switch ni cambio manual. En memoria
  (se re-detecta en ≤2 ticks tras reiniciar).
- **Sondeo de uso: cada 1 min (era 3).** Para que la detección anterior reaccione
  rápido. Coste extra: una llamada Haiku de ~1 token por cuenta y minuto
  (despreciable). El refresh OAuth NO se acelera: `refreshAccount` ya solo
  refresca cuando quedan <30 min de vida (`REFRESH_SKEW_MS`), así que el endpoint
  de tokens recibe el mismo tráfico que antes.

## 2026-07-16

- **Ficheros no-nota clicables en la salida de Claude (PDF, xlsx, docx…).**
  `resolveNote` ya no filtra por `extension==="md"`: cualquier `TFile` que resuelva
  `getFirstLinkpathDest` es clicable. `openNoteLink` decide por tipo: extensiones
  que Obsidian renderiza (`OBSIDIAN_VIEWABLE_RE` en constants.ts:
  md/canvas/pdf/imágenes/audio/vídeo) → `openLinkText` (pestaña dentro de
  Obsidian); el resto (xlsx, docx…) → `app.openWithDefaultApp(path)` (app por
  defecto del SO). Los nombres **partidos por salto de línea** siguen funcionando
  sin cambios: la reconstrucción multi-línea de `computeNoteLinks` es agnóstica
  del destino (opera antes de resolver), y `resolveSpan` prueba las variantes
  con/sin espacio de unión contra el `resolveNote` ampliado.

- **Ronda de simplificación (auditoría ponytail, ~115 líneas fuera).** Sin cambio
  de comportamiento salvo lo anotado:
  - Borrado código muerto: `openInBrowser` (wrapper sin callers, resto del
    auto-open del remote control), campo `AccountUsage.status` + header
    `H_5H_STATUS` (se escribía, nadie lo leía), campo `Session.webgl` (write-only),
    campo `HeaderView.historyBtn` (nunca leído), ajuste `btnSkillsFolder` (sin
    toggle ni lector), `export { VIEW_TYPE }` de main.ts, exports internos de
    exporter.ts.
  - Borrado el plumbing async del picker `[[` (era de OmniSearch): `searchWikilink`
    ahora es síncrono, sin `wlSearchSeq` ni wrapper `queryNotes` (la fuente
    `nativeNotes` es síncrona; no hay respuestas obsoletas que descartar).
  - `relativeTime` y `stamp` ahora usan el `moment` que Obsidian exporta
    (`fromNow()`/`format()`); CAMBIO VISIBLE menor: el subtítulo del historial dice
    "3 hours ago" en vez de "3h ago". OJO: `moment` viene tipado como namespace en
    obsidian.d.ts pero es callable en runtime — se castea `(moment as any)`.
  - `newConversationId` = `crypto.randomUUID()` a secas (fuera el triple fallback;
    disponible en el Electron de cualquier Obsidian moderno).
  - `browserOptions` del settings-tab se deriva de `BROWSERS` (antes 12 etiquetas
    duplicadas a mano que podían divergir).
  - `pluginDir()` usa `manifest.dir` (fuera el id "claude-code-harness" hardcodeado).
  - Deduplicado el tipo de opts de `Session`/`newSession` en un `SessionOpts`;
    fusionados los dos handlers `exit` de `launchTokenDashboard`; `selectModel(id)`
    pierde el param `label` (no se usaba); `refreshHeader` (alias de
    `rebuildHeader`) e `isScheduleHardStop` (getter de un campo público)
    eliminados; `readSavedAccounts` ahora es private.

- **Carpetas del vault clicables en la salida de Claude.** Igual que las notas: si
  Claude menciona una carpeta (por ruta `Notas/Proyectos` o por nombre a secas,
  coloreada o como `[[wikilink]]`), el clic la **revela y despliega en el explorador
  de archivos** del sidebar izquierdo. Implementación mínima sobre la maquinaria
  existente: `resolveNote` ahora devuelve `TFile | TFolder` (si no resuelve a nota
  `.md`, busca una `TFolder` por ruta o nombre, case-insensitive, tolerando `\`) y
  `openNoteLink` bifurca: carpeta → `revealLeaf` del file explorer +
  `revealInFolder(folder)` (API interna sin tipar; si Obsidian la cambia, el clic
  no hace nada, sin error). Sin ajustes nuevos: lo gobierna el mismo
  `linkifyNotes`.

- **Fix: la skill no se inyectaba de forma intermitente (pestañas nuevas y
  reinicios).** Qué fallaba: a veces, sin patrón aparente, una pestaña nueva o un
  reinicio arrancaba sin la skill (`second-brain-assistant`) cargada. Causa raíz:
  `maybeSendInitial` pasteaba `/<skill>` con un **temporizador fijo de 1800 ms
  contado desde el primer `data` del pty**, pero ese primer `data` es el repintado
  que emite **conpty al spawnear**, no Claude. Si `claude.exe` tardaba más de ~1,8 s
  en llegar a su prompt (arranque en frío, MCP servers, máquina cargada), el paste
  caía dentro de su init de raw-mode y se perdía **en silencio**; si arrancaba
  rápido, funcionaba — de ahí la intermitencia. Fix: esperar la señal real de que
  la entrada de la TUI está viva, el **modo bracketed-paste** de xterm
  (`term.modes.bracketedPasteMode`, la misma bandera que ya consultaba
  `pasteToPty`): poll de 100 ms, 400 ms de asiento y tope de 60 s que inyecta a
  ciegas dejando log. En el caso normal dispara **antes** que el temporizador viejo.
  No es el gate de detección por escaneo de pantalla que se revirtió en 2026-07
  (aquel era lento por su tope de 20 s cuando no casaba).

## 2026-07-08

- **Botones flotantes de exportación a nota (esquina inferior derecha).** Dos
  botones nuevos superpuestos sobre el terminal (`.cch-export-fab`, anclados a
  `.claude-code-harness` que ya era `position:relative`): uno guarda el **último
  mensaje de Claude** y otro la **conversación entera** de la pestaña activa en
  una **nota nueva en la raíz del vault**, de forma automática (crea la nota,
  la abre en pestaña y avisa con `Notice`). También comandos "Export last Claude
  message to a new note" / "Export Claude conversation to a new note".
  - Módulo nuevo `exporter.ts`: lee el `.jsonl` de la conversación
    (`~/.claude/projects/<slug>/<sessionId>.jsonl`; slug = cada `:`\\`/`espacio
    → un `-`, mismo encoding que `token-dashboard/db.py:_encode_slug`), parsea
    línea a línea (best-effort, try/catch por línea), extrae solo bloques `text`
    (ignora tool_use/tool_result), filtra ruido (`isMeta`, `<command-…>`) y
    **deduplica los snapshots parciales del assistant por `message.id`**
    (Claude escribe 2–3 líneas por respuesta; gana la última, conservando la
    posición). Mensajes consecutivos del mismo rol se fusionan en una sección.
  - Nombres de nota: `Claude - <título de pestaña> - último mensaje|conversación
    - YYYY-MM-DD HH.mm.md`, con sufijo ` (2)` si colisiona.
  - Toggle "Export-to-note buttons (bottom-right)" (`btnExportNotes`, def. on);
    el fab se (re)construye en `attachView`/`refreshExportFab` y se limpia en
    `detachView`/`onunload`.
  - Verificado el parser contra dos `.jsonl` reales del vault (22 y 5 mensajes,
    dedupe y fusión correctos) + `npm run build` limpio.
  - Docs: CLAUDE.md y README.md actualizados.

## 2026-07-06

- **Fix: cuentas que "expiraban" en horas (corrupción de snapshots).** El usuario
  reportó que las cuentas guardadas caducaban extremadamente rápido y había que
  re-loguearlas todo el rato. Diagnóstico sobre `~/.claude/cch-accounts/`: dos
  modos de fallo reales, con dos fixes en `accounts.ts`:
  1. **Snapshots machacados con tokens vacíos** (2 cuentas vistas con
     `accessToken:""`/`refreshToken:""`/`expiresAt:0`): `claude` deja
     `.credentials.json` vacío al hacer logout (o tras un 401), y el
     auto-save (`maybeAutoSaveAccount` → `saveCurrentAccount`) snapshoteaba ese
     estado encima de un snapshot bueno → cuenta irrecuperable sin `/login`.
     Fix: `saveCurrentAccount` valida `claudeAiOauth.accessToken` +
     `refreshToken` no vacíos antes de escribir; si faltan, no toca el snapshot
     (warn en consola, Notice solo en guardado manual).
  2. **Refresh tokens rotados y huérfanos** (2 cuentas con snapshots sin poder
     refrescarse desde días atrás, keep-alive → 401): los RT **rotan** (el viejo
     se invalida al usarse) y `claude` rota el de la cuenta ACTIVA mientras se
     usa; si luego se salía de esa cuenta con **`/login` en la TUI** (no con el
     selector del plugin, que sí re-snapshotea la saliente), el snapshot quedaba
     con un RT muerto. Fix: `maybeResnapshotActive(lower)` — en cada tick de
     keep-alive (3 min), la rama `isActive` de `refreshAccount` compara los
     tokens vivos de `.credentials.json` con el snapshot y re-snapshotea si
     `claude` los rotó.
  - CAVEAT (honesto): son cuentas prestadas que también se usan en los
    dispositivos de sus dueños; las revocaciones/rotaciones externas del grant
    seguirán matando snapshots de vez en cuando — eso no es arreglable desde el
    plugin, solo re-`/login`. Los fixes eliminan las muertes causadas por el
    propio plugin.
  - Pendiente de observar: que las cuentas hoy marcadas `expired` se re-logueen
    una vez y ya no vuelvan a caer solas.

## 2026-07-01

- **Historial de conversaciones estilo ChatGPT/Claude web (sidebar superpuesto).**
  Nuevo botón de cabecera (icono `history`, toggle de ajustes `btnHistory`) en el
  **extremo izquierdo, junto al botón @**, y comando "Open Claude session history"
  que abren `openHistoryMenu()` (toggle): un **cajón lateral que se SUPERPONE** sobre
  la conversación (no la comprime), no un popup. `.cch-history-overlay` se monta
  **dentro del `viewRoot`** (`position:absolute`, `top` inline = altura de `.cch-header`
  vía `offsetHeight`, para no tapar la toolbar), atenúa el resto y contiene el
  `.cch-history-sidebar` (~340px, desliza desde la izquierda). Cierre por su × /
  Escape / click en el backdrop; refs `historyOverlay`/`historyOverlayCleanup`
  limpiadas en `onunload`, `detachView` y `setActive`. **Reutiliza la pila persistida
  `settings.closedSessions`** (la misma que `Ctrl+Shift+Y`), renderizada
  **más-reciente-primero**: cada fila con título + subtítulo (`relativeTime(closedAt)`
  + skill/modelo). Click en la fila → `reopenSession(info)` reabre **esa** conversación
  (cualquiera, no solo la última) en pestaña nueva vía `--resume` y la quita de la
  pila por `sessionId`; la × → `deleteClosedSession(info)` la borra del historial sin
  reabrir (el `.jsonl` en disco intacto) y re-renderiza in situ.
  `reopenClosedSession`/`reopenSession` comparten `reopenInfo(info)`.
  - `ClosedSessionInfo` gana `closedAt?` (epoch ms, opcional para no romper
    entradas persistidas viejas), sellado en `closeSession` y `flushOpenSessions`.
  - CSS `.cch-history-overlay`/`.cch-history-sidebar` (drawer scrollable con animación
    de entrada, filas con hover y × que aparece al pasar el ratón); `.claude-code-harness`
    pasa a `position:relative` como ancla del overlay. Añadido a los toggles de
    "Header buttons".
  - CAVEAT: el historial es la pila de reopen (tope `MAX_CLOSED_SESSIONS`=25), no
    un índice de **todos** los `.jsonl` del disco.

## 2026-06-27

- **Revertida por completo la función de "aviso al terminar una sesión".** Se había
  construido una tanda de commits (sonido "ding" con Web Audio, luego Notice por
  pestaña, cola escalonada, debounce anti-parpadeo y "avisar solo de pestañas no
  atendidas"). A petición del usuario se elimina **todo** ese trabajo: tanto el
  sonido como el aviso visual. `main.ts` vuelve al estado de `9f98e00` (el commit
  anterior al sonido), conservando el punto heartbeat básico de las pestañas, que es
  anterior e independiente. Borrados: ajustes `notifyOnIdle`/`noticeOnIdle`/
  `notifyOnlyIfUnattended`/`idleNotifyDelaySec`/`idleBlipIgnoreMs`, métodos
  `notifySessionIdle`/`playIdleChime`/`markAttended`/`isSessionAttended`, campos
  `idleChimeTimer`/`attendedSinceIdle`/`audioCtx`/`chimeTail` y su UI de ajustes.
  Recompilado `main.js`. (El "Aviso por bell" sobre `term.onBell` es una función
  distinta y anterior; se mantiene.)

- **Menú 👤: cuenta atrás hasta el reseteo de la ventana de 7d.** El menú de
  cuentas (y la lista de ajustes) ya mostraban el % de uso de 7d pero no cuándo
  se resetea esa ventana; ahora muestran también el tiempo restante, junto al de
  la ventana de 5h.
  - `AccountUsage`: campo nuevo `reset7d` (epoch, o `null`).
  - `probeUsage`: parsea el header `anthropic-ratelimit-unified-7d-reset`. Como
    ese nombre es por simetría con el de 5h y NO está verificado en vivo, hay un
    respaldo que escanea cualquier header cuyo nombre contenga "7d" y "reset". Si
    el header no existe, la cuenta atrás de 7d simplemente no aparece (sin romper
    nada).
  - Formateo unificado en `resetCountdown(epoch)`: días+horas para la ventana de
    7d (`3d 4h`), horas+minutos o solo minutos para la de 5h. Usado tanto por
    `usageLabel` (ajustes, texto plano `… · 7d NN% (Dd Hh)`) como por
    `accountMenuTitle` (columna alineada del menú 👤).

- **Token Dashboard: gráficas vacías mientras corre el primer escaneo.** Antes,
  durante el ~1 min del análisis inicial el dashboard parpadeaba re-renderizando
  con datos parciales. Ahora muestra el layout con las **gráficas vacías** y un
  aviso discreto "Analyzing your usage…", y solo las rellena **una vez**, cuando
  el escaneo termina.
  - `cli.py cmd_dashboard`: se quitó el `scan_dir` bloqueante previo a `run()`;
    el servidor arranca al instante (el navegador abre de inmediato).
  - `server.py`: el escaneo inicial pasó al hilo de fondo `_scan_loop`. Bandera
    `READY` (threading.Event), endpoint `/api/status` (`{ready}`) y evento SSE
    one-off `{"type":"ready"}` al terminar el primer escaneo. Si ese escaneo
    falla, igual marca `ready` para no dejar la UI clavada en "analizando".
    `run(..., initial_scan=not no_scan)`.
  - `web/app.js`: `state.ready`; se consulta `/api/status` al arrancar (fail-open).
    El handler SSE rellena las gráficas solo al llegar `ready`; ignora los
    eventos `scan` mientras no esté listo.
  - `web/routes/overview.js`: mientras `!ready` no pide datos y dibuja KPIs en 0
    + gráficas vacías; estilo `.analyzing` (punto pulsante) en `web/style.css`.

## 2026-06-26

- **Autocompletado `[[` → referencia `@` en el terminal.** Al escribir `[[` en el
  input de Claude se abre un desplegable flotante anclado al cursor (estilo
  Obsidian) con las notas más parecidas; al elegir, `[[consulta` se sustituye por
  una referencia `@<ruta> ` (la sintaxis de archivos de Claude Code), no por un
  `[[wikilink]]`. Flechas mueven, Enter/Tab/click eligen, Escape cancela.
  - Sugerencias del **suggester nativo de Obsidian** (`metadataCache.getLinkSuggestions()`
    + `prepareFuzzySearch` + `sortSearchResults`) → los **mismos resultados** que el
    `[[` de una nota. Estado y métodos nuevos en `Session` (`feedWikilink`,
    `openWikilinkPicker`/`closeWikilinkPicker`, `searchWikilink`, `queryNotes`,
    `renderWikilinkResults`, `acceptWikilink`, `positionWikilinkPopup`); CSS
    `.cch-wikilink-*`; ajuste `wikilinkPicker` (on por defecto).
  - **Insensible a acentos** (`stripDiacritics`): se normaliza consulta y candidato
    (NFD → quita `\p{Diacritic}` → NFC) antes de casar, porque el `prepareFuzzySearch`
    nativo es sensible a tildes; así `[[energia` encuentra "Energía".
  - **Fuente de sugerencias = OmniSearch** (cambio posterior, mismo día): el picker
    pasó del suggester nativo a la API de OmniSearch (`omnisearch.api.search`) →
    full-text (busca también el contenido) e insensible a acentos por sí misma,
    iguala la ventana de OmniSearch. El nativo (`nativeNotes`) queda como **fallback**
    (OmniSearch ausente/falla) y para la consulta vacía. `searchWikilink` pasa a
    async con `wlSearchSeq` para descartar respuestas obsoletas.
  - **Gotcha teclado internacional:** en el teclado español `[` llega por la rama
    AltGr del key handler y **nunca pasa por `onData`**, así que `feedWikilink` se
    alimenta desde ambas rutas para detectar `[[` y construir la consulta.

## 2026-06-25

- **Pestañas: ancho uniforme y compresión en vez de scroll lateral.** Cuando hay
  muchas instancias, la barra de pestañas ya no muestra scroll horizontal: las
  pestañas se **comprimen** y todas mantienen **el mismo ancho** entre sí.
  - `styles.css`: `.cch-tab` pasa de `flex: 0 0 auto` a `flex: 1 1 0` (basis cero +
    grow/shrink iguales → reparte el strip a partes iguales). `min-width: 52px` como
    piso, suficiente para mostrar **siempre** el punto de heartbeat + el botón ×
    (el dot y `.cch-tab-close` son `flex: 0 0 auto`, no encogen). Solo si ni a ese
    piso caben todas, `.cch-tabs` (`overflow-x: auto`) recurre al scroll.
  - `.cch-tab-label` ahora `flex: 0 1 auto; min-width: 0` para que la etiqueta se
    recorte (ellipsis) hasta cero antes de tocar el dot/×.
  - El drag de reorden (`beginTabDrag`) no se tocó: mide anchos reales con
    `getBoundingClientRect()`, así que opera sobre el ancho comprimido.

## 2026-06-24

- **Zen y Helium como navegadores nativos del `browserMap`.** Antes solo se
  reconocían Chrome/Firefox/Edge/Brave/Opera/Opera GX de forma nativa; Zen y
  Helium había que meterlos como `custom` con la ruta del `.exe`.
  - `BROWSERS` (registro de rutas): añadidas las entradas `zen`
    (`%PROGRAMFILES%\Zen Browser\zen.exe` + fallbacks de instalación por usuario,
    `proc: "zen"`) y `helium`
    (`%LOCALAPPDATA%\imput\Helium\Application\chrome.exe`, `proc: "chrome"`).
  - `browserOptions` (desplegables de ajustes: "Default browser" y el mapeo por
    cuenta): añadidas las opciones `Zen` y `Helium`.
  - Notas: el ejecutable de Helium se llama `chrome.exe` (es Chromium) y vive en
    `Application\`, no en la subcarpeta de versión (que solo tiene helpers); por eso
    la entrada `custom` previa (que apuntaba a la carpeta de versión) no lanzaba nada.
    Como su proceso es `chrome.exe`, `proc` colisiona con el de Chrome, así que
    `focusFullscreen` podría enfocar una ventana de Chrome en vez de Helium
    (best-effort, sin arreglo limpio porque el proceso es realmente chrome.exe).
- **Vivaldi, Waterfox, Floorp y Mullvad Browser como navegadores nativos.**
  Instalados en el equipo con winget (`Vivaldi.Vivaldi`, `Waterfox.Waterfox`,
  `Ablaze.Floorp`, `MullvadVPN.MullvadBrowser`) y añadidos a `BROWSERS` +
  `browserOptions` para tener más slots de cuenta (un navegador por cuenta).
  - Rutas: Vivaldi `%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe`; Waterfox
    `%PROGRAMFILES%\Waterfox\waterfox.exe`; Floorp `%PROGRAMFILES%\Ablaze Floorp\floorp.exe`;
    Mullvad `%LOCALAPPDATA%\Mullvad\MullvadBrowser\Release\mullvadbrowser.exe`.
  - CAVEAT Mullvad: está basado en Tor Browser; verificar que la sesión de Claude
    persiste entre reinicios (las defaults anti-persistencia podrían borrar el login).

## 2026-06-19

- **Keep-alive: la cuenta activa ya no se refresca desde el plugin (cierra la
  carrera del refresh token).** Las cuentas caían a `expired`/`/login` de forma
  aleatoria: el plugin y el propio `claude` refrescaban a la vez el token de la
  cuenta **activa** usando el mismo refresh token, que **rota** en cada uso, así
  que uno invalidaba al del otro (→ 401 → login).
  - `refreshAccount` ahora **salta la cuenta activa** (`if (isActive) return true`):
    de ella se ocupa solo `claude` (re-lee `.credentials.json` y rota perezosamente
    por petición). El plugin sigue mantieniendo vivas solo las cuentas **inactivas**,
    donde no hay carrera.
  - Coste asumido: la barra de uso de la activa puede mostrar `expired` un instante
    tras caducar su access token, hasta el siguiente mensaje (falso positivo benigno).
- **Logs de diagnóstico del keep-alive** (`[cch keepalive] …` en DevTools): cada
  refresco emite `skip active` / `refreshing` / `refreshed … ok` / `refresh FAILED`,
  y `oauthRefresh` registra la causa de cada fallo (`token endpoint HTTP <status>`
  —401 token muerto, 429 rate-limit—, `network error`, `timeout`). Permite saber
  con certeza por qué cae una cuenta en vez de adivinar.
  - Docs: CLAUDE.md actualizado (sección "Keep-alive de tokens"; cierra el
    "RIESGO RESIDUAL").

- **Menú de cuentas (botón 👤): una sola lista con toggle por cuenta.** Antes
  había dos listas (una para cambiar de cuenta, otra para permitir/bloquear el
  auto-switch). Ahora es **una única lista**.
  - `openAccountMenu(anchor)` deja de usar el `Menu` de Obsidian (no permite dos
    acciones por fila) y pasa a ser un **popup DOM propio** (`.cch-account-menu`,
    `position:fixed`, montado en `document.body`). Cierre por click-fuera/Escape
    vía `closeAccountMenu()` (refs `accountPopup`/`accountPopupCleanup`, limpiado
    en `onunload`).
  - Cada fila `.cch-acct-row`: a la **izquierda** un toggle `.cch-acct-toggle`
    (verde = habilitada; gris = deshabilitada) que conmuta `toggleAccountEligible`
    **sin cerrar** el popup; a la derecha la **etiqueta** `.cch-acct-label`
    (clic = `switchToAccount`).
  - **Deshabilitación total en el popup**: una cuenta off se sombrea
    (`cch-acct-blocked`) y su etiqueta es **inerte** (clic no cambia de cuenta;
    muestra un `Notice`). Fuera del popup el flag `autoSwitchExcluded` sigue
    afectando solo al auto-switch.
  - **Posición clampeada al viewport** (mide `getBoundingClientRect()` y corrige
    `left`/`top` con 8px de margen); el popup se desplaza ~180px a la izquierda
    del botón para no salirse por la derecha.
  - **Colores legibles de cuenta desactivada**: tinte rojo tenue + borde
    izquierdo rojo, con el email en `--text-muted` tachado pero **sin opacity
    wash**, para seguir identificando la cuenta.
  - Docs: CLAUDE.md y README.md actualizados.

## 2026-06-18

- **Bloquear cuentas del auto-switch.** Nueva opción para impedir que el cambio
  automático por porcentaje elija ciertas cuentas (p. ej. cuentas de amigos),
  para no gastar sus tokens. El cambio manual sigue permitido siempre.
  - Setting nuevo `autoSwitchExcluded: string[]` (emails en minúscula; def. `[]`).
  - Helpers `isAccountEligible(email)` / `toggleAccountEligible(email)`.
  - `pickNextAccount()` salta las cuentas bloqueadas (ruta "menos gastada" y
    round-robin de respaldo).
  - Menú del botón 👤 refactorizado a `openAccountMenu(anchor)` con una sección
    "Auto-switch to (click to allow/block)" (check + icono `repeat` = permitida;
    sin check + icono `ban` = bloqueada); al pulsar conmuta y reabre el menú.
  - Ajustes → "Claude accounts": botón extra `repeat`/`ban` por cuenta.
  - `requestSwitch` avisa una vez si todas las demás cuentas están bloqueadas.
  - Docs: CLAUDE.md y README.md actualizados; LOG.md creado.
