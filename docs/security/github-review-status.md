# Estado GitHub · fase 0.3 · 25/10/2026

- PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3), **borrador** hacia `main`; misma rama `security/phase-0-2026-10-24`.
- Código de carga verificado: `389cba1`; [CI de PR 40180292748](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40180292748) con Node 22/24, Chromium, auditoría y Docker verdes. La descripción de la PR enlaza los checks del HEAD posterior de documentación.
- **65/65** pruebas por runtime, 15 casos de carga Docker, audit **0**. Una réplica, 256 MiB reales en cgroup, swap 0. Vídeo de 120 MiB pasa, exceso 413 y admisión 429 a partir del lote de ocho solicitudes; cuatro descargas grandes y hashes tras restart correctos.
- Fallos iniciales conservados: OOM original `ca84afd` y salida 137 del cliente separado en `c39421a`; [informe y evidencias](phase-03.md). El builder local sigue bloqueado por DNS de npm; Actions construye correctamente.
- No se fusiona, despliega, crea infraestructura, cambia main ni opera Hostinger/datos/credenciales reales. `main` observado sin cambios: `6d94fa3e7a4995a5479253761925c53e8ea6e029`.

[Checklist de preparación](staging-checklist.md), [recuperación](photo-recovery.md), [transición de sesiones](session-transition.md) y [propuesta de autorización pendiente](authorization-proposal.md). Varias instancias no están soportadas: el diagnóstico sintético reproduce una revocación incoherente entre procesos. El TLS/perímetro y las copias externas del VPS siguen pendientes de futura validación autorizada.

[Phase 0.1](phase-01.md) y [phase 0.2](phase-02.md) conservan sus resultados históricos. No atribuir CI verde de un SHA a código posterior.
