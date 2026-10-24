# Publicación de rama y revisión en GitHub · 24/10/2026

## Hechos verificados

- Repositorio autorizado: `Carlos-Aguayo-Arrabal/ruano-social-studio`.
- La rama `security/phase-0-2026-10-24` no existía en el remoto al iniciar esta comprobación.
- Se publicó con `git push --set-upstream origin refs/heads/security/phase-0-2026-10-24:refs/heads/security/phase-0-2026-10-24`.
- Un `git ls-remote` posterior confirmó `b9e1d3b60e43db2f7538419d2ba5fe3f2476d2fe` en esa rama.
- `main` permaneció en `6d94fa3e7a4995a5479253761925c53e8ea6e029`. No se ha fusionado ni desplegado.
- El workflow `Security regressions` tiene evento `push` y matriz Node 22/24; publicar esta rama solicita automáticamente su ejecución si Actions está habilitado en el repositorio. No se ha podido comprobar que GitHub lo haya iniciado ni su resultado.

## PR y Actions: bloqueo de acceso, sin resultado remoto verificado

Se intentó crear una PR **en borrador**, con base `main`, rama `security/phase-0-2026-10-24` y resumen H01/H02/H03. La CLI falló antes de alcanzar GitHub: `Post https://api.github.com/graphql: Forbidden`.

También falló la consulta de Actions con `Get https://api.github.com/repos/.../actions/runs: Forbidden`. Una comprobación sin autenticación confirmó `CONNECT tunnel failed, response 403`. La política de red del entorno no incluía `api.github.com`; el acceso Git mediante el proxy sí funciona.

No hay URL/número de PR, ID de ejecución o conclusión de CI comprobados. No se afirma que la PR exista ni que Actions esté verde. La presencia de autenticación en el entorno no demuestra acceso a la API; no se ha solicitado ni cambiado ninguna credencial.

Se guardó un borrador de configuración que añade únicamente `api.github.com`, conservando los presets y reglas existentes. Guardar ese borrador no aplica la red al proceso actual. Es necesario revisar/guardar la configuración y publicar el **entorno de desarrollo**, sin desplegar la aplicación, según el flujo de la plataforma. Después, volver a comprobar acceso antes de cambiar requisitos de autenticación.

## Continuar cuando la API sea accesible

1. Consultar si existe ya una PR de esta rama hacia `main` para no duplicarla.
2. Si no existe, crearla con `gh pr create --draft --base main --head security/phase-0-2026-10-24` y el resumen/documentación de fase 0. Mantenerla en borrador.
3. Consultar ejecuciones de `Security regressions` para el SHA actual, incluyendo las iniciadas por push y pull_request. Verificar ambos jobs Node 22 y 24 y las **38 pruebas**; revisar logs ante fallos. Si hace falta repetir una ejecución existente, usar `gh run rerun <ID>`.
4. Revisar la auditoría adjunta: tiene un paso explícitamente no bloqueante para el Nodemailer vulnerable actual. Un job verde no significa cero vulnerabilidades.
5. Añadir a la PR enlaces e IDs de ejecuciones y resultados comprobados; actualizar este estado. No fusionar ni desplegar.

## Bloqueos de publicación de la aplicación

- **Nodemailer:** sigue 6.9.16, con un paquete de severidad alta en `npm audit`. Propuesta 10.2.1 validada con SMTP sintético; actualización y prueba del proveedor en staging pendientes.
- **Docker:** build local bloqueado en instalación npm por DNS/conectividad (`EAI_AGAIN registry.npmjs.org`); imagen final y smoke de contenedor sin validar. Repetir con un builder con conectividad. El workflow actual prueba Node/Chromium, no el build Docker.
- **Fotografías:** datos reales intactos, sin migración automática. Revisar propiedad, realizar copia externa y restauración verificadas y ensayar la copia a `photos-v2` en staging. Huérfanas y colisiones permanecen sin asignación automática.

Ver [detalle de correcciones y pruebas](phase-0.md) y [procedimiento de recuperación](photo-recovery.md).
