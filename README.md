# Ruano Social Studio

Aplicación web de planificación y creación de contenidos para Ruano Inmobiliaria.

## Funciones incluidas

- Flujo guiado: URL → inmueble → fotografías → contenidos → calendario.
- Panel de control responsive.
- Calendario editorial.
- Creación y revisión manual de publicaciones, historias, reels y carruseles.
- Editor de fotografías y preparación de contenido.
- Biblioteca de inmuebles.
- Gestión multiempresa.
- Persistencia local en el navegador.

## Despliegue en EasyPanel

El repositorio incluye un `Dockerfile` que arranca `server.mjs` con Node 22.
El servidor protege la aplicación con una pantalla de acceso (usuario y
contraseña) y sirve `index.html` solo a sesiones válidas.

Configuración:

- Método de construcción: **Dockerfile**
- Puerto interno: **3000**
- Dominio: **ruanosocialestudio.momentundigital.com**
- Rama: **main**

Variables de entorno obligatorias (si falta alguna, el servidor no arranca):

- `APP_USERNAME`: usuario de acceso.
- `APP_PASSWORD`: contraseña de acceso.
- `APP_SESSION_SECRET`: clave larga y aleatoria para firmar la sesión.

Opcionales: `PORT` (por defecto `3000`) y `NODE_ENV=production` (activa la
cookie `Secure`).

Rutas: `/login`, `/logout` y `/health` (comprobación de estado).

Cada nuevo commit en `main` puede desplegarse automáticamente desde EasyPanel.

### Si la web da 502 tras reiniciar

Si EasyPanel muestra `pull access denied for easypanel/emprendeia/social_studio`,
la imagen se ha borrado del servidor. Reiniciar no basta: hay que volver a
construir con **Implementar**. Si EasyPanel se salta la construcción porque el
commit no ha cambiado, sube un commit nuevo a `main` (aunque esté vacío) e
implementa de nuevo.

## Desarrollo y regresiones de seguridad

Node >=22. Instala con `npm ci`, prepara Chromium con
`npx playwright install --with-deps chromium` y ejecuta `npm run check` y `npm test`.
La suite usa datos y credenciales sintéticos en directorios temporales.

La fase 0 requiere revisar el cambio de almacenamiento de fotografías antes de
publicar: [cambios, pruebas y riesgos](docs/security/phase-0.md) y
[procedimiento offline de copia y recuperación](docs/security/photo-recovery.md).
Las fotos nuevas se guardan por empresa en `DATA_DIR/photos-v2`; las antiguas no
se borran, migran ni reasignan automáticamente al arrancar.


### Fase 0.1 y staging controlado

Nodemailer actualizado a 10.2.1; auditoría de dependencias bloqueante en CI.
[Informe de fase 0.1](docs/security/phase-01.md),
[checklist de staging](docs/security/staging-checklist.md) y
[estado GitHub](docs/security/github-review-status.md).
El smoke Docker usa únicamente contenedor/volumen sintéticos sin red:
`node scripts/test-docker.mjs ruano-staging-check` tras construir esa imagen.
No es un despliegue en Hostinger ni una autorización para operar fotografías reales.


### Sesiones y autorización · fase 0.2

[Impacto y transición documentados](docs/security/session-transition.md): esta
versión rechaza cookies antiguas y exige nuevo login. Sesiones revocables en
`DATA_DIR/sessions.json`, una sola réplica y volumen persistente.
[Informe, pruebas y límites](docs/security/phase-02.md) y
[matriz administrativa/propuesta pendiente](docs/security/authorization-proposal.md).
No restaurar sesiones antiguas para recuperar accesos después de un backup.

### Preparación de staging · fase 0.3

[Informe y evidencias de consumo de memoria](docs/security/phase-03.md):
streaming de medios, controles de temporales y ensayo Docker con 256 MiB sin swap.
[Preparación reproducible y checklist](docs/security/staging-checklist.md):
`node scripts/prepare-staging.mjs /tmp/directorio-nuevo` genera únicamente archivos
locales con datos sintéticos. Staging requiere **una réplica**; el diagnóstico de
sesiones demuestra que varias instancias todavía no están soportadas.
No se ha desplegado en Hostinger ni se autoriza producción.

### Subidas y estabilidad · fase 0.4

[Informe, pruebas y métricas](docs/security/phase-04.md): panel de progreso,
cancelación, 429 con reintento e idempotencia de fotos; cuotas de subidas activas
por usuario/empresa y carga Docker sostenida con datos sintéticos.
La [checklist de staging](docs/security/staging-checklist.md) mantiene una réplica,
volumen y secretos independientes y validación pendiente de TLS/red/recuperación.
No se ha creado ni desplegado infraestructura en Hostinger.
