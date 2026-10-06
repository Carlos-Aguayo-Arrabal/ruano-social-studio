# Verificación aislada del VPS

Fecha: 2026-10-04. Rama: codex/social-studio-multiempresa-pilot. Código de prueba: tests/postgres-smoke.mjs.

- Docker build completado; imagen de 61.385.566 bytes, usuario node.
- PostgreSQL real 16.15, base temporal exclusiva y rol de aplicación sin privilegios administrativos.
- PASS: migración idempotente, rol restringido, login, salud, aislamiento entre empresas, viewer, CSRF, concurrencia, persistencia, entrega de interfaz, revocación y logout.
- Arranque normal del Docker CMD en modo producción: /health 200, /api/me sin sesión 401; healthcheck healthy.
- Muestra en reposo: aplicación 14,88 MiB y PostgreSQL 82,76 MiB. Es una observación puntual, no una prueba de carga ni una estimación de capacidad.

Los contenedores utilizaron una red Docker interna sin publicar puertos, límites de 256 MiB y 0,5 CPU por contenedor y datos sintéticos. PostgreSQL almacenó los datos en tmpfs. Se detuvieron al terminar. No se sustituyó ningún servicio ni se fusionó main.

Pendiente: navegador real, HTTPS y cookies a través de Traefik, carga representativa. La entrega de HTML en la prueba no verifica interacción visual completa. No se ha validado PostgreSQL 17.

## Restauración comprobada

2026-10-04: pg_dump -Fc de rss_pilot_test y pg_restore --exit-on-error en rss_pilot_restored, una base nueva del mismo clúster aislado PostgreSQL 16.15. Archivo temporal de datos sintéticos: 10.726 bytes, permisos 0600; SHA-256 c19222c12b7668d6076459d0e7c8ff2a7a140fe93e1ead61f0c2f09732249b90.

PASS tests/restore-smoke.mjs: comparación exacta de las cinco tablas antes de modificar la base recuperada; tres usuarios y dos empresas; acceso mediante rol restringido, /health, login y lectura del contenido guardado en versión 1. La prueba genera una contraseña sintética solo en la base restaurada para comprobar login. El clúster y sus roles ya existían: no verifica recuperación de roles desde cero, pérdida completa del VPS ni backups de producción. Contenedor detenido al terminar.

HTTPS: el acceso del navegador a EasyPanel por la IP en puerto 3000 acabó en HTTPS y devolvió 502, «The remote server does not speak TLS». No se modificó TLS ni routing. Se necesita el acceso HTTPS válido del panel para configurar un servicio piloto separado.
