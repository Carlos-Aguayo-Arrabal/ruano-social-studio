# Verificación aislada del VPS

Fecha: 2026-10-04. Rama: codex/social-studio-multiempresa-pilot. Código de prueba: tests/postgres-smoke.mjs.

- Docker build completado; imagen de 61.385.566 bytes, usuario node.
- PostgreSQL real 16.15, base temporal exclusiva y rol de aplicación sin privilegios administrativos.
- PASS: migración idempotente, rol restringido, login, salud, aislamiento entre empresas, viewer, CSRF, concurrencia, persistencia, entrega de interfaz, revocación y logout.
- Arranque normal del Docker CMD en modo producción: /health 200, /api/me sin sesión 401; healthcheck healthy.
- Muestra en reposo: aplicación 14,88 MiB y PostgreSQL 82,76 MiB. Es una observación puntual, no una prueba de carga ni una estimación de capacidad.

Los contenedores utilizaron una red Docker interna sin publicar puertos, límites de 256 MiB y 0,5 CPU por contenedor y datos sintéticos. PostgreSQL almacenó los datos en tmpfs. Se detuvieron al terminar. No se sustituyó ningún servicio ni se fusionó main.

Pendiente: navegador real, HTTPS y cookies a través de Traefik, restauración de backup y carga representativa. La entrega de HTML en la prueba no verifica interacción visual completa. No se ha validado PostgreSQL 17.
