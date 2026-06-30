# Claude Code Harness

Plugin de Obsidian (solo escritorio) que abre la **TUI real de Claude Code**
dentro de un panel lateral de Obsidian. La terminal ejecuta `claude` con el
directorio de trabajo apuntando a la raíz de tu vault, así que Claude Code opera
directamente sobre tus notas, con la estética del tema activo de Obsidian.

No es un emulador ni un embed de otra app: lanza el binario `claude` real en un
pseudo-terminal y lo pinta con [xterm.js](https://xtermjs.org/).

## Características

- **Terminal real de Claude Code** en un panel lateral, con `cwd` = tu vault.
- **Varias instancias en paralelo**: una **barra de pestañas** en la cabecera; el
  botón **+** abre una nueva instancia de `claude` (con su propia skill, elegible
  desde el menú del +) corriendo a la vez sobre el mismo vault. Cambia de pestaña
  para ver cada una; solo se muestra una, el resto siguen trabajando en segundo
  plano. Cada pestaña es un proceso `claude` independiente con su propia
  conversación; cerrar una pestaña (×) **mata** esa instancia. (Cuenta, uso y
  auto-switch son **globales** —comparten credenciales—, así que cambiar de cuenta
  afecta a todas las instancias.)
- **Reabrir pestaña cerrada (`Ctrl+Shift+Y`)**: como el `Ctrl+Shift+T` del
  navegador, si cierras una pestaña sin querer, **`Ctrl+Shift+Y`** (o el comando
  "Reopen closed Claude session") la reabre y **recupera su conversación**. (Se usa
  `Y` porque Obsidian ya reserva `Ctrl+Shift+T` para reabrir pestañas de notas.)
  El plugin etiqueta cada
  sesión con un id propio (`claude --session-id`) y al reabrir hace
  `claude --resume <id>`, así que continúas la misma conversación, no una nueva.
  Funciona en orden inverso al cierre (las últimas 25). **Persiste entre sesiones
  de Obsidian**: la pila se guarda en disco, así que al día siguiente —incluso tras
  apagar el PC— `Ctrl+Shift+Y` sigue recuperando tanto las pestañas que cerraste
  con la × como las que **dejaste abiertas** al cerrar Obsidian (de la más reciente
  a la más antigua). La recuperación es **bajo demanda** (una pestaña por pulsación),
  no una restauración automática al arrancar.
- **Estado de cada pestaña de un vistazo**: cada pestaña lleva un **punto** y, del
  mismo color, **su reborde**, para ver sin abrirla si Claude está **trabajando**
  (amarillo), **terminado/inactivo** (verde), **esperando tu respuesta** (rojo:
  te ha hecho un prompt de permiso, una aprobación de plan o un cuestionario y está
  bloqueado hasta que contestes) o **detenido por alcanzar el límite de uso/tokens**
  (también rojo; se distinguen por el tooltip al pasar el ratón), y **salido** (gris).
  El rojo de "esperando respuesta" se apaga al responder (escribir) o cuando Claude
  reanuda; el del límite se limpia al volver a escribir o al reiniciar la sesión.
  (Tanto la detección de "esperando respuesta" como la del límite son best-effort:
  dependen del texto que imprime Claude, que puede cambiar.)
- **Tema dinámico**: fondo, texto, cursor y paleta ANSI se ajustan al tema de
  Obsidian (claro/oscuro) y se reaplican al cambiarlo.
- **Sesiones persistentes**: arrancan al abrir Obsidian aunque no abras el panel,
  y no se cierran al cerrar el panel — siguen vivas hasta que cierras su pestaña,
  cierras Obsidian o desactivas el plugin.
- **Comandos de inicio + skill** configurables: comandos slash que se ejecutan
  al arrancar (vacío por defecto) y una skill que se invoca después. Se envían se
  abra o no el panel.
- **Selector de skills**: lista las skills de Claude Code en `~/.claude/skills`
  (cada subcarpeta con un `SKILL.md`) y la invoca como `/<nombre>`. Cámbiala desde
  un botón (icono ✨) en la cabecera **para la pestaña activa**; por defecto
  `second-brain-assistant` (también es la skill por defecto de las pestañas
  nuevas). El mismo menú tiene una opción **"Open skills folder"** que abre
  `~/.claude/skills` y maximiza esa ventana del explorador.
- **Selector de modelo** en la cabecera (Haiku 4.5 / Sonnet 4.6 / Opus 4.8) **de
  la pestaña activa**: ejecuta `/model <id>` y auto-confirma el diálogo "Switch
  model?".
- **Enviar notas a Claude**: botón `@` (nota activa), entrada **"Send to Claude"**
  en el menú contextual del explorador (una o varias notas/carpetas), y
  **arrastrar y soltar** notas o imágenes sobre el terminal — todo inserta su
  `@<ruta>`.
- **Autocompletado `[[` → referencia `@`**: al escribir `[[` en el input de Claude
  aparece un **desplegable** anclado al cursor (estilo Obsidian) con las notas más
  parecidas, usando el **suggester nativo de Obsidian** (mismas sugerencias y orden
  que el `[[` del editor; **ignorando acentos**). Flechas para moverte, Enter/Tab/clic
  para elegir, Escape para cancelar; al elegir, lo tecleado se sustituye por la
  referencia `@<ruta>` de Claude Code. Se puede desactivar en ajustes
  ("[[ note suggester").
- **Referencias a notas clicables**: las menciones a notas en la salida de Claude
  (el texto **coloreado** que coincide con el nombre de una nota `.md` del vault, y
  los `[[wikilinks]]`) se vuelven **enlaces**: pasa el ratón para subrayarlas y haz
  **clic** para abrir la nota (Ctrl/Cmd+clic = pestaña nueva). Funciona incluso si
  el nombre queda **partido en varias líneas** (Claude lo corta a lo ancho, a veces
  a mitad de palabra). Se puede desactivar en ajustes ("Clickable note links").
- **Remote control (toggle)**: botón (icono 📱) o **`Ctrl+R`** que activa/desactiva
  `/remote-control`. Al activarlo se pone verde, copia al portapapeles el enlace
  de la sesión (`https://claude.ai/code/…`) y lo abre para entrar directo a la
  sesión remota; al desactivarlo, desconecta la sesión.
- **Navegador por cuenta**: como el enlace remoto solo funciona en el navegador
  donde está logueada la misma cuenta de Claude, cada cuenta elige su navegador
  (Chrome / Firefox / Edge / Brave / Opera / Opera GX / ruta personalizada)
  **desde su propia tarjeta** en ajustes (ver "Ajustes consolidados por cuenta").
  La cuenta activa se lee de `~/.claude.json`; las que dejan "Use default" usan el
  navegador por defecto global.
- **Cambio de cuenta (sin interrupción)**: las cuentas se **guardan solas** al
  iniciar sesión con ellas, y te cambias entre varias desde el botón de cuenta de
  la cabecera (icono 👤) o la sección "Claude accounts" de ajustes. Hace un
  **hot-swap** de `~/.claude/.credentials.json` **sin reiniciar**: la sesión sigue
  corriendo y usa la cuenta nueva en su siguiente mensaje. Útil cuando se agota el
  límite de 5 h de una cuenta y quieres saltar a otra. (Los snapshots se guardan en
  `~/.claude/cch-accounts`, fuera de git.)
- **Uso real por cuenta (API)**: lee el % autoritativo de consumo de 5 h/7 d desde
  las cabeceras de rate-limit de la API de Anthropic (con el token de cada cuenta),
  y **sondea todas las cuentas sin cambiarte a ellas**. El **menú del botón 👤**
  muestra el % de cada cuenta **alineado en columnas y con color** según el nivel
  de uso (verde = menos usada → rojo = cerca del límite), con la cuenta atrás del
  reset y el % semanal; `expired` si su access token caducó. Además, las cuentas a
  las que el **auto-switch no puede saltar** por las restricciones (5 h ≥90 %,
  7 d ≥95 % o token caducado) se resaltan en **rojo** en el menú 👤, como si
  estuvieran desactivadas (pero el cambio **manual** a ellas sigue funcionando).
  Hace llamadas mínimas (modelo Haiku); se puede desactivar en ajustes
  ("Live usage (API)").
- **Keep-alive de cuentas**: cada 3 min el plugin **refresca el token OAuth** de las
  cuentas cuyo token esté por caducar (el mismo flujo que usa Claude Code por
  dentro), para que las cuentas que no estás usando no se queden `expired` ni se
  excluyan del auto-switch. Solo refresca cuando hace falta (no machaca el servidor)
  y guarda el token rotado de forma atómica.
- **Auto-switch** (opcional, desactivado por defecto): cambia de cuenta solo según
  el % de uso de 5 h (leído de la barra de estado, con la API como respaldo si la
  barra no es legible), en dos modos:
  **umbral** (cambia al llegar a un % fijo, 90 % por defecto) o **rotación por
  incremento** (cambia cada vez que el consumo sube un valor fijo —p. ej. +10 %—
  desde que entró la cuenta, repartiendo el gasto entre todas). Al cambiar, salta a
  la **cuenta menos gastada** (según el % real sondeado por API; fallback a
  rotación por orden), pero **nunca a una cuenta cuyo gasto semanal (7 d) ya esté al
  95 % o más**, para no aterrizar en una cuenta a punto de agotar su límite semanal
  en mitad de una respuesta (si todas las demás están al ≥95 % semanal, se queda en
  la actual). El cambio es sin reinicio, así que no interrumpe lo que esté
  en curso. Se puede activar/desactivar y elegir el modo y el porcentaje **desde un
  botón de la cabecera** (icono 🔁; verde cuando está activo) o desde ajustes. Si
  alguna vez no cambia y no sabes por qué, el comando **"Diagnose auto-switch"**
  muestra en un aviso el motivo de la última evaluación (p. ej. "in cooldown", "no
  usage % available yet", "at 72%; threshold is 90%").
  Detalle técnico completo en [`README_TECNICO.md`](README_TECNICO.md).
- **Activar/desactivar cuentas**: el **menú del botón 👤** muestra **una sola
  lista** de cuentas: cada fila tiene a la **izquierda un toggle** (verde =
  habilitada; gris = deshabilitada) y, a la derecha, el **nombre de la cuenta** (con
  su % de uso) y, a la **derecha del todo, un botón 🔓 (icono `log-in`)** que abre
  `claude.ai` en el **navegador donde está iniciada la sesión de esa cuenta** (el
  que mapeaste en ajustes; si no tiene mapeo, el navegador por defecto). Sirve para
  **volver a iniciar sesión** rápido cuando una cuenta caduca, sin tener que
  acordarte de qué navegador usa cada una. Pulsa el toggle para habilitar/
  deshabilitar (puedes conmutar varias
  sin que se cierre el menú) y **haz clic en el nombre para cambiarte a esa cuenta**.
  Una cuenta **deshabilitada queda sombreada y totalmente inutilizable desde este
  menú**: el auto-switch nunca la elige y, además, clicar su nombre **no** te cambia
  a ella (hay que reactivar el toggle primero). Útil para cuentas de amigos, para no
  gastar sus tokens sin querer. También puedes deshabilitarlas en ajustes ("Claude
  accounts", botón 🔁/🚫 por cuenta); ahí el bloqueo solo afecta al cambio
  automático.
- **Ajustes consolidados por cuenta**: en ajustes, toda la configuración de una
  cuenta (correo + uso, si el auto-switch puede usarla, su navegador y sus franjas
  horarias prohibidas) vive **junta en una sola tarjeta** bajo "Per-account
  settings", en vez de repartida por la página. Los ajustes globales de cuentas
  (auto-switch, uso en vivo, "Default browser") quedan agrupados encima.
- **Bloqueo por franjas horarias**: en la tarjeta de cada cuenta puedes definir
  **ventanas horarias prohibidas** (`HH:MM–HH:MM` + días de la semana;
  admite franjas que cruzan medianoche, p. ej. 23:00–07:00). Mientras "ahora" cae
  dentro de una franja, esa cuenta se marca en **rojo** en el menú 👤 (aunque el
  cambio **manual** a ella sigue permitido) y el **auto-switch nunca salta a ella**.
  Si la cuenta que estás usando **entra** en su franja prohibida, el plugin **salta
  automáticamente** a otra cuenta disponible. Y si **no queda ninguna** cuenta a la
  que saltar, **detiene Claude** (corta la generación, como si se acabase el uso) y
  te avisa, hasta que la franja termine o haya una cuenta libre. (No bloquea el
  teclado: corta la generación, no la escritura.)
- **Token Dashboard**: botón en la cabecera (icono 📊) que abre un **panel local
  de consumo de tokens** en el navegador (`http://127.0.0.1:8080`). Arranca un
  pequeño servidor Python (incluido en `token-dashboard/`, solo stdlib) que escanea
  tus sesiones de `~/.claude/projects` y muestra totales, prompts más caras,
  sesiones, proyectos, skills y consejos. La primera vez tarda ~1 min escaneando;
  luego el botón reusa el servidor ya arrancado. Requiere **Python** en el sistema
  (autodetectado; ruta configurable en ajustes). El proceso se cierra al desactivar
  el plugin. (También disponible como comando "Open Token Dashboard".)
- **Aviso al terminar**: notifica (Obsidian Notice) cuando el terminal suena la
  campana, que Claude tiende a sonar al acabar una tarea larga (configurable).
- **Cabecera configurable**: cada botón de la cabecera se puede ocultar desde
  ajustes.
- **Zoom de fuente**: `Ctrl +` / `Ctrl -` / `Ctrl 0`, **`Ctrl + rueda del ratón`** y
  botones en la cabecera.
- **Copiar / pegar**: `Ctrl+C` (con selección) / `Ctrl+Shift+C` copian; `Ctrl+V`
  pega texto o **imagen** (guarda un PNG temporal y pega su ruta);
  `Ctrl+Shift+V` fuerza texto; clic derecho copia/pega.
- **Teclado**: `Ctrl+Enter` / `Shift+Enter` = nueva línea sin enviar; `Ctrl+R` =
  toggle remote control; `Ctrl+Shift+Y` = reabrir la última pestaña cerrada;
  AltGr+2 = `@` (teclado español); `Ctrl+Z` /
  `Ctrl+Shift+Z` mapeados al borrar-línea / restaurar de Claude.

## Requisitos

- Obsidian de escritorio (Windows / macOS / Linux).
- **Node.js** instalado en el sistema (configurable en ajustes: "Node.js path").
- El binario **`claude`** (Claude Code CLI) accesible en el `PATH`.
- **Python** instalado en el sistema (opcional; solo para el botón **Token
  Dashboard**; configurable en ajustes: "Python path").

## Instalación (manual)

1. Copia esta carpeta en `<tu-vault>/.obsidian/plugins/claude-code-harness/`.
2. Instala dependencias y compila:
   ```bash
   npm install --ignore-scripts
   npm run build
   ```
3. En Obsidian: Ajustes → Complementos de la comunidad → activa
   **Claude Code Harness**.
4. Abre el panel con el icono de terminal de la barra lateral o el comando
   "Open Claude Code panel". Para más instancias en paralelo, usa el botón **+**
   de la barra de pestañas o el comando **"New Claude Code session"**.

## Ajustes

| Ajuste | Descripción |
|---|---|
| Command | Comando a ejecutar (por defecto `claude`). |
| Extra arguments | Argumentos extra (p. ej. `--append-system-prompt "..."`). |
| Startup commands | Comandos slash al iniciar, uno por línea (vacío por defecto). |
| Skill | Skill de `~/.claude/skills` que se invoca como `/<nombre>` tras arrancar (también seleccionable desde la cabecera). |
| Model | Modelo inicial (haiku / sonnet / opus). |
| Notify on bell | Mostrar un aviso cuando el terminal suena la campana (por defecto activado). |
| Claude accounts (global) | Guardar la cuenta activa, uso real por API ("Live usage"), auto-switch al superar un % de uso, y el "Default browser" global. |
| Per-account settings | Una **tarjeta por cuenta** con todo lo suyo junto: correo + uso, **bloquear** (🔁/🚫) para el auto-switch, su **navegador** (Chrome / Firefox / Edge / Brave / Opera / Opera GX / ruta personalizada, o "Use default") y sus **franjas horarias prohibidas**. |
| Other browser mappings | Solo aparece si hay mapeos de navegador para correos que aún **no** son cuentas guardadas (para pre-mapear una cuenta no logueada). |
| Header buttons | Mostrar/ocultar cada botón de la cabecera (enviar nota, cuenta, modelo, skill, remote control, auto-switch, token dashboard, zoom). |
| Node.js path | Ruta a `node.exe` real (autodetectada si se deja vacía). |
| Python path | Ruta a `python.exe` para el botón Token Dashboard (autodetectada si se deja vacía). |

## Cómo funciona (resumen)

node-pty no puede correr en el renderer de Obsidian (necesita `worker_threads`),
y el binario de Obsidian ignora `ELECTRON_RUN_AS_NODE`. Por eso el plugin
**forkea el Node real del sistema** ejecutando `pty-host.js`, que es quien lanza
`claude` en un pseudo-terminal y hace de puente por IPC con el renderer, donde
xterm.js pinta la salida. Detalles de arquitectura en
[`CLAUDE.md`](./CLAUDE.md).

## Desarrollo

```bash
npm run dev     # build con watch
npm run build   # build de producción
```

Tras compilar, recarga el plugin en Obsidian (desactivar/activar) o reinicia.

## Licencia

Uso personal.
