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
