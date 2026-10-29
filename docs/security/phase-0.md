# Fase 0 de seguridad · 24/10/2026

> Registro histórico de fase 0. El estado actual, correo actualizado, CI y Docker se documentan en [fase 0.1](phase-01.md). Las limitaciones antiguas no describen por sí solas la rama actual.

Estado: cambios locales para revisión en `security/phase-0-2026-10-24`, sobre `6d94fa3e7a4995a5479253761925c53e8ea6e029`. No integrados en main, sin despliegue, sin credenciales reales y sin migrar fotografías reales.

## Evidencias previas a la corrección

Se usaron dos agencias ficticias, usuarios separados y un JPEG sintético. El análisis inicial reprodujo:

- H01: `Cookie: unrelated=%` en una petición anónima terminaba el proceso con `URIError`.
- H02: A subía una foto privada del inmueble `101`. B podía servirla desde su web y enlace de revisión al crear un inmueble con ese mismo ID. Si B figuraba primero en el almacén, también podía consultar, descargar, modificar ajustes, sobrescribir portada, añadir y eliminar fotos de A. Sin propietario actual, los mismos endpoints permitían el acceso.
- H03: HTML con un manejador `onerror` en `content.icon` ejecutaba JavaScript al abrir los contenidos en Chromium.

La batería específica anterior tenía 29 casos hoja: 10 pasaban y 19 demostraban ausencia de aislamiento; el resumen TAP añadía un fallo del contenedor de subtests. Las pruebas nuevas comprueban las garantías esperadas, no consideran la reproducción de una vulnerabilidad como una aprobación de seguridad.

## Cambios y justificación

| Archivo | Cambio | Validación |
|---|---|---|
| `lib/security.mjs` | Parser tolerante de cookies; segmentos de recurso sin rutas ni claves de prototipo; enums de tipo/canal/estado/icono | Cookies malformadas y sesión válida, IDs adversos, escritura con icono HTML |
| `server.mjs` | Límite de errores asíncronos por petición; fotos en `photos-v2/<brandId>/<propertyId>`; comprobación de marca, permiso e inmueble; manifest para descargar/borrar; bloqueos por marca/inmueble | HTTP entre dos empresas, colisiones, huérfanas, público/revisión, continuidad y reinicio |
| `server.mjs` | Sin lectura de fotos antiguas como fallback; sin cachear fotografías privadas; copia Drive extendida al nuevo namespace | Preservación de bytes antiguos, cabecera `no-store`; integración Drive real pendiente |
| `index.html` | URLs privadas con `brand`; 35 asignaciones dinámicas pasan a `setHTML`; impresión saneada; icono como texto; retirada del renderer antiguo inalcanzable | Chromium: payload almacenado, eventos/URLs peligrosas, navegación y edición de fotos |
| `package.json`, lockfile | DOMPurify 3.4.17 local; Acorn y Playwright para checks; `npm test` y check de frontend | Instalación congelada y sintaxis; sin CDN para sanitizador |
| `lib/photo-migration.mjs`, `scripts/photo-storage.mjs` | Plan offline revisado; copia completa y restauración verificada antes de copiar fotos; no se borra ni sobrescribe contenido antiguo | Hashes SHA-256, recuperación, plan obsoleto, colisiones/huérfanas, symlinks y destinos existentes |
| `tests/` | Regresiones H01/H02/H03, recuperación y compatibilidad SMTP local | Node 22 y 24, Chromium |
| `.github/workflows/ci.yml` | Checks y tests en Node 22/24; navegador; auditoría como informe separado con hallazgo conocido | Configurado; ejecución en GitHub pendiente de subir/revisar la rama |
| `Dockerfile`, `.dockerignore`, `.gitignore` | Librerías y CLI en imagen; exclusión de datos, credenciales locales, dependencias y artefactos del contexto | Contexto revisado; build bloqueado por red del builder, sin smoke de imagen final |

### H01

Cada valor de cookie se decodifica dentro de un `try`. Una cookie inválida deja de ser una sesión válida y no interrumpe la petición. El parser usa un objeto sin prototipo. El manejador HTTP captura rechazos asíncronos y devuelve un error genérico sin exponer valores ni trazas al cliente; si la respuesta ya empezó, cierra la conexión.

No se añadió un `uncaughtException` global para intentar mantener vivo un proceso en un estado desconocido. La regresión también usa un Host inválido para ejercitar el límite general de errores antes de entrar en una ruta.

### H02: endpoints y consultas afectados

No hay SQL: el almacén actual es JSON. Se retiró `propertyBrand()`, que recorría `store.data` y escogía el primer inmueble coincidente sin un contexto de empresa.

Ahora la consulta privada exige:

1. `brandId` válido en `?brand=...`.
2. Marca existente y `canBrand(user, brandId)` verdadero.
3. Inmueble existente en `store.data[brandId].properties`, con ID exacto.
4. Directorio físico de esa misma marca/inmueble. Para una foto concreta, ID incluido en su manifest.

Añadir el parámetro no concede permiso; el servidor verifica cada condición. El administrador global conserva sus permisos explícitos actuales. Crear administradores limitados por organización es H05 y sigue pendiente.

| Endpoint | Garantía nueva |
|---|---|
| `GET /api/photo-counts?brand=...&ids=...` | Solo consulta inmuebles de la marca autorizada |
| `GET/POST/PUT /api/photos/:propertyId?brand=...` | Consulta, subida y orden/ajustes dentro de un inmueble autorizado |
| `GET/PUT /api/photos/:propertyId/cover?brand=...` | Portada en el mismo namespace; lectura privada sin caché |
| `GET/DELETE /api/photos/:propertyId/:photoId?brand=...` | Fotografía del manifest de ese inmueble, dentro de esa empresa |
| `GET /w/:webId/:propertyId/foto/:index` | Marca derivada de `webId`, inmueble público de esa marca y directorio correspondiente |
| `GET /w/:webId/:propertyId/portada.jpg` | Misma comprobación pública para portada |
| `GET /api/review/:token/photo/:propertyId` | Marca derivada del token de revisión; nunca búsqueda fotográfica global |

`readManifest`, `writeManifest`, `sendCover`, `propertyPage`, `bioPage`, `handleWeb` y `handleReview` propagan la marca. El frontend usa `photoURL`, incluyendo miniaturas, galería, orden, borrado, portada y preparación de medios. Drive conserva su copia del árbol antiguo y añade `fotos-v2/<brand>/<inmueble>`.

Las peticiones privadas antiguas sin marca se rechazan. Dos empresas pueden tener el mismo ID de inmueble sin compartir carpetas. Una foto huérfana no se reasigna a quien adivine el ID. La prueba de colisión comprueba también que, al subir una foto propia de B con bytes diferentes, las rutas de B devuelven esa foto y no la de A.

**Compatibilidad con datos antiguos:** el servidor nuevo no muestra `photos/<propertyId>` hasta realizar la copia offline revisada descrita en `photo-recovery.md`. Esto es deliberado para evitar reasignaciones inseguras. La publicación debe esperar a que se resuelvan o se acepten explícitamente los casos ambiguos. No hay migración automática al arrancar.

### H03: revisión de inserciones de HTML

DOMPurify se sirve desde `node_modules` por `/vendor/purify.min.js`, sin CDN. El cliente falla sin insertar HTML si no está disponible; no hay fallback inseguro. Todas las asignaciones dinámicas `innerHTML` del cliente pasan por una función auditada; la impresión usa saneamiento de documento completo.

- `content.icon` se representa como texto y se normaliza en escrituras nuevas. Los registros anteriores siguen protegidos por el renderizado, sin reescribirlos automáticamente.
- La revisión incluye tarjetas, calendario, selector de empresas, informes, listas de usuarios/contactos, buscador, notificaciones, estados de proveedor, miniaturas y galerías.
- Los `blob:` solo se conservan en `src` de IMG/VIDEO/SOURCE del origen actual para no romper miniaturas generadas por el editor. No se habilitan esquemas arbitrarios ni eventos.
- Enlaces que conservan `target=_blank` reciben `rel=noopener noreferrer`.
- El botón de imprimir usa un listener, no un atributo `onclick` embebido.
- Las páginas públicas ya escapaban textos/atributos y JSON-LD. La revisión del cliente usa `textContent` y elementos DOM; sus asignaciones `innerHTML` restantes solo vacían elementos.
- El marcador WITEI mantiene su `javascript:` generado por el propio código; no utiliza una URL arbitraria del almacén.

Una comprobación AST bloquea nuevas asignaciones HTML sin el sanitizador. No sustituye revisión contextual ni las pruebas del navegador. CSP estricta, protección CSRF y esquema completo de entidades siguen siendo trabajos de endurecimiento separados.

## Cómo ejecutar las pruebas

```sh
npm ci
npx playwright install --with-deps chromium
npm run check
npm test
```

Si ya hay Chromium instalado se utiliza `/usr/bin/chromium`; también se puede indicar `CHROMIUM_PATH`. No se omiten silenciosamente los tests si falta navegador. Las fixtures aíslan `DATA_DIR`, puerto aleatorio y credenciales generadas en memoria. No heredan claves de proveedores. SMTP se conecta únicamente a un servidor de prueba en loopback y Chromium bloquea peticiones ajenas a la instancia.

Resultados verificados al cierre:

- `npm ci` y `npm run check`: correctos.
- Suite con Node 22.23.4 y Node 24.19.0: **38/38 pruebas pasan** en cada runtime; cero fallos, saltadas o canceladas (incluye subtests de operaciones fotográficas).
- SMTP sintético: versión actual 6.9.16 y candidata 10.2.1 compatibles con el flujo probado.
- `npm audit`: continúa señalando Nodemailer 6.9.16 (1 paquete de severidad alta); no se presenta como aprobado.
- Build Docker local: la descarga verificada de `node:22-alpine` funciona, pero `npm ci` dentro del builder falla con `EAI_AGAIN` al resolver `registry.npmjs.org`. Un contenedor efímero con red host tampoco logra consultar el registro en cinco segundos. No se ha desactivado TLS ni se ha sustituido la instalación por copias sin verificar. No se construyó la imagen final ni se ejecutó su smoke; repetir en staging con acceso al registro. La instalación congelada y las pruebas del mismo código sí pasan fuera del builder.

CI ejecuta instalación congelada, sintaxis y la suite obligatoria en ambos runtimes. El paso de auditoría de dependencias es visible y no bloqueante mientras H04 permanece abierto; genera un artefacto. Esto no silencia fallos de las pruebas de seguridad. Tras actualizar Nodemailer, convertir el nivel de vulnerabilidades acordado en un bloqueo de CI.

## Nodemailer: propuesta compatible, no actualización aplicada

La dependencia de la aplicación sigue en **6.9.16**, tal como se solicita revisar y proponer. Se recomienda evaluar **10.2.1 exacta**, disponible en el registro al 24/10/2026 y con Node >=20, compatible con el mínimo Node >=22 del proyecto.

Se instaló la candidata fuera del repositorio y se ejecutó el mismo test SMTP autenticado local con campos `from`, `to`, `replyTo`, `subject` y `text`. Pasó. La importación ESM por defecto y `createTransport().sendMail()` usados aquí funcionan. Su auditoría aislada devolvió cero avisos en esa consulta.

El salto de versión es mayor y cambia la estructura del paquete (`dist/esm` y `dist/cjs`): no asumir compatibilidad de importaciones internas `lib/*`. La aplicación usa la importación pública. No se han validado TLS con el proveedor real, DKIM, OAuth SMTP, pool, adjuntos ni plantillas ajenas a las rutas actuales.

Propuesta para un cambio revisable posterior:

```sh
npm install --save-exact nodemailer@10.2.1
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

Repetir las pruebas con el proveedor de correo en staging, sin usar cuentas/destinatarios de producción. No usar `npm audit fix --force`. El test admite `NODEMAILER_CANDIDATE` con la ruta al módulo ESM de una instalación aislada para repetir la comparación sin cambiar el lockfile del proyecto.

## Riesgos restantes y condiciones de publicación

- H04 sigue abierto hasta aprobar y aplicar la actualización de correo. `mp4-muxer` continúa obsoleto.
- Los roles globales, jobs persistentes/idempotencia de Meta, CSRF, quotas, cifrado de tokens y almacenamiento JSON mantienen los riesgos documentados en la auditoría original. Esta rama no es una certificación SaaS completa.
- La migración resuelve únicamente directorios antiguos con propietario único y verificado. No puede reconstruir la procedencia de fotos que ya estaban mezcladas; esos directorios permanecen intactos y sin servicio automático.
- No se ha probado Google Drive, Meta, Ollama ni Anthropic contra servicios reales. El ajuste de Drive debe verificarse en staging con una cuenta de prueba.
- Antes de publicar: revisar diff, aprobar la rama, CI verde, actualizar correo o aceptar formalmente el riesgo pendiente, ensayar la imagen exacta y ejecutar el procedimiento de copia/recuperación en una copia de staging.
- La ventana real requiere parar escrituras en todas las instancias, inventariar, verificar propiedad, conservar copia externa y comprobar restauración antes de activar el nuevo servidor. Comprobar espacio para original + copia + restauración de ensayo + fotos copiadas.
- Revisar registros del incidente potencial y enlaces públicos afectados; invalidar cachés de proxy/CDN. Las respuestas públicas antiguas tenían hasta 600 s de caché y no se pueden retirar imágenes ya descargadas por terceros. No reactivar la lectura global antigua como solución temporal.
- Hacer smoke autenticado y público con empresas de prueba y vigilar errores, permisos y copias. No integrar ni publicar automáticamente desde esta rama.
