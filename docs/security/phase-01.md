# Ruano Social Studio · fase 0.1 · 24/10/2026

## Resultado y alcance

**Preparada para un ensayo de staging aislado con datos sintéticos. No preparada para abrir un SaaS a clientes ni para desplegar a producción sin las validaciones operativas pendientes.**

Repositorio `Carlos-Aguayo-Arrabal/ruano-social-studio`, rama `security/phase-0-2026-10-24`, PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3), mantenida en borrador hacia `main`. Código de esta fase: `d5c36832a92fb8f8c3eb762c115029b39627ec10`; esta documentación posterior no modifica ese código. No se ha fusionado, publicado una imagen en un registro, desplegado en Hostinger ni accedido a datos, redes privadas o credenciales de clientes.

Se utilizan fixtures temporales, JPEG sintético, SMTP local y simulador HTTP de Ollama. Los tokens de integraciones reales no se heredan en esas fixtures. La autenticación de GitHub ya disponible se usa únicamente para el repositorio autorizado y la PR.

## 1. Archivos y cambios

| Archivos | Modificación y motivo |
|---|---|
| `package.json`, `package-lock.json` | Nodemailer 6.9.16 → **10.2.1 exacta**, estable disponible en el registro consultado; Node requerido por el paquete >=20 |
| `server.mjs` | Timeouts SMTP y prohibición de lectura de ficheros/URLs desde mensajes; comprobación de origen en escrituras/logout; jobs de IA limitados al creador; manifest corrupto falla con 503 sin sobrescribirlo; subida lee el manifest antes de escribir el nuevo archivo |
| `lib/security.mjs` | Comprobación de Origin / Sec-Fetch-Site sin confiar en X-Forwarded-Host; mantiene parser tolerante, IDs y normalización de contenidos |
| `lib/photo-migration.mjs` | Detecta IDs repetidos también dentro de una empresa, archivos sin referencia y manifests incompletos; los deja sin asignación. Hashes por streaming para no cargar vídeos grandes completos al inventariar backups |
| `tests/helpers.mjs`, `tests/smtp.mjs`, `tests/phase-01.test.mjs` | Simuladores locales y ocho nuevas regresiones de origen/CORS, permisos, sesión manipulada, IA, subida excesiva, corrupción, diagnóstico de fotos y notificaciones SMTP |
| `scripts/test-docker.mjs` | Build-independent smoke reproducible sobre imagen, contenedor y volumen propios, sin red ni puertos; verifica usuario, permisos, login, foto y reinicio |
| `.github/workflows/ci.yml` | Matriz Node 22/24, auditoría de **todas las severidades bloqueante**, job Docker conectado durante build y aislado durante ejecución; artefactos y opción workflow_dispatch |
| `deploy/staging.compose.yml` | Configuración optativa de ensayo independiente: sin red, sin puertos, root read-only, volumen sintético y recursos acotados; no aplicada a Hostinger |
| `.gitignore`, `.dockerignore` | Excluyen artefactos generados de Git/contexto de construcción |
| `docs/security/phase-01.md`, `staging-checklist.md`, `photo-recovery.md`, `github-review-status.md`, `phase-0.md`, `README.md` | Resultados actuales, histórico identificado, límites, checklist y recuperación de staging |

No se cambian credenciales existentes. Los formatos centrales de `store.json`, usuarios y contenidos se mantienen; la fase 0 ya había introducido `photos-v2/<empresa>/<inmueble>` y el parámetro obligatorio `brand` en la API privada de fotos.

## 2. Pruebas automatizadas reales

| Entorno / comprobación | Resultado |
|---|---|
| Instalación congelada `npm ci` | Correcta con el lockfile actualizado |
| `npm run check` | Sintaxis de servidor y frontend correctas |
| Local Node **22.23.4** | **46/46 pruebas pasan**, 0 fallos, 0 saltadas, 0 canceladas |
| Local Node **24.19.0** | **46/46 pruebas pasan**, 0 fallos, 0 saltadas, 0 canceladas |
| GitHub Actions Node 22 | Job, instalación, Chromium, check, suite y audit: **success** |
| GitHub Actions Node 24 | Job, instalación, Chromium, check, suite y audit: **success** |
| Docker conectado en GitHub Actions | Build y smoke: **success** |
| `docker compose ... config --quiet` | Configuración sintácticamente válida con variables sintéticas, sin iniciar servicios |

Ejecuciones verificadas para el SHA de código `d5c3683`:

- [Push 40122334783](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122334783): **completed / success**.
- [PR 40122337554](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122337554): **completed / success**.
- [Node 22](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122334783/job/120956396519), [Node 24](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122334783/job/120956396357), [Docker](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40122334783/job/120956396477): pasos comprobados mediante API de GitHub. Los checks del último commit documental se registran además en la PR.

Se comprobaron las conclusiones de cada job y sus pasos, no solo el resultado global. Los recuentos 46/46 se capturaron directamente de los runners locales; el mismo comando de suite pasa en ambos jobs remotos.

**Limitación de inspección:** la API confirma que se subieron los artefactos `dependency-audit-node-22`, `dependency-audit-node-24` y `docker-synthetic-results`. Su descarga y los ZIP de logs desde este entorno fueron bloqueados por la política de egress de los hosts de almacenamiento/logs de Actions. No se afirma haber leído esos ZIP ni el JSON remoto. Los resultados remotos citados son las conclusiones reales de los pasos vía API; los artefactos siguen disponibles desde la ejecución para un revisor autorizado.

### Qué se ejecuta

- Regresiones H01 de cookies malformadas, firma inválida y errores de petición.
- H02: consulta, descarga, ajustes, portada, subida y borrado entre A/B; huérfanas, colisiones, rutas públicas/revisión, conservación de archivos, permisos e IDs adversos.
- H03 en Chromium: contenido malicioso almacenado, eventos/URLs peligrosos, impresión saneada y funcionalidad de subir/editar/recargar fotos con miniaturas blob.
- Nuevos controles de origen: rechaza Origin ajeno/null y Sec-Fetch-Site cross-site; acepta la UI del mismo origen. Preflight no obtiene Access-Control-Allow-Origin.
- Jobs IA: con un ID conocido de A, B recibe 404; A puede obtener su resultado del simulador.
- Corrupción de manifest: GET/POST/PUT fallan con 503, los hashes permanecen iguales y el proceso responde a `/health`.
- Subida >4 MiB: conexión rechazada, sin foto persistida y con servidor vivo. Sigue siendo un cierre de conexión, no una experiencia de error 413 con cuerpo garantizado.
- Plan/migración/restauración: hashes, permisos de destinos, planes obsoletos, colisiones, huérfanas, symlinks, destinos existentes y copia de propietarios verificados.

## 3. Nodemailer y `npm audit`

Antes: **6.9.16**, un paquete de severidad alta y **19 avisos asociados**, no 19 paquetes vulnerables. Incluían problemas de parser/DoS, interpretación de destinatarios y rutas condicionadas de acceso a ficheros/URLs. Tener la versión afectada no demuestra explotabilidad de todas las opciones desde esta aplicación.

Se eligió **10.2.1**, última estable devuelta por el registro durante esta fase. Su requisito Node >=20 es compatible con el proyecto >=22. La aplicación utiliza la API pública `import nodemailer` y `createTransport().sendMail()`; no usa las rutas internas cuya estructura cambió en versiones mayores.

Resultados actuales:

- `npm audit --json`, incluyendo desarrollo: **0 vulnerabilidades** (0 bajas, moderadas, altas o críticas) en la consulta realizada.
- `npm audit --omit=dev --audit-level=low`: **found 0 vulnerabilities**.
- Auditorías de los jobs Node 22 y Node 24: **success**, sin `continue-on-error`. Un hallazgo de cualquier severidad o fallo del servicio de auditoría bloquea ese paso/job.
- `mp4-muxer@5.2.2` sigue marcado como obsoleto, pero no aparece como vulnerabilidad en esta consulta. Obsolescencia y vulnerabilidad no son equivalentes.

Pruebas de compatibilidad: envío SMTP autenticado a un servidor loopback, destinatario, Reply-To, asunto y cuerpo; también se ejercitan **las rutas reales** `/api/notify/test`, `/api/report/send` y el aviso asíncrono al crear un contacto sintético. Se verifican éxito, rechazo SMTP, permisos por empresa y ausencia de entregas cuando SMTP rechaza.

No se enviaron correos reales. SMTP TLS, DKIM, OAuth, deliverability y credenciales de proveedor real están sin probar. Se mantienen detección de puerto 465/secure y puertos alternativos; se añaden timeouts y `disableFileAccess/disableUrlAccess`. Las notificaciones de texto actuales no requieren adjuntos ni lectura de URLs. Telegram no se ha conectado a un bot real.

## 4. Docker, permisos y persistencia

El Dockerfile sigue basado en **Node 22 Alpine**, instala únicamente dependencias de producción con `npm ci --omit=dev`, copia servidor/interfaz/librerías/CLI, ejecuta como `node` y prepara `/app/data` para ese usuario. La aplicación no requiere compilación, una base de datos externa ni binarios nativos adicionales para el flujo de servidor probado.

La construcción local de fase 0 falló con `EAI_AGAIN registry.npmjs.org` dentro del builder. No se ocultó ese fallo ni se desactivó TLS. En fase 0.1 el job conectado de GitHub Actions **construyó correctamente la imagen actual** y verificó:

1. `Config.User=node`, ejecución UID 1000 y runtime Node 22.
2. Root filesystem de solo lectura y escritura permitida en el volumen de prueba.
3. `network=none`, sin puertos publicados, sin bind mounts ni redes/servicios de producción.
4. Healthcheck de Docker sano, login y atributos Secure/HttpOnly de cookie.
5. Creación de empresa/inmueble sintéticos y subida de JPEG.
6. `docker restart` y posterior healthcheck sano; estado, manifest y bytes de foto conservados.
7. Limpieza solo del contenedor y volumen UUID creados por el propio test.

El smoke impone 1 CPU, 256 MiB y 128 PIDs. Es evidencia para ese dataset pequeño, no una prueba de carga ni una garantía de capacidad de Hostinger. La imagen se construyó en el runner, no se publicó en un registro ni se ejecutó en el VPS. Tampoco se prueba el filesystem real del proveedor, Traefik/TLS o recuperación externa con este smoke.

Configuración preparada: [checklist de staging](staging-checklist.md) y `deploy/staging.compose.yml`. EasyPanel debe ser la fuente de configuración del futuro proyecto independiente, sin tocar Swarm/Traefik de producción ni reutilizar sus volúmenes/redes. No se ha usado SSH ni API de Hostinger.

## 5. Fotografías y recuperación

Se conserva el aislamiento de fase 0 y se refuerzan errores y diagnósticos:

- Las API exigen empresa, permiso e inmueble; las rutas públicas derivan la empresa de webId/token. No se consulta un directorio global por un ID aislado.
- Los manifests corruptos no se interpretan como vacíos. Se devuelve 503 y se conservan los bytes; la subida no deja un nuevo fichero antes de comprobar el índice.
- El plan enumera **IDs repetidos entre empresas y dentro de una misma empresa**, directorios huérfanos, IDs/propietarios inválidos, índice incompleto o corrupto y archivos sin referencia.
- Todos esos conflictos quedan en `unresolved`, sin asignación. Ni editar `ownershipVerified=true` permite saltarse una ambigüedad que sigue en el almacén actual.
- Solo se copian asignaciones con propiedad única revisada. Antes de la primera copia se crea backup completo, se compara contra origen y se restaura en un destino temporal verificando SHA-256.
- No se borran fotos antiguas ni se sobrescriben destinos. Recuperar exige un directorio nuevo; se rechazan symlinks y backups anidados, incluso mediante alias.
- El inventario usa hashing por streaming. El backup sigue necesitando espacio para varias copias y un procedimiento offline real.

Los ensayos A/B, copia, migración y restauración se ejecutaron **solo con fixtures**. No se ha inventariado ni migrado una sola foto real. El árbol antiguo no tiene fallback automático al arrancar; activar el servidor nuevo sobre fotos antiguas sin preparar la copia haría que no se vieran, por diseño seguro.

Procedimiento completo: [photo-recovery.md](photo-recovery.md). Guía específica de staging, permisos UID y decisiones de propiedad: [staging-checklist.md](staging-checklist.md).

## 6. Auditoría adicional: evidencia y límites

### Problemas verificados/corregidos

| Hallazgo | Evidencia | Estado |
|---|---|---|
| Nodemailer afectado | Auditoría antes/después y pruebas SMTP locales | Actualizado; cero avisos actuales |
| Falta de comprobación de Origin | Ausencia en código anterior y peticiones con Origin ajeno aceptadas en auditoría inicial; no se demostró entonces un bypass de SameSite en navegador | Control de origen añadido; regresiones negativas y UI mismo origen correctas |
| Recuperación de jobs IA sin propietario | Código anterior consultaba solo el ID aleatorio; lectura requería conocerlo. No se intentó enumerar trabajos reales | Propietario obligatorio; test A/B con simulador verifica 404/resultado propio |
| Manifest corrupto tratado como vacío | Código anterior devolvía `{photos:[]}` ante cualquier error; podía reescribir el índice después | Falla cerrado con 503, conservación de hashes y servidor vivo probados |
| Duplicados internos/archivos sueltos no diagnosticados | Análisis del plan anterior; fixtures reproducen las variantes | Quedan sin asignación, con motivo explícito |

### Reproducido y pendiente

**Logout no revoca una cookie ya copiada:** con una sesión sintética, `/logout` responde 303 y volver a usar la misma cookie en `/api/me` responde 200. El logout borra la cookie del navegador, pero no existe revocación persistente de ese token de sesión. Requiere que alguien conserve una copia; no implica que otro cliente pueda obtenerla por sí solo. Caduca a las 12 horas y los usuarios secundarios tienen versión de contraseña/desactivación para invalidar sesiones. Recomendación: sesiones revocables con identificador persistido y logout global; prioritario antes de usuarios/clientes reales. No se presenta como corregido ni se codifica su aceptación como una garantía de seguridad.

### Riesgos condicionados / recomendaciones pendientes

| Área pedida | Revisión y riesgo restante |
|---|---|
| Usuarios, empresas y organizaciones | Los tests A/B cierran rutas y fotos probadas. `admin` sigue siendo administrador global; `agency` tiene permisos amplios en sus marcas. No hay entidad organización/membresía por rol ni separación editor/aprobador. No otorgar admin a clientes; diseñar el modelo antes de SaaS independiente |
| Autorización y archivos | IDs/rutas validados, namespace de marca y manifest; rutas users/Drive inaccesibles a agency. No se hizo una prueba exhaustiva de cada variante de endpoint ni del sistema de archivos real del VPS. Acceso de un actor con permisos locales al volumen sigue fuera de estos controles HTTP |
| XSS / validación | Regresiones Chromium y control AST pasan. No hay esquema exhaustivo de todos los objetos del sync. Mantener revisión contextual y avanzar hacia CSP estricta; no interpretar sanitización como validación total del negocio |
| Cookies / sesiones | HMAC, caducidad, cookies inválidas/firma manipulada y flags comprobados. Falta revocación de logout, MFA y recuperación/invitaciones. TLS de staging real sin comprobar |
| CSRF / CORS | Origin y Sec-Fetch-Site verificados en mutaciones/logout; no se habilita CORS global. No se implantó token CSRF dedicado. Clientes programáticos sin Origin siguen permitidos si poseen cookie. Validar host/proxy y comprobar navegadores/topología real; no confiar en encabezados reenviados de cualquiera |
| Secretos / tokens | No se han leído valores de cliente. Existen tokens Meta/Google persistidos como JSON sin cifrado de aplicación. Proteger volumen/backups, permisos, cifrado externo y política de retención; rotaciones reales fuera de esta fase |
| Recursos / subidas | Límites por cuerpo y rechazo >4 MiB probado. Vídeos hasta 120 MiB aún se cargan en memoria; no hay cuota total por empresa. Mapas de rate limit y cola de IA globales presentan riesgos de consumo bajo abuso. Añadir cuotas, streaming y límites/limpieza globales; no se realizó ataque de carga |
| Rutas públicas | Fotos de A no aparecen en web/revisión de B; `web=false` probado. Los enlaces de revisión son bearer tokens sin caducidad automática y algunos medios/páginas son públicos por diseño. El perímetro de staging debe cubrirlos, no solo `/login`; no habilitar datos reales |
| Recuperación de errores | Límite HTTP, manifests y restauración comprobados. JSON global, cachés y locks son de un proceso; no equivalen a transacciones entre servicios ni permiten escalar a varias réplicas con garantías |
| Efectos externos | Publicación Meta puede quedar en publishing tras caída o duplicar efectos parciales; cola durable/idempotencia pendientes. No se ha publicado ni enviado nada a proveedores reales. Las pruebas no certifican integraciones comerciales |

Los riesgos de firewall, Swarm, Traefik, puertos externos, SMTP TLS, backups externos y exposición del VPS no se han evaluado porque esa infraestructura no se ha inspeccionado. No hay hallazgo probado contra producción.

## 7. Compatibilidad con la aplicación actual

| Función | Evidencia actual | Límite |
|---|---|---|
| Arranque, autenticación y persistencia | HTTP local, Node 22/24, imagen Alpine, reinicio y volumen sintético | No cubre TLS/volumen del VPS |
| Marcas, cartera, contenidos y permisos actuales | Sync, usuarios y A/B; sin cambio de formato del almacén | Admin global y JSON sin transacciones persisten |
| Fotos, portada, orden, ajustes, descarga y revisión/web | CRUD/colisiones, Chromium, público/revisión, bytes después de reinicio | Datos antiguos exigen copia revisada, no fallback |
| Informes y avisos email | SMTP autenticado y rutas notify/report/lead; rechazo y permisos probados; impresión saneada | No TLS/DKIM/deliverability reales |
| IA | Simulador Ollama y aislamiento de resultado | Anthropic/Ollama reales y coste/calidad sin probar |
| Calendario, impresión y edición | Regresiones Chromium existentes | No es un recorrido completo de todas las pantallas |
| Reels / formatos de navegador | Código de codificación conservado, miniaturas funcionando | No se ha exportado un reel completo ni probado Safari/iOS |
| WITEI | Marcador que abre la aplicación no requiere POST entre sitios; no cambiado | No se ha abierto una cuenta WITEI real ni validado su DOM actual |
| Meta, Telegram y Drive | Sin cambio de credenciales ni contacto con servicios reales | Permisos, OAuth, publicación y backup remoto pendientes de sandbox |

No se afirma que todas las funciones de la aplicación estén certificadas. Los controles de origen exigen que `PUBLIC_URL`, dominio y TLS del staging estén configurados correctamente; OAuth por GET no se bloquea por el nuevo control de escritura.

## 8. Fallos registrados y recomendación

- Histórico: build local Docker de fase 0 falló por conectividad DNS de npm; en fase 0.1 el build y smoke de GitHub Actions pasan. No se declara reparado el DNS local.
- Histórico: API GitHub bloqueada en fase 0; ahora se pudo verificar PR/jobs. Sigue bloqueada la descarga de ZIP de logs/artefactos desde este entorno; no se han sustituido por archivos ficticios.
- Las 46 pruebas actuales no tienen fallos/saltadas/canceladas. `npm audit` actual no comunica vulnerabilidades; eso depende de los avisos disponibles al consultar el registro.
- Hostinger/EasyPanel, dominio/TLS, conexión a proveedores y recuperación desde almacenamiento externo **pendientes**, no aprobados por sustitución con mocks.

**Recomendación:** continuar con el checklist sobre un proyecto/volumen nuevos y únicamente datos sintéticos. El build y las regresiones permiten ese ensayo controlado; los pendientes de revocación, roles, recursos, publicación recuperable y operación impiden recomendar producción o un piloto con datos reales. Mantener la PR en borrador y detenerse antes de integración/despliegue.
