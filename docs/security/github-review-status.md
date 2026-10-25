# Estado GitHub · fase 0.4 · 25/10/2026

- PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) **borrador**, rama `security/phase-0-2026-10-24` hacia main; sin fusión ni despliegue.
- Código medido: `80cfcb3e5bed4d1fb0aaaf0a10cd3878f034bcc3`; [CI PR 40182903549](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40182903549), Node 22/24 y Docker verdes. La PR enlaza también los checks del HEAD posterior de documentación.
- **72/72 pruebas por runtime**, incluido Chromium, y npm audit **0**. UX con progreso, cancelar, 429/reintento, idempotencia, destino fijo y rechazo de cambio de cuenta.
- Carga sostenida: **181,30 s**, 526 subidas (346 HTTP 200 / 180 HTTP 429), 0 fallos inesperados, 158 health HTTP 200; CPU media 19,32 %, sin OOM/swap, archivo previo conservado tras SIGKILL y cero temporales. El informe describe las muestras de RSS y sus límites.
- El primer generador falló por sintaxis antes de la carga; se conserva la evidencia, sin atribuirle éxito. [Informe, métricas, archivos y commits](phase-04.md).
- Staging propuesto: una réplica/proceso, proyecto/volumen/env sintéticos independientes, sin infraestructura creada. TLS/red/volumen/recuperación externos pendientes. Cuotas persistentes y soak prolongado pendientes; no tráfico abierto/producción.

[Checklist vigente](staging-checklist.md), [recuperación](photo-recovery.md), [transición de sesiones](session-transition.md). Las fases anteriores conservan sus métricas por SHA: [0.1](phase-01.md), [0.2](phase-02.md), [0.3](phase-03.md). No atribuir a un SHA resultados de código posterior.
