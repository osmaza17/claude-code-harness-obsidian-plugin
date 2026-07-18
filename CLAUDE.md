# CLAUDE.md

Guía operativa para Claude Code en este plugin. Es la versión **condensada**:
la narrativa exhaustiva de cada subsistema, bug y decisión (el "porqué" largo)
vive en el **apéndice de `README_TECNICO.md`** ("APÉNDICE — Referencia
exhaustiva del plugin") y en `LOG.md` (cronología de fixes). Si algo de aquí te
sabe a poco, busca la sección homónima en el apéndice antes de re-derivarlo.

## Qué es

Plugin de Obsidian (solo escritorio) que abre la **TUI real de Claude Code** en
un panel lateral, con `cwd` = raíz del vault. Varias pestañas = varias
instancias de `claude` en paralelo. Estética via variables CSS de Obsidian.

## Stack

- Obsidian Plugin API, TypeScript, esbuild (bundle → `main.js`).
- xterm.js (`@xterm/xterm` + fit + unicode11 + webgl).
- node-pty ^1.1.0 en un **proceso Node aparte** (`pty-host.js`, forkeado con el
  `node.exe` real del sistema; IPC por `process.send`).

## Prerrequisitos (PC nuevo)

- Obsidian de escritorio; Windows/macOS (prebuilds N-API de node-pty incluidos;
  en Linux instalar SIN `--ignore-scripts` → compila node-pty, requiere C++).
- Node.js del sistema (autodetectado por `resolveNodePath()`; ajuste "Node.js path").
- CLI `claude` en el PATH y logueado una vez (`/login` crea `~/.claude/.credentials.json`).
- Opcionales: `~/.claude/skills/` (selector de skills), Python (Token Dashboard).
- CAVEAT multi-cuenta: el hot-swap exige credenciales en fichero plano; en macOS
  con Keychain no funciona (ver README_TECNICO.md).

## Comandos

```bash
npm install --ignore-scripts   # node-pty trae prebuilds; no compilar (salvo Linux)
npm run build                  # produce main.js (producción)
npm run dev                    # build con watch
npm test                       # tests de la lógica pura (test/run.mjs, sin framework)
```

Tras compilar, recargar el plugin en Obsidian (Ajustes → Complementos → recargar).

## Tests

`npm test` → `test/run.mjs` compila `test/tests.ts` con esbuild (alias
`obsidian` → `test/obsidian-stub.mjs`) a un temp y lo importa; asserts a pelo,
sin framework. Cubre la lógica pura que históricamente se rompe en silencio:
regexes best-effort (`looksLikePrompt`, `LIMIT_STOP_RE`, `AUTH_FAIL_RE`,
`DEFAULT_USAGE_RE`), franjas horarias (`timeBlockedAt`/`parseHM`, en `utils.ts`),
slug de proyecto (`encodeProjectSlug`, exportada de `exporter.ts`) y el parser
de `.jsonl` (`parseConversation`, exportada de `exporter.ts`). **Si tocas una
regex de constants.ts o esa lógica, corre `npm test` y añade el caso real que
motivó el cambio.**

## Arquitectura (resumen)

- **`Session`** (en `main.ts`): una instancia de claude = un xterm + un host DOM
  + un fork de pty-host. Estado por-instancia: skill/model/args/title, resize,
  clipboard, data handler, watchers de su TUI, `sessionId` (UUID propio,
  inyectado como `--session-id` en `startHost` — determinista para poder hacer
  `--resume <uuid>` al reabrir).
- **Plugin** (gestor): `sessions[]` + `activeIndex`; solo la activa está montada
  en el panel (el host se mueve dentro/fuera del DOM; **`term.open()` una sola
  vez por sesión**). Cerrar el panel no mata nada; la × de pestaña sí
  (`closeSession`, que archiva la config en `settings.closedSessions` si
  `hasActivity()`).
- **Managers** (extraídos del Plugin, misma lógica): `plugin.accounts`
  (`accounts.ts`: cuentas/hot-swap/probe/keep-alive/auto-switch/franjas/popup 👤),
  `plugin.history` (`history.ts`: pila de reopen, snapshot de tabs abiertos,
  auto-restauración, sidebar de historial), `plugin.header` (`header.ts`:
  cabecera/pestañas/toolbar), `HarnessSettingTab` (`settings-tab.ts`).
- **Persistencia**: `settings.openSessions` (snapshot debounced ~1,5 s de tabs
  con actividad o pineados) + `settings.closedSessions` (LIFO 25, reopen con
  Ctrl+Shift+Y / historial). Al reabrir Obsidian, `restorePendingOpenSessions()`
  restaura los tabs **al abrir el panel** con `--resume` (ver NO REGRESAR #2).
- **Restart vs Reload**: `restart()` = **pestaña nueva** (conversación nueva,
  vía `plugin.restartSession`, archiva la vieja); `reloadSession()` = mismo
  `sessionId`, `term.reset()` + `--resume` (arregla TUI entremezclada sin perder
  la conversación; no archiva).
- **pty-host.js** no multiplexa: una instancia = un fork; protocolo IPC
  documentado en el propio fichero. Mata el PTY en `{t:"kill"}` y en
  `disconnect`; `killChild()` manda kill + respaldo a 800 ms (sin esto quedaban
  `claude.exe` huérfanos en Windows).

## NO REGRESAR (reglas duras, cada una costó un bug real)

1. **node-pty jamás en el renderer** (crea un Worker que el renderer de Obsidian
   no soporta) → vive en pty-host, forkeado con el **Node real** (`execPath`),
   porque Obsidian deshabilita `ELECTRON_RUN_AS_NODE`.
2. **Restaurar tabs en `attachView`, NUNCA en `onload`**: restaurar detached
   (panel sin tamaño) hacía que `claude --resume` pintara al tamaño de arranque
   y el fit posterior superponía otro repintado → footer duplicado. En
   `attachView` cada tab monta con buffer vacío al tamaño real (misma ruta que
   Ctrl+Shift+Y).
3. **Restart = reemplazar la pestaña por una `Session` nueva**, nunca in-place
   (kill + reset + startHost compartiendo terminal tenía carreras y perdía la
   inyección de la skill; 2 intentos fallidos en el historial de git). La guarda
   `this.child !== child` en los handlers de `startHost` se conserva (protege
   `reloadSession`, que sí es in-place).
4. **Inyección inicial (`maybeSendInitial`): verificar el ECO en pantalla y
   reintentar**, no confiar en ninguna señal previa. Medido (2026-07-18):
   claude enciende bracketed-paste a ~0,5 s pero descarta TODO input hasta ~2 s
   — ni timer fijo ni el gate por `bracketedPasteMode` (fix 2026-07-16) bastan;
   ambos fallaban intermitentemente. `submit` pastea, comprueba con
   `screenHasText` que el texto está en el composer y solo entonces manda Enter;
   si no, `\x15` + re-paste cada 500 ms (tope 60 s → envío a ciegas). El gate
   por bracketed-paste queda solo como arranque temprano de los intentos. En
   tabs `resume:true` no se inyecta nada. Envío con `pasteToPty()` (no
   `term.paste()`: exigía vista montada). Logs `[cch initial]`.
5. **Resize**: la TUI repinta TODO en cada SIGWINCH y deja el frame viejo como
   scrollback → `fitNow(false)` por frame (solo xterm) + `fitNow(true)` con
   debounce ~120 ms (un solo resize al pty por gesto). Solo mandar resize si
   cols/rows cambian, `cols>=2 && rows>=2` y `!exited` (un resize degenerado
   durante el cambio de theme mataba al conpty). Queda 1 banner duplicado por
   gesto: intrínseco, no perseguirlo.
6. **Zoom**: `applyFontSize` = un único `fit.fit()` + resize; **NO** llamar
   `clearTextureAtlas()`/`term.refresh()` (dejaba el frame garabateado).
7. **Cambio de pestaña**: `resyncAfterReattach()` fuerza el recálculo del
   viewport con un round-trip `rows-1 → rows` **solo en xterm** (jamás
   `{t:"resize"}` al pty) — sin esto el scroll quedaba congelado.
8. **Unicode11Addon + activeVersion="11"** (emojis 2 celdas) y **WebglAddon**
   tras `term.open()` con fallback a DOM. Sin ellos la rejilla se desalinea.
9. **`LIMIT_STOP_RE` estricta**: sin el `resets at` suelto (la antigua
   `LIMIT_RE` casaba con la barra de estado y provocaba switches en bucle).
   Tras cada `triggerSwitch` se vacían los `autoSwitchBuf` de todas las sesiones.
10. **Detección de "esperando respuesta" leyendo la PANTALLA renderizada**
    (`screenShowsPrompt` sobre `term.buffer.active`), no el flujo de bytes (la
    barra de estado empujaba el formulario fuera del buffer rodante → verde
    falso). `looksLikePrompt` exige frase completa O pista nav+act juntas
    (fragmentos sueltos salen en la prosa). Escaneo con debounce ~80 ms
    (xterm parsea async).
11. **Keep-alive OAuth**: la cuenta **ACTIVA no se refresca desde el plugin**
    (competía con claude por el refresh token rotatorio → 401 aleatorios); solo
    escribir en **HTTP 200**; escrituras **atómicas** (`writeJsonAtomic`);
    `saveCurrentAccount` **rechaza credenciales vacías** (un logout snapshoteado
    mataba la cuenta para siempre); `maybeResnapshotActive` re-snapshotea si
    claude rotó tokens de la activa. El endpoint de tokens limita duro (429):
    solo refrescar si caducado o <30 min (`REFRESH_SKEW_MS`).
12. **`switchToAccount`: leer y validar TODO antes de escribir nada** (escribir
    primero dejaba estados a medias que el auto-save convertía en snapshots
    corruptos). Antes de escribir, re-snapshotea la saliente.
13. **Remote control OFF**: las flechas inyectadas en crudo deben respetar
    DECCKM (`\x1bOA`, no `\x1b[A`) o el Enter cae en "Continue".
14. **Teclado internacional**: `[` llega por la rama AltGr del key handler (no
    por `onData`) → `feedWikilink` se llama desde ambas rutas
    (`alreadySent=true` en AltGr). No unificar.
15. **Caché de disco 5 s** (`ACCOUNT_CACHE_MS`) en `currentAccountEmail()`/
    `listSavedAccounts()`: el watcher corre en cada chunk del PTY y releer
    `~/.claude.json` decenas de veces/s producía jank real. Las escrituras del
    plugin invalidan la caché.
16. **IPC**: todo envío al host pasa por `send()` (traga
    `ERR_IPC_CHANNEL_CLOSED`); pty-host traga errores de `resize`/`input` con
    guarda `cols>0 && rows>0`.

## Subsistemas (inventario condensado — detalle en el apéndice de README_TECNICO.md)

- **Pestañas**: heartbeat por estado (`tabState`: exited > limitReached >
  awaitingInput > busy > idle; rojo fijo = límite o await en tab activa, rojo
  **parpadeante** = await en tab NO activa — puro CSS por especificidad con
  `.cch-tab-active`); auto-título (precedencia manual > OSC > primer prompt,
  `setTitleFrom`); drag de reorden propio (no HTML5 DnD); pin estilo Chrome
  (compacta, se restaura SIEMPRE, viaja por closedSessions); ancho uniforme
  comprimible (flex `1 1 0`, piso 52px).
- **Cuentas (hot-swap)**: snapshots en `~/.claude/cch-accounts/<email>.json`
  (NO versionar: tokens); claude vivo re-lee `.credentials.json` en la
  siguiente petición → cambiar cuenta no reinicia ni pierde conversación.
  Auto-guardado al detectar `/login` (throttle 10 s).
- **Auto-switch** (opt-in): fuente del % = **API primero** (`usagePct`, dato
  autoritativo de las cabeceras, refrescado cada 1 min; hasta ~1 min de
  antigüedad, que el margen del 10 % absorbe) con **respaldo por scraping** de
  la barra (`DEFAULT_USAGE_RE`, ÚLTIMA coincidencia del buffer, con guarda de
  anclaje email↔cuenta) — invertido el 2026-07-17, antes era scraping-primero;
  techo duro 5h ≥90 % (`SWITCH_CEILING_PCT`, prevalece sobre modos threshold/
  rotate; si nadie baja del 90 % se queda); techo semanal del DESTINO ≥95 %
  (`WEEKLY_CEILING_PCT`, solo filtra candidatos); destino = menos gastada
  elegible (`pickNextAccount`, salta bloqueadas/auth-muertas/en franja);
  cooldown 10 s; verificación del swap por email de la barra; diagnóstico en
  `lastDiagInfo` (comando "Diagnose auto-switch").
- **Franjas horarias** (`accountSchedules`): lógica pura en
  `utils.timeBlockedAt` (testeada); cuenta en franja = descartada como destino
  + pintada roja clicable en el popup 👤; `enforceSchedule` (tick 20 s, corre
  aunque autoSwitch esté OFF) salta o, sin destino, **corta la generación**
  (Esc) — no bloquea el teclado.
- **Live usage**: `probeUsage` = POST `/v1/messages` `max_tokens:1` (Haiku) con
  el OAuth token → headers `anthropic-ratelimit-unified-5h/7d-*`; sondea cada
  cuenta SIN cambiarse (token del snapshot); tick de 1 min (todas + keep-alive),
  tras actividad solo la activa (debounce 60 s). Detección de dueño-activo:
  5h % de una cuenta inactiva sube dentro de la misma ventana → icono rojo
  parpadeante en el popup 👤 (solo aviso, 30 min TTL, en memoria).
- **Popup 👤** (`openAccountMenu`): DOM propio clampeado al viewport; por fila:
  toggle de elegibilidad (deshabilitada = inerte TOTAL aquí), etiqueta
  monospace con % coloreados y countdowns, botón log-in que abre claude.ai en
  el navegador mapeado a ESA cuenta (`browserMap`, `launchBrowser`).
- **Skills**: `~/.claude/skills/*/SKILL.md`; selector en cabecera; `/[skill]`
  se inyecta al arrancar (salvo resume) y al elegir en caliente. `/model` NO se
  envía al arrancar (decisión del usuario): la etiqueta puede no reflejar el
  default real de claude hasta elegir a mano.
- **Enviar notas**: botón @, menú contextual del explorador, drag-and-drop
  (interno via `dragManager`, del SO via `webUtils.getPathForFile` con fallback
  `File.path`).
- **Links clicables** (`computeNoteLinks`): wikilinks + runs coloreados que
  resuelvan a CUALQUIER fichero del vault o carpeta; reconstruye bloques
  multi-línea (la TUI envuelve con sangría de 2 espacios y sin `isWrapped`) y
  emite un ILink por fila; `resolveSpan` prueba variantes quitando espacios de
  unión (cortes a mitad de palabra). Carpetas → reveal en el file explorer
  (API interna). Viewables (`OBSIDIAN_VIEWABLE_RE`) → `openLinkText`; resto →
  `openWithDefaultApp`.
- **Picker `[[`** (`feedWikilink` y compañía, en `Session`): popup flotante
  anclado al cursor; fuente = suggester nativo (`getLinkSuggestions` +
  `prepareFuzzySearch`), insensible a acentos vía `stripDiacritics`; al aceptar
  borra lo tecleado con `\x7f` × (2+query) y manda `@<ruta> `.
- **Export a nota** (`exporter.ts`): botones flotantes bottom-right + comandos;
  fuente = el `.jsonl` de `~/.claude/projects/<slug>/<sessionId>.jsonl`
  (`encodeProjectSlug`: `:`, `\`, `/`, espacio y `.` → `-`, verificado contra
  carpetas reales); `parseConversation` deduplica snapshots del assistant por
  `message.id` (gana el final, conserva posición) y filtra meta/slash-commands.
  Nota nueva en la raíz del vault.
- **Historial**: drawer superpuesto (`.cch-history-overlay` dentro de
  `viewRoot`, top = altura de la cabecera); lista `closedSessions` invertida;
  click reabre esa conversación (y la saca de la pila), × la borra del
  historial. Ctrl+Shift+Y = pop (NO Ctrl+Shift+T: Obsidian lo captura).
- **Remote control** (Ctrl+R / `Mod+R`): OFF→ON solo conecta (la URL la
  muestra el panel de claude; toda la auto-captura/navegador se ELIMINÓ a
  petición del usuario — está en git si se quiere recuperar); ON→OFF reenvía
  el comando + flechas DECCKM + Enter.
- **Token Dashboard**: `spawn(python cli.py dashboard --no-open)` en
  `token-dashboard/`, espera `listening on`, abre navegador default. Server
  arranca al instante; primer escaneo en background con bandera `READY` + SSE
  `{"type":"ready"}` (gráficas vacías hasta listo).
- **Otros atajos**: zoom Ctrl+±/0/rueda (global); Ctrl+Z/Ctrl+Shift+Z →
  0x15/0x19; Ctrl/Shift+Enter = LF sin enviar; Ctrl+V pega imagen como PNG
  temporal (barridos en `onunload`/carga); bell → Notice (`notifyOnBell`).

## Estructura

```
manifest.json        metadatos (id: claude-code-harness)
esbuild.config.mjs   bundling (entry: main.ts; obsidian/electron/node-pty/builtins external)
main.ts              Session + Plugin (gestor) + ClaudeCodeView
accounts.ts          AccountManager: cuentas, probe, keep-alive, auto-switch, franjas, popup 👤
history.ts           SessionHistory: reopen/openSessions/auto-restauración/sidebar
header.ts            HeaderView: cabecera, pestañas, toolbar, menús
settings-tab.ts      HarnessSettingTab (globales + tarjetas por cuenta)
types.ts             tipos compartidos (sin runtime)
constants.ts         defaults, regexes best-effort, endpoints, MODELS, BROWSERS, ANSI
exporter.ts          export a nota (.jsonl → markdown); encodeProjectSlug/parseConversation
utils.ts             helpers puros: nodeRequire, stripDiacritics, newConversationId,
                     parseHM, timeBlockedAt (testeados)
test/                tests.ts (asserts) + run.mjs (runner esbuild) + obsidian-stub.mjs
pty-host.js          proceso node-pty (NO se empaqueta)
main.js              artefacto compilado
styles.css           xterm.css + layout
token-dashboard/     Token Dashboard en Python (stdlib)
README_TECNICO.md    manual del cambio de cuenta + APÉNDICE con la referencia
                     exhaustiva del plugin (el antiguo CLAUDE.md íntegro)
LOG.md               cronología de cambios y fixes (más reciente arriba)
```

## Convenciones

- Regexes contra la TUI son **best-effort**: el texto de claude cambia entre
  versiones; al ajustarlas, añadir el texto real como caso en `test/tests.ts`.
- Docs con entradas fechadas: lo nuevo ARRIBA (orden inverso).
- `~/.claude/cch-accounts` y `~/.claude/skills` no se versionan.
- Endpoints/headers OAuth y de rate-limit (constants.ts) se extrajeron del
  binario de claude / verificaron en vivo, pero pueden cambiar con el CLI.
