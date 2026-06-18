# LOG

Registro de cambios del plugin. El historial anterior a esta fecha no quedó
documentado aquí; el LOG arranca en esta entrada.

## 2026-06-19

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
