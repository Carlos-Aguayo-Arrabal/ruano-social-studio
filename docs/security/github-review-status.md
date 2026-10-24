# Estado GitHub · fase 0.1 · 24/10/2026

- PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) abierta en **borrador**, base `main`, rama `security/phase-0-2026-10-24`.
- Commit de código fase 0: `b9e1d3b`. Commit de código fase 0.1: `d5c36832a92fb8f8c3eb762c115029b39627ec10`.
- API GitHub accesible ahora; el bloqueo anterior de `api.github.com` ya no impide consultar PR/jobs.
- Código fase 0.1: [push 40122334783](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122334783) y [PR 40122337554](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122337554) **completed / success**. Jobs Node 22, Node 24 y Docker verificados mediante API.
- Audit ahora **bloqueante**, sin `continue-on-error`; Nodemailer 10.2.1 y cero avisos actuales. Build conectado y smoke Docker aislado correctos.
- La API confirma artefactos de audit 22/24 y Docker; este entorno no pudo descargar sus ZIP/logs por restricciones de egress. No se han inventado sus contenidos. El resultado remoto comprobado es el de cada paso/job, además de los recuentos locales 46/46.
- La documentación posterior se publica en la misma rama; sus checks de HEAD se registran en la PR. No se ha fusionado ni desplegado y `main` continúa sin cambios por estas operaciones.

La antigua lista de bloqueos queda sustituida por [fase 0.1](phase-01.md): correo actualizado y Docker ensayado en CI; quedan validación de Hostinger/TLS/proveedores, recuperación externa y riesgos de seguridad documentados. El ensayo de fotografías solo usa datos sintéticos; no se autoriza migrar fotos reales.
