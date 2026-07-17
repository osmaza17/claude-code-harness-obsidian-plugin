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
  apagar el PC— `Ctrl+Shift+Y` sigue recuperando las pestañas que cerraste con la ×,
  de la más reciente a la más antigua. La recuperación es **bajo demanda** (una
  pestaña por pulsación). Las pestañas **en blanco** (sin ningún mensaje) no se
  archivan al cerrarlas: no hay conversación que recuperar. (Las pestañas que dejas
  **abiertas** al cerrar Obsidian ya no van a esta pila: se **restauran solas** al
  reabrir — ver abajo.)
- **Restaurar la sesión de trabajo al reabrir Obsidian**: las pestañas que tengas
  **abiertas** al cerrar Obsidian se **guardan** y, al volver a abrir Obsidian y el
  panel de Claude Code, **reaparecen automáticamente** las mismas pestañas (en su
  orden, cada una recuperando su conversación con `--resume`), la primera activa. No
  hay que reabrirlas a mano. Solo se restauran las pestañas con conversación real
  (las recién abiertas y en blanco se ignoran — salvo que estén **pineadas**, ver
  abajo). La restauración ocurre al **abrir el
  panel** (no antes), lo que evita cualquier corrupción visual del terminal; nota que
  al abrirlo se lanza un proceso `claude` por pestaña restaurada.
- **Pestañas pineadas (estilo Chrome)**: haz **clic derecho** en una pestaña y elige
  **"Pin tab"** (o usa el comando "Pin/unpin current Claude tab"). La pestaña se
  vuelve **compacta** (solo el punto de estado, ancho fijo, sin ×, siempre a la
  izquierda de la barra, como en Chrome) y queda **fijada**: se restaura **siempre**
  al reabrir Obsidian —aunque otras pestañas se hayan descartado— hasta que la
  cierres tú manualmente (clic derecho → "Close tab", ya que la pineada no muestra
  la ×). Ideal para conversaciones importantes que continúas durante varias sesiones
  de Obsidian. El nombre completo aparece al pasar el ratón (📌 título — estado), y
  el pin sobrevive a reinicios de la conversación y a reabrirla desde el historial.
- **Reiniciar guarda la conversación anterior**: al reiniciar una conversación con
  el botón de la cabecera (icono de flecha circular), la sesión empieza de cero pero
  la conversación anterior **no se pierde**: se archiva en el historial, así que
  puedes recuperarla más tarde desde el historial o con `Ctrl+Shift+Y` (su
  conversación sigue en disco). La pestaña reinicia también su nombre para que la
  conversación nueva estrene el suyo.
- **Recargar la misma sesión** (arreglar bugs visuales sin perder la conversación):
  un botón en la cabecera (icono 🔄 *refresh*, justo a la izquierda del de reiniciar)
  —o el comando "Reload Claude Code session (same conversation)"— **cierra y vuelve a
  abrir la MISMA conversación**: mata `claude` y lo relanza con `claude --resume`
  sobre la misma pestaña recién limpiada. A diferencia de reiniciar, **no** empieza de
  cero: recupera la conversación tal cual (mismo id, mismo nombre de pestaña). Sirve
  para arreglar la TUI **duplicada o entremezclada** que a veces deja una pestaña
  auto-restaurada al reabrir Obsidian: al recargarla, Claude repinta limpio al tamaño
  real del panel.
- **Historial de conversaciones (estilo ChatGPT/Claude web)**: un botón en el
  lado **derecho** de la cabecera (icono 🕘 *history*, justo a la izquierda del de
  recargar; de derecha a izquierda: reiniciar · recargar · historial · ajustes · zoom)
  —o el
  comando "Open Claude session history"— abre un **panel lateral** que se **superpone
  sobre la conversación** (no la comprime), con espacio para leer bien los títulos.
  Lista las conversaciones que has cerrado, la más reciente arriba, con su título y
  cuándo se cerró ("3h ago", "yesterday"). **Haz clic en cualquiera** para reabrirla
  en una **pestaña nueva** recuperando su conversación (no solo la última, como hace
  `Ctrl+Shift+Y`); la **×** de cada fila la quita del historial sin reabrirla. Se
  cierra con su ×, con `Escape` o clicando fuera del panel. Es la misma pila
  persistente que usa `Ctrl+Shift+Y` (las últimas 25, guardadas en disco).
- **Estado de cada pestaña de un vistazo**: cada pestaña lleva un **punto** y, del
  mismo color, **su reborde**, para ver sin abrirla si Claude está **trabajando**
  (amarillo), **terminado/inactivo** (verde), **esperando tu respuesta** (rojo:
  te ha hecho un prompt de permiso, una aprobación de plan o un cuestionario y está
  bloqueado hasta que contestes) o **detenido por alcanzar el límite de uso/tokens**
  (también rojo; se distinguen por el tooltip al pasar el ratón), y **salido** (gris).
  El rojo de "esperando tu respuesta" **parpadea** cuando el cuestionario está en una
  pestaña **que no estás mirando** (te avisa de que vayas a esa pestaña) y se queda en
  **rojo fijo** cuando estás **en** esa pestaña con el cuestionario aún sin responder
  (te recuerda que debes contestarlo para que Claude continúe). Se apaga al responder
  (escribir) o cuando Claude reanuda; el del límite se limpia al volver a escribir o
  al reiniciar la sesión.
  (Tanto la detección de "esperando respuesta" como la del límite son best-effort:
  dependen del texto que imprime Claude, que puede cambiar.)
- **Tema dinámico**: fondo, texto, cursor y paleta ANSI se ajustan al tema de
  Obsidian (claro/oscuro) y se reaplican al cambiarlo.
- **Sesiones persistentes**: una sesión nueva arranca al abrir Obsidian aunque no
  abras el panel; las que tenías abiertas antes se restauran al abrir el panel (ver
  "Restaurar la sesión de trabajo"). No se cierran al cerrar el panel — siguen vivas
  hasta que cierras su pestaña, cierras Obsidian o desactivas el plugin.
- **Comandos de inicio + skill** configurables: al arrancar una sesión nueva se
  envían primero los comandos slash configurados (vacío por defecto) y por último
  la skill. **No** se envía `/model`: la pestaña se queda en el modelo por defecto
  de `claude` y tú lo cambias a mano con el selector de la cabecera cuando quieras
  (por eso la etiqueta de modelo puede no coincidir con el modelo real hasta que
  elijas uno). Se envían se abra o no el panel; las pestañas restauradas con
  `--resume` no reciben nada (su conversación ya lo trae).
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
- **Exportar a nota (botones flotantes, esquina inferior derecha)**: dos botones
  semitransparentes sobre el terminal. El primero guarda el **último mensaje de
  Claude** de la pestaña activa en una **nota nueva en la raíz del vault**; el
  segundo guarda la **conversación entera** (secciones `## Usuario` / `## Claude`).
  Todo automático: crea la nota (`Claude - <pestaña> - último mensaje|conversación
  - fecha.md`), la abre en una pestaña y avisa con un Notice. El contenido sale del
  `.jsonl` de la conversación en disco (no de la pantalla), así que llega completo
  y sin trocear. También hay dos comandos de paleta ("Export last Claude message /
  Claude conversation to a new note") y un toggle en ajustes para ocultar los
  botones ("Export-to-note buttons").
- **Autocompletado `[[` → referencia `@`**: al escribir `[[` en el input de Claude
  aparece un **desplegable** anclado al cursor (estilo Obsidian) con las notas más
  parecidas, usando el **suggester nativo de Obsidian** (mismas sugerencias y orden
  que el `[[` del editor; **ignorando acentos**). Flechas para moverte, Enter/Tab/clic
  para elegir, Escape para cancelar; al elegir, lo tecleado se sustituye por la
  referencia `@<ruta>` de Claude Code. Se puede desactivar en ajustes
  ("[[ note suggester").
- **Referencias a notas y ficheros clicables**: las menciones en la salida de Claude
  (el texto **coloreado** que coincide con el nombre de un fichero del vault, y
  los `[[wikilinks]]`) se vuelven **enlaces**: pasa el ratón para subrayarlas y haz
  **clic** para abrir (Ctrl/Cmd+clic = pestaña nueva). Vale para **cualquier tipo de
  fichero**: notas, PDFs e imágenes se abren dentro de Obsidian; lo que Obsidian no
  sabe mostrar (xlsx, docx…) se abre con la **app por defecto del sistema**. También
  funciona con **carpetas** del vault (por ruta o por nombre): el clic la **revela y
  despliega en el explorador de archivos** del sidebar izquierdo. Funciona incluso si
  el nombre queda **partido en varias líneas** (Claude lo corta a lo ancho, a veces
  a mitad de palabra). Se puede desactivar en ajustes ("Clickable note links").
- **Remote control (toggle)**: botón (icono 📱) o **`Ctrl+R`** que activa/desactiva
  `/remote-control`. Al activarlo se pone verde y **conecta**; el enlace de la sesión
  (`https://claude.ai/code/…`) lo muestra el propio panel de Claude, y lo copias/abres
  desde ahí. Al desactivarlo, desconecta la sesión. (El plugin ya **no** captura ni
  abre la URL automáticamente al activar; se quitó ese comportamiento automático.)
- **Navegador por cuenta**: cada cuenta puede elegir su navegador (Chrome / Firefox /
  Edge / Brave / Opera / Opera GX / ruta personalizada) **desde su propia tarjeta** en
  ajustes (ver "Ajustes consolidados por cuenta"), usado por el botón de **re-login por
  cuenta** (🔓) del menú 👤. La cuenta activa se lee de `~/.claude.json`; las que dejan
  "Use default" usan el navegador por defecto global.
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
- **Aviso "el dueño está usando su cuenta"**: si el % de 5 h de una cuenta que tú
  NO estás usando sube entre dos sondeos, solo puede ser su dueño real gastándola.
  El menú 👤 muestra entonces un **icono de persona rojo parpadeante** a la
  izquierda del correo de esa cuenta durante ~30 min desde la última subida detectada: señal de "no la uses
  ahora para no pisarle el límite". Es solo un aviso visual (no bloquea nada).
- **Keep-alive de cuentas**: cada minuto el plugin comprueba y **refresca el token
  OAuth** de las
  cuentas cuyo token esté por caducar (el mismo flujo que usa Claude Code por
  dentro), para que las cuentas que no estás usando no se queden `expired` ni se
  excluyan del auto-switch. Solo refresca cuando hace falta (no machaca el servidor)
  y guarda el token rotado de forma atómica. Además protege los snapshots
  guardados: nunca los sobrescribe con credenciales vacías (p. ej. tras un
  logout) y re-snapshotea la cuenta activa cuando Claude rota sus tokens, para
  que cambiar de cuenta con `/login` no deje snapshots con tokens muertos.
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

## Requisitos y prerrequisitos (para un PC nuevo)

Para poner en marcha el harness desde cero en un ordenador nuevo necesitas:

- **Obsidian de escritorio.** El plugin es `isDesktopOnly` (usa Node y el `PATH`
  del sistema): no funciona en Obsidian móvil.
- **Sistema operativo con prebuild de `node-pty`.** El plugin trae los binarios
  nativos precompilados (N-API) de `node-pty` para **Windows (x64, arm64)** y
  **macOS (x64, arm64)**. **No incluye prebuild de Linux**, así que en Linux
  `npm install --ignore-scripts` deja `node-pty` sin binario y el panel fallará;
  ahí tendrías que instalar **sin** `--ignore-scripts` (compila desde fuente y
  requiere toolchain de C++: `build-essential`/`python3`) para generar el binario.
  Desarrollado y probado en **Windows 11**.
- **Node.js** instalado en el sistema. Obsidian corre sobre Electron pero tiene
  deshabilitado `runAsNode`, así que el plugin **forkea el `node` real del
  sistema** para ejecutar `pty-host.js`; sin un Node instalado el panel muestra un
  error pidiendo la ruta. Se autodetecta (`where node` / rutas conocidas) y es
  configurable en ajustes ("Node.js path"). No probé qué versión mínima hace falta;
  cualquier Node LTS reciente debería servir (node-pty 1.x es N-API).
- **El CLI `claude` (Claude Code) accesible en el `PATH`** y **con sesión
  iniciada al menos una vez.** El comando es configurable en ajustes ("Command",
  por defecto `claude`; en Windows se lanza vía `cmd /c claude` para que resuelva
  el `.cmd` del PATH). **En un PC nuevo tendrás que hacer `claude` → `/login` una
  vez** (desde una terminal normal o desde el propio panel) para crear
  `~/.claude/.credentials.json`; hasta entonces Claude pedirá login dentro del
  panel. La skill por defecto (`second-brain-assistant`) y el selector de skills
  esperan que existan skills en `~/.claude/skills`; si no hay ninguna, la selección
  de skill simplemente no encontrará nada (no es imprescindible para arrancar).
- **`npm` / Node para compilar** el plugin (paso de instalación, ver abajo).
- **Python** instalado en el sistema — **opcional**, solo para el botón **Token
  Dashboard**. Se autodetecta (`where python` / `py` / rutas conocidas) y es
  configurable en ajustes ("Python path"). Sin Python, el resto del plugin funciona;
  solo el dashboard no abrirá.
- **`git`** — solo si vas a clonar el repo o versionarlo; no es necesario para
  ejecutar el plugin.

> **Nota sobre multi-cuenta (macOS):** las funciones de guardar/cambiar de cuenta
> y auto-switch dependen de que Claude Code guarde sus credenciales en el **fichero
> plano** `~/.claude/.credentials.json`. En macOS, Claude Code puede guardarlas en
> el **Keychain** en su lugar; si ese es el caso, el hot-swap de cuentas no
> funcionará en ese equipo (el resto del plugin sí). Ver
> [`README_TECNICO.md`](README_TECNICO.md).

## Instalación (manual, en un PC nuevo)

1. Instala los prerrequisitos de arriba (Obsidian, Node.js y el CLI `claude`; haz
   `claude` → `/login` una vez). Python es opcional.
2. Copia esta carpeta en `<tu-vault>/.obsidian/plugins/claude-code-harness/`.
3. Instala dependencias y compila (desde la carpeta del plugin):
   ```bash
   npm install --ignore-scripts   # node-pty trae prebuilds N-API; NO se compila
   npm run build                  # empaqueta todos los .ts -> main.js
   ```
   (En Linux, omite `--ignore-scripts` — ver Requisitos.)
4. En Obsidian: Ajustes → Complementos de la comunidad → activa
   **Claude Code Harness**.
5. Abre el panel con el icono de terminal de la barra lateral o el comando
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
