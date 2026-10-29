# Estado GitHub · fase 0.5 · 25/10/2026

PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) **borrador**, rama `security/phase-0-2026-10-24`, sin fusión/despliegue ni cambios en main. Base de esta fase `865e1b5`.

- Regresiones: 75/75 en Node 22/24, Chromium incluido; audit npm 0. Las pruebas cortas completas de `13ed3c0` y `b31f61e` pasaron.
- **F05-MEM-01 bloqueante:** `d64e947` falló por OOM en [corto 40217906593](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217906593) y [ampliado 40217901995](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217901995), con 256 MiB sin swap. Ventanas de muestras 150,046/883,351 s. No declarar corregido por un check posterior verde.
- [Recuperación de telemetría 40219760323](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40219760323): lectura de artifacts sintéticos, sin cambios de aplicación; no es corrección del OOM. Las incidencias de harness/proveniencia se separan en el informe.
- Backup/restore correctos en [corto 40217442868](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217442868): hash de inventario, 24 archivos, origen intacto y sesiones antiguas rechazadas. No equivale a backup externo del VPS.
- [Informe 0.5](phase-05.md), [checklist](staging-checklist.md) y [perfil EasyPanel](../../deploy/easypanel-staging.md). Plan con `candidateApproved=false`; no crear todavía infraestructura real.

El último HEAD y sus checks reales se enlazan en la PR. No se accede a Hostinger, fotos/usuarios/credenciales de clientes, dominios o volúmenes de producción ni recursos de pago. TLS/red/swap/volumen/recuperación externos siguen pendientes; el mismo VPS no implica independencia física.
