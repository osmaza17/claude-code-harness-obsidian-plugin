# LOG

Registro de cambios del plugin. El historial anterior a esta fecha no quedó
documentado aquí; el LOG arranca en esta entrada.

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
