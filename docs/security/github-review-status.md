# Estado GitHub · fase 0.2 · 24/10/2026

- PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3), borrador hacia `main`, misma rama `security/phase-0-2026-10-24`.
- Estrategia incompatible documentada antes del código: `afd1065`. Implementación inicial de sesiones persistentes: `dada4f6`.
- CI inicial: [push 40123931532](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40123931532) y [PR 40123935904](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40123935904). Los checks del último HEAD y resultados finales se enlazan en la descripción de la PR.
- Se mantienen matriz Node 22/24, Chromium, audit bloqueante y Docker sin red/datos reales. El smoke Docker ahora verifica también revocación persistente y continuidad de otra sesión tras reiniciar.
- No se fusiona, despliega ni modifica Hostinger. No se operan usuarios o credenciales reales.

La fase 0.1 sigue como histórico. [Fase 0.2](phase-02.md) documenta sesiones, pruebas y límites; [transición](session-transition.md) exige nuevo login para cookies antiguas. [Propuesta de autorización](authorization-proposal.md) no migra roles automáticamente. El último resultado de Actions debe verificarse por SHA, sin atribuir a una revisión pruebas añadidas después.
