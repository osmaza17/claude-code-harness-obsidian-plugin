# README técnico — Cambio automático de cuenta de Claude Code

Manual exhaustivo del sistema de **multi-cuenta** del plugin: guardar varias
cuentas de Claude Code, cambiar entre ellas **sin reiniciar ni perder la
conversación**, y rotar automáticamente para repartir el gasto de tokens.

Está escrito para poder **replicar esta funcionalidad en otro harness** desde
cero. Todo el código vive en `main.ts`.

> Ámbito: Windows + Claude Code CLI por suscripción (login OAuth). En esta
> máquina las credenciales se guardan en **fichero plano** (no en el Credential
> Manager de Windows); este sistema depende de eso (ver "Limitaciones").

---

## 0. Prerrequisitos (para replicar esto en un PC nuevo)

Antes de nada, además de los requisitos generales del plugin (ver `README.md`:
Obsidian de escritorio, Node.js del sistema, CLI `claude` en el `PATH`, prebuild
de `node-pty` para tu SO), el sistema **multi-cuenta descrito aquí** necesita:

1. **Credenciales en fichero plano.** El hot-swap consiste literalmente en
   sobrescribir `~/.claude/.credentials.json`. Esto **solo funciona si Claude Code
   guarda ahí el token** (caso verificado en Windows). Si en tu máquina las
   credenciales viven en un **keychain / Credential Manager** del SO (posible en
   **macOS**, no verificado por mí), este sistema **no aplicará** y habría que
   adaptarlo al almacén nativo. Compruébalo mirando si `~/.claude/.credentials.json`
   contiene `claudeAiOauth.accessToken` en texto.
2. **Al menos una cuenta logueada** (`claude` → `/login`) para que existan esos
   ficheros; las demás cuentas se **auto-guardan** en `~/.claude/cch-accounts/` a
   medida que haces `/login` con cada una (auto-guardado con throttle).
3. **`~/.claude/cch-accounts/` NO se versiona** (contiene tokens); en un PC nuevo
   nace vacía y se repuebla logueándote con cada cuenta una vez.
4. **Salida a internet** hacia `api.anthropic.com` (sondeo de uso por API) y
   `platform.claude.com` (refresco de tokens / keep-alive). Sin ellas, el uso en
   vivo y el keep-alive no funcionan; el hot-swap básico (solo escribir el fichero)
   sí, pero sin datos de uso el auto-switch cae a round-robin.

Todo el código vive en `main.ts`; los endpoints/`client_id`/nombres de header son
best-effort y pueden cambiar entre versiones del CLI (ver Caveats).

---

## 1. Cómo almacena la autenticación Claude Code

Dos ficheros en el HOME del usuario:

### `~/.claude/.credentials.json`
El token de la CLI. Forma:
```jsonc
{
  "claudeAiOauth": {
    "accessToken":  "...",      // token de acceso (corta vida; se refresca solo)
    "refreshToken": "...",      // token de refresco (larga vida)
    "expiresAt":    1750000000, // epoch ms de caducidad del accessToken
    "scopes":       ["user:inference", "user:profile", ...],
    "subscriptionType": "...",
    "rateLimitTier": "..."
  }
}
```
Este es el fichero **operativo**: lo que autoriza las peticiones a la API.

### `~/.claude.json`
Fichero grande (cientos de KB) con estado variado de Claude. Nos interesa una
clave:
```jsonc
{
  "oauthAccount": {
    "emailAddress": "cuenta@gmail.com",  // <- la cuenta activa
    "accountUuid": "...",
    "organizationUuid": "...",
    "displayName": "...",
    ...
  },
  ... (mucho más estado que Claude escribe con frecuencia)
}
```
`oauthAccount.emailAddress` es **metadato** (qué cuenta se muestra en la UI). No
autoriza por sí mismo, pero lo usamos para saber qué cuenta está activa.

---

## 2. El insight clave (por qué funciona el hot-swap)

**Un proceso `claude` ya en ejecución re-lee `~/.claude/.credentials.json` y usa
la cuenta de ese fichero en su SIGUIENTE petición.** No cachea el token de por
vida. Comprobado empíricamente: si inicias sesión con otra cuenta en una
instancia, las instancias YA abiertas pasan a usar la cuenta nueva en su próximo
mensaje, sin reiniciarse.

Consecuencia: **para cambiar de cuenta basta con sobrescribir el fichero de
credenciales.** No hace falta:
- reiniciar el proceso,
- hacer `/login` de nuevo,
- abrir el navegador ni pegar ningún código,
- una instancia/terminal paralela.

Y como no se reinicia, **la conversación en curso no se pierde** y la respuesta
que se esté generando no se corta (la cuenta nueva solo aplica a la próxima
petición).

> Se barajaron dos alternativas peores: (a) reiniciar con `claude --continue`
> (recarga el transcript pero parpadea y corta el turno en curso); (b) una
> instancia paralela que hiciera `/login` (innecesaria y con el problema de
> capturar el código del navegador). El hot-swap de fichero es superior.

---

## 3. Guardado de cuentas

### Formato del snapshot
Cada cuenta se guarda en `~/.claude/cch-accounts/<email>.json`
(nombre saneado: `email.replace(/[^a-zA-Z0-9._@-]/g, "_") + ".json"`):
```jsonc
{
  "email": "cuenta@gmail.com",
  "savedAt": 1750000000000,
  "credentials": { /* copia íntegra de .credentials.json */ },
  "oauthAccount": { /* copia de .claude.json -> oauthAccount */ }
}
```
La carpeta `cch-accounts` está en `~/.claude` (mismo nivel de confianza que el
fichero original) y **nunca se versiona en git** (contiene tokens).

### `saveCurrentAccount(notify)`
Lee `.credentials.json` y el `oauthAccount` de `.claude.json`, y escribe el
snapshot (atómico). Devuelve el email o `null`.

### Auto-guardado — `maybeAutoSaveAccount()`
Enganchado al flujo de salida del PTY (caso `data`), con **throttle ~10 s**.
Compara `currentAccountEmail()` con `lastAutoSavedEmail`; si cambió (p. ej. tras
un `/login`), snapshotea sola la cuenta nueva. Así, **cada cuenta en la que
inicias sesión queda guardada sin pulsar nada** (avisa la primera vez que guarda
una cuenta nueva). Es la forma de poblar las 6 cuentas: simplemente ve haciendo
`/login` con cada una una vez.

### `currentAccountEmail()`
Lee `~/.claude.json` → `oauthAccount.emailAddress` (trim + lowercase). Fuente de
verdad de "qué cuenta está activa".

---

## 4. El cambio de cuenta — `switchToAccount(email)`

Pipeline (sin reinicio):
1. Localiza `cch-accounts/<email>.json`; si no existe, avisa y aborta.
2. **Valida** que `saved.credentials.claudeAiOauth.accessToken` existe (no
   escribir credenciales corruptas).
3. **Snapshot de la cuenta saliente** (`saveCurrentAccount(false)`) para
   conservar su token recién refrescado (mitiga la rotación de refresh tokens).
4. **Escribe** `saved.credentials` en `~/.claude/.credentials.json` (atómico).
5. **Re-lee** `~/.claude.json`, sustituye `oauthAccount` por el guardado y lo
   **escribe** (atómico). El re-leer justo antes minimiza pisar cambios que
   Claude escriba en ese fichero.
6. Resetea estado interno (`lastAutoSavedEmail`, `rotateBaselinePct`).
7. Notifica. **No reinicia.** La sesión usa la cuenta nueva en su próximo mensaje.

### Escritura atómica — `writeJsonAtomic(file, obj)`
Escribe a `file + ".cch-tmp-<ts>"` y hace `fs.renameSync(tmp, file)`. El rename
es atómico dentro del mismo volumen, así que un lector concurrente (la `claude`
viva leyendo credenciales por petición) **nunca ve un fichero a medio escribir**.

---

## 5. Procesador de status — `maybeAutoSwitch(chunk)`

Enganchado al flujo `data`, **corre siempre** (no solo con `autoSwitch`), sobre un
buffer rodante (~3000 chars) limpiado de ANSI
(`buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")`). Hace cuatro cosas:

**(a) Rastrear la cuenta de la barra.** Claude muestra el email en la barra de
estado. Se extrae el último email del buffer que esté en `knownAccountEmails()`
(cuentas guardadas ∪ activa) — el filtro evita confundir un email escrito en una
nota con la cuenta real. Es la **verdad** de qué cuenta está activa de verdad.
- Si cambia → actualiza la **etiqueta del botón 👤 en vivo**.

**(b) Verificar el swap.** `switchToAccount` arma `pendingVerifyEmail` (+ deadline
~45 s). Cuando el email de la barra == el objetivo → Notice "✓ Active account: X"
(swap confirmado). Si vence el plazo y la barra sigue en otra cuenta habiendo
habido actividad → avisa "envía un mensaje para aplicarlo". Cierra el bucle de
"escribí credenciales pero ¿se aplicó?".

**(c) Auto-recuperación por auth-fail.** Durante `authWatchUntil` (~60 s tras un
swap), si la salida matchea `AUTH_FAIL_RE` (token guardado muerto), avisa y —en
modo auto— salta a la siguiente cuenta (tope `recoverAttempts` = nº de cuentas,
reset al confirmar un swap).

**(d) Decidir el cambio** (solo si `settings.autoSwitch` y fuera de cooldown):

Obtiene el **% de uso de 5 h** de la cuenta activa: **primero por scraping** de la
barra con una regex **configurable** (`settings.autoSwitchUsageRegex`, default
`DEFAULT_USAGE_RE = "5h:[^\\n]{0,40}?(\\d{1,3})\\s*%"`, compilada con fallback
seguro) y, si no se puede raspar, **fallback a la API** (`usagePct()` — fuente
autoritativa, ver §5b), de modo que el cambio automático sigue funcionando aunque
algún día se oculte la barra:
```
5h:[▓▓▓░░] 23% (3 31m)   →   captura  23
```
- **Disparador de respaldo**: si la salida matchea `LIMIT_RE` (mensaje explícito de
  "límite alcanzado"), cambia aunque no se haya leído el %.
- **Anclaje**: si el email de la barra es conocido y **≠ `currentAccountEmail()`**,
  *no actúa* — la barra aún no refleja el último swap, así que el % pertenece a la
  cuenta vieja. Esto elimina cambios espurios justo tras cambiar.

Tras un cambio hay un **cooldown de 10 s** (`autoSwitchCooldownUntil`) que ignora
lecturas para que la barra se asiente en la cuenta nueva antes de volver a actuar.

**Diagnóstico — `diagnoseAutoSwitch()` (comando "Diagnose auto-switch").** La
decisión se calcula en un closure `decide()` que devuelve el **motivo en lenguaje
claro** de por qué (no) se cambió y ejecuta el swap como efecto secundario cuando
toca. Ese motivo, junto con `pct`/fuente, baseline o threshold, cuenta activa vs.
barra y nº de cuentas, se guarda en `lastDiagInfo` **en cada chunk** (también con
`autoSwitch` off → "auto-switch is OFF"). El comando muestra ese último snapshot en
un `Notice`; sin él, la pista solo estaba en la consola de DevTools. Casos típicos:
`no usage % available yet` (ni scrape ni API fresca), `in cooldown`, `at X%; need
Y% to rotate`, `at X%; threshold is Y%`.

> `LIMIT_RE` y `AUTH_FAIL_RE` son **best-effort**: el texto exacto que imprime
> Claude puede variar entre versiones; ajústalos si la detección falla.

Dos modos (`settings.autoSwitchMode`):

### Modo "threshold" (umbral fijo)
Cambia cuando `pct >= settings.autoSwitchThreshold` (def. 90).

### Modo "rotate" (rotación por incremento)
Reparte el gasto: cambia cada vez que el consumo sube `settings.autoSwitchDelta`
puntos (def. 10) desde que la cuenta se volvió activa.
- `rotateBaselinePct === null` → fija baseline = `pct` (primer reading tras la
  activación/cooldown).
- `pct < baseline` → baja el baseline a `pct` (low-water mark: si la ventana de
  5 h se resetea y el % baja, re-basa limpio).
- `pct >= baseline + delta` → **rota** a la siguiente cuenta.

Ejemplo: cuenta A entra al 20 %, delta 10 → al llegar a 30 % rota a B; B entra
(p. ej.) al 5 % → rota a C al llegar a 15 %; y así sucesivamente, repartiendo.

### Fuente del % — scraping primero, API de respaldo
El % de la cuenta activa se toma **primero del scraping** de la barra (funciona sin
acceso a la API) y, si no se puede raspar, se hace **fallback a la API**
(`usagePct()`, ver §5b). Así el cambio automático sigue vivo aunque algún día se
oculte la barra. El **anclaje por email de la barra solo aplica al valor
scrapeado** (la barra puede ir desfasada tras un swap); la API ya está atada al
token de la cuenta, así que no necesita anclaje y por eso es buen respaldo cuando
el scraping queda *anchored-out*.

### Selección de destino — `pickNextAccount()` = **menos gastada**
Entre las cuentas guardadas ≠ actual y **sin token muerto** (`error:"auth"`),
elige la de **menor % 5h sondeado fresco**. Si ninguna tiene dato fresco →
**fallback al round-robin** por email (con wrap), saltando igualmente las de token
muerto. `null` si hay <2 cuentas.

**Techo semanal del destino (`WEEKLY_CEILING_PCT` = 95 %)**: además, ni la ruta
menos-gastada ni el round-robin eligen una cuenta cuyo **7d (semanal) fresco sea
≥95 %** (`weeklyMaxedOut(email)`, fail-open si no hay dato), para no aterrizar en
una cuenta a punto de agotar su límite semanal. Mismo filtro en `leastUsedBelow()`.
Si **todos** los destinos están ≥95 % semanal, no hay candidato y el plugin se
queda en la cuenta actual (no salta a una semanalmente agotada).

### Al rotar (ambos modos)
`cooldown = now + 10 s`, `rotateBaselinePct = null` (la nueva cuenta recapturará
su baseline tras el cooldown), `autoSwitchBuf = ""`, Notice, `switchToAccount()`.

---

## 5b. Uso real por API — `refreshUsage` / `probeUsage`

En vez de **inferir** el % pintando la barra, se lee el dato **autoritativo** del
servidor. Verificado en vivo: el OAuth token que Claude Code guarda autentica una
llamada a la API de mensajes, y la respuesta trae la utilización de rate-limit en
las cabeceras.

### La llamada (`probeUsage(token)`)
`POST https://api.anthropic.com/v1/messages` con `https` de Node (expone TODOS los
headers; `requestUrl` de Obsidian podría filtrarlos), cuerpo mínimo
`{model, max_tokens:1, messages:[{role:"user",content:"hi"}]}`:
- `model`: `USAGE_PROBE_MODEL` = `claude-haiku-4-5-20251001` (id completo
  disponible para la suscripción; `settings.usageProbeModel` lo sobrescribe).
- Headers: `authorization: Bearer <accessToken>`, `anthropic-version: 2023-06-01`,
  `anthropic-beta: oauth-2025-04-20`, `content-type: application/json`.

Respuesta (HTTP 200) → cabeceras parseadas:
- `anthropic-ratelimit-unified-5h-utilization` (**fracción 0–1** → ×100),
  `…-5h-reset` (epoch s), `…-7d-utilization`, `…-5h-status`.
- `401` → `error:"auth"` (token guardado muerto). `429` → `error:"rate"`. Red →
  `error:"net"`. (timeout 15 s.)

### Token por cuenta — `accessTokenFor(email)`
Activa: `claudeAiOauth.accessToken` en la raíz de `.credentials.json`. Guardada:
`credentials.claudeAiOauth.accessToken` del snapshot `cch-accounts/<email>.json`.
→ Permite **sondear cada cuenta sin cambiarse a ella**.

### Caché y programación — `refreshUsage({activeOnly?, refreshTokens?})`
Recorre cuentas secuencialmente (~300 ms de desfase; guard `usageProbing` evita
solapes) y guarda `AccountUsage` en `accountUsage: Map<email,…>`. Con
`refreshTokens` refresca el token OAuth de cada cuenta **antes** de sondear (ver
§5c). Disparos:
- **Arranque** (~5 s) y **al activar el auto-switch**:
  `refreshUsage({refreshTokens:true})` sobre todas (revive + calienta).
- **Al abrir el menú 👤**: todas (background; el menú es síncrono → pinta lo
  cacheado, el siguiente abrir sale fresco; ítem "Refresh usage").
- **Cada 3 min** (`registerInterval`): `refreshUsage({refreshTokens:true})` sobre
  **todas** las cuentas. Mantiene los tokens vivos y los datos de las dormidas
  frescos (3 min < `USAGE_FRESH_MS` = 6 min), de modo que `pickNextAccount` elige
  la **menos gastada real** en vez de caer a round-robin.
- **Tras actividad** (`maybeProbeOnActivity`, debounce 60 s): solo la **activa**.

`usagePct(email)` = % 5h fresco (`< USAGE_FRESH_MS` = 6 min) o null. `usageLabel`
da el texto plano para ajustes (`5h NN% (Hh Mm) · 7d NN%`, `expired`,
`rate-limited`); `accountMenuTitle` da el render alineado + coloreado para el menú.

### Caveats (best-effort)
- Nombres de header, valor `oauth-2025-04-20` e id de modelo **pueden cambiar**.
- El **factor fracción→%** (×100) se **infiere** de `…-fallback-percentage: 0.5`;
  contrastar una vez con la barra. `toPct` aplica `v<=1 ? v*100 : v` por seguridad.
- El probe **consume** un pelín y cuenta mínimamente → Haiku, secuencial, sin
  ráfagas (encadenar modelos caros dio `429` en pruebas).
- **`401` = access token caducado**, NO necesariamente "necesita login": los access
  tokens viven horas y `claude` los refresca **perezosamente** antes de su siguiente
  petición; el probe usa el guardado tal cual. Por eso se etiqueta **`expired`** (no
  "needs /login"). En la **cuenta activa** un `401` suele ser **falso** (se arregla
  al mandar un mensaje → refresh → siguiente probe OK). En el menú/auto-switch un
  `401` se trata como `error:"auth"` y la cuenta se salta como destino. **El
  keep-alive (§5c) refresca el token antes de sondear**, así que en régimen normal
  las cuentas inactivas dejan de aparecer `expired`; solo es login real si el
  **refresh token** también está muerto (entonces el refresh devuelve no-200 y la
  cuenta sigue `expired`).
- **Render del menú** (`accountMenuTitle`): `DocumentFragment` con spans monospace
  `white-space:pre`, columnas alineadas por padding y % coloreados por nivel
  (`usageColor`: verde <50 → amarillo → naranja → rojo ≥90).

---

## 5c. Keep-alive de tokens — `refreshAccount` / `oauthRefresh`

**Problema.** El access token vive horas. La cuenta **activa** la refresca `claude`
solo (perezosamente, en su siguiente petición), pero las **inactivas** no las toca
nadie → su token caduca → el probe da `401` → se etiquetan `expired` y
`pickNextAccount` **las descarta como destino**. Con varias cuentas, el auto-switch
se quedaba sin destinos válidos.

**Solución.** Replicar el refresco que hace `claude` por dentro: pedir un token
nuevo con el **refresh token**.

```
POST https://platform.claude.com/v1/oauth/token        (OAUTH_TOKEN_URL)
content-type: application/json
{ "grant_type": "refresh_token",
  "refresh_token": "<el guardado>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }  (OAUTH_CLIENT_ID)
→ 200 { access_token, refresh_token (NUEVO), expires_in, token_type }
```

> Endpoint, `client_id` y forma del cuerpo/respuesta se **verificaron extrayendo las
> cadenas del binario `claude.exe`** (no son adivinados). Pueden cambiar con futuras
> versiones del CLI → best-effort.

**`refreshAccount(email)`**: lee el `refreshToken` (raíz de `.credentials.json` si es
la activa; `credentials.claudeAiOauth` del snapshot si no), llama a `oauthRefresh`,
y **fusiona** los tokens nuevos en el objeto guardado conservando los demás campos
(`scopes`, `subscriptionType`…) y la unidad de `expiresAt` (ms). `oauthRefresh`
resuelve a `null` en cualquier no-200/red/parse (nunca lanza).

**Throttle por caducidad** (`REFRESH_SKEW_MS` = 30 min): cada tick de 3 min
**revisa** todas las cuentas pero solo refresca las **caducadas o a punto de
caducar**. Motivo: el endpoint de tokens **limita por tasa con dureza** (verificado:
`POST` con refresh token falso → **HTTP 429** `rate_limit_error`), así que refrescar
las 6 cada 3 min lo machacaría. El throttle deja el ritmo en ~1 refresco por vida de
token y cuenta (como `claude`).

**Seguridad — rotación del refresh token.** Cada éxito devuelve un refresh token
**nuevo** e **invalida el viejo**; perderlo bloquea la cuenta (`/login`). Por eso:
1. Solo se escribe el fichero en **HTTP 200**. Cualquier error → credenciales
   intactas (el refresh token viejo sigue válido).
2. Escritura **atómica** (`writeJsonAtomic`, temp+rename) → la `claude` viva nunca
   lee un fichero a medias.
3. **Riesgo residual** en la cuenta **activa**: el plugin y `claude` podrían
   refrescar a la vez por el mismo refresh token (uno se queda con el viejo
   invalidado). Ventana pequeña y rara (el throttle hace que solo coincidan cerca de
   la caducidad); `claude` re-lee `.credentials.json` por petición, así que en el
   caso normal adopta el token que escribió el plugin. Para riesgo cero se podría
   excluir la activa del refresco (la mantiene `claude`), a coste de que si no usas
   `claude` un buen rato su token caduque.

---

## 6. Navegador por cuenta (relacionado)

Para el control remoto, la URL de la sesión solo funciona en el navegador donde
está logueada esa misma cuenta. `openInBrowser(url)` usa `currentAccountEmail()`
para elegir el navegador del mapa `settings.browserMap` (email → Chrome / Firefox
/ Edge / Brave / Opera / Opera GX / ruta custom), con `defaultBrowser` de
respaldo. No es parte del swap, pero comparte `currentAccountEmail()`.

---

## 7. Robustez y limitaciones (LEER antes de replicar)

- **Escritura atómica obligatoria**: sin temp+rename, un lector concurrente puede
  leer un JSON truncado → fallo de auth. Siempre `writeJsonAtomic`.
- **Clobber de `~/.claude.json`**: Claude escribe ese fichero a menudo; nuestro
  read-modify-write podría pisar un cambio suyo hecho en la misma microventana.
  Se mitiga releyendo justo antes de escribir, pero el riesgo residual existe. Si
  no se quisiera tocar `.claude.json`, habría que llevar la "cuenta activa" en
  estado propio del plugin (pero entonces se pierde la detección de `/login`
  externos para el auto-guardado).
- **Token guardado obsoleto**: si el refresh token de una cuenta rota mientras la
  cuenta no era la activa, su snapshot caduca → al cambiar a ella, Claude pedirá
  `/login`. Mitigado guardando la cuenta saliente justo antes de cambiar y con el
  auto-guardado, pero no es infalible.
- **Dependencia del status bar**: el auto-switch necesita que la barra muestre
  `5h: …%`. Si el formato cambia o se oculta, hay que ajustar la regex.
- **Cuenta destino también agotada**: en cualquier modo, si la siguiente cuenta
  ya está alta, rotará otra vez tras el cooldown (~10 s/salto) hasta dar con una
  con presupuesto.
- **Idempotencia/loops**: el cooldown de 10 s evita que una sola lectura alta
  dispare cambios en cadena.

---

## 8. Cómo replicarlo en un harness nuevo (resumen accionable)

1. **Localiza** `~/.claude/.credentials.json` y `~/.claude.json` (HOME del
   usuario). Confirma que las credenciales están en fichero (no en keychain).
2. **Guarda cuentas**: helper `saveCurrentAccount()` que copie ambos a
   `~/.claude/cch-accounts/<email>.json`. Llámalo automáticamente cuando detectes
   que `oauthAccount.emailAddress` cambió (auto-guardado con throttle).
3. **Cambia** con `switchToAccount(email)`: valida → snapshot saliente → escribe
   credentials (atómico) → actualiza `oauthAccount` en `.claude.json` (atómico).
   **No reinicies**; la sesión viva adoptará la cuenta en su próxima petición.
4. **Auto-switch** (opcional): scrapea el `5h: …%` del PTY; modo umbral o modo
   rotación-por-delta con baseline + low-water + cooldown; rota con
   `pickNextAccount()`.
5. **Usa siempre escritura atómica** y respeta las limitaciones de la sección 7.

El orden de operaciones en el swap importa: snapshot saliente **antes** de
sobrescribir, y escribir credentials **antes** que `.claude.json` (la cuenta es
operativa por las credenciales; el `oauthAccount` es bookkeeping).
