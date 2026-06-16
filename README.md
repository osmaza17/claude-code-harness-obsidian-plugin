# Claude Code Harness

Plugin de Obsidian (solo escritorio) que abre la **TUI real de Claude Code**
dentro de un panel lateral de Obsidian. La terminal ejecuta `claude` con el
directorio de trabajo apuntando a la raíz de tu vault, así que Claude Code opera
directamente sobre tus notas, con la estética del tema activo de Obsidian.

No es un emulador ni un embed de otra app: lanza el binario `claude` real en un
pseudo-terminal y lo pinta con [xterm.js](https://xtermjs.org/).

## Características

- **Terminal real de Claude Code** en un panel lateral, con `cwd` = tu vault.
- **Tema dinámico**: fondo, texto, cursor y paleta ANSI se ajustan al tema de
  Obsidian (claro/oscuro) y se reaplican al cambiarlo.
- **Sesión persistente**: arranca al abrir Obsidian aunque no abras el panel, y
  no se cierra al cerrar el panel — solo al cerrar Obsidian o desactivar el
  plugin.
- **Comandos de inicio + skill** configurables: comandos slash que se ejecutan
  al arrancar (vacío por defecto) y una skill que se invoca después. Se envían se
  abra o no el panel.
- **Selector de skills**: lista las skills de Claude Code en `~/.claude/skills`
  (cada subcarpeta con un `SKILL.md`) y la invoca como `/<nombre>`. Cámbiala desde
  un botón (icono ✨) en la cabecera; por defecto `second-brain-assistant`. Otro
  botón abre la carpeta `~/.claude/skills`.
- **Selector de modelo** en la cabecera (Haiku 4.5 / Sonnet 4.6 / Opus 4.8):
  ejecuta `/model <id>` y auto-confirma el diálogo "Switch model?".
- **Enviar nota activa**: botón `@` que inserta `@<ruta>` de la nota abierta.
- **Remote control (toggle)**: botón (icono 📱) que activa/desactiva
  `/remote-control`. Al activarlo se pone verde, copia al portapapeles el enlace
  de la sesión (`https://claude.ai/code/session_…`) y lo abre en Google Chrome
  (pestaña nueva) para entrar directo a la sesión remota; al desactivarlo,
  desconecta la sesión.
- **Zoom de fuente**: `Ctrl +` / `Ctrl -` / `Ctrl 0` y botones en la cabecera.
- **Copiar / pegar**: `Ctrl+C` (con selección) / `Ctrl+Shift+C` copian; `Ctrl+V`
  pega texto o **imagen** (guarda un PNG temporal y pega su ruta);
  `Ctrl+Shift+V` fuerza texto; clic derecho copia/pega.
- **Teclado**: `Ctrl+Enter` / `Shift+Enter` = nueva línea sin enviar; AltGr+2 =
  `@` (teclado español); `Ctrl+Z` / `Ctrl+Shift+Z` mapeados al borrar-línea /
  restaurar de Claude.

## Requisitos

- Obsidian de escritorio (Windows / macOS / Linux).
- **Node.js** instalado en el sistema (configurable en ajustes: "Node.js path").
- El binario **`claude`** (Claude Code CLI) accesible en el `PATH`.

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
   "Open Claude Code panel".

## Ajustes

| Ajuste | Descripción |
|---|---|
| Command | Comando a ejecutar (por defecto `claude`). |
| Extra arguments | Argumentos extra (p. ej. `--append-system-prompt "..."`). |
| Startup commands | Comandos slash al iniciar, uno por línea (vacío por defecto). |
| Skill | Skill de `~/.claude/skills` que se invoca como `/<nombre>` tras arrancar (también seleccionable desde la cabecera). |
| Model | Modelo inicial (haiku / sonnet / opus). |
| Node.js path | Ruta a `node.exe` real (autodetectada si se deja vacía). |

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
