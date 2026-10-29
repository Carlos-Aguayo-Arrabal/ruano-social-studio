# Fase 0.4 · UX de subidas y estabilidad de staging · 25/10/2026

Repositorio `Carlos-Aguayo-Arrabal/ruano-social-studio`, rama `security/phase-0-2026-10-24`, PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) en borrador. Sin fusión, cambios en main, despliegue, acceso a Hostinger, datos/credenciales de aplicación reales ni servicios de pago. Solo recursos Docker desechables de CI y archivos locales sintéticos.

## Comportamiento implementado

Las fotos, portadas, imágenes de publicaciones y reels MP4 pasan por una cola visible. Indica «En cola», progreso de bytes transferidos, espera de confirmación del servidor, «Guardada», servidor ocupado, errores y cancelación. El 100 % de transferencia no se anuncia como archivo guardado hasta recibir HTTP 2xx. Las etiquetas y mensajes se construyen con nodos DOM/textContent, sin insertar HTML.

- **429:** muestra «Servidor ocupado», respeta `Retry-After` (1–60 s) y permite un reintento explícito. No hay bucle de reintentos automáticos ni duplicación de tareas al pulsar repetidamente.
- **401/403/409/413/red/timeout:** mensajes distintos; el archivo se conserva en la cola para decidir reintentar o descartar. El estado de cola no se persiste en disco/localStorage: recargar/cerrar la página pierde los blobs pendientes. Revisar la galería antes de seleccionar otra vez el archivo.
- **Cancelar:** aborta XHR o retira la tarea de espera. Puede reintentarse la misma tarea. Una cancelación después de que el servidor termine el commit no deshace un archivo válido; el mensaje lo explica. No se borran archivos existentes para simular una cancelación.
- **Progreso:** eventos nativos XHR de envío; la recepción del servidor sigue siendo streaming con backpressure. No se convierte el cuerpo en base64 ni se concatena el archivo en el servidor. Descargas y hashes también usan streams.
- **Cola local acotada:** dos envíos simultáneos, hasta veinte archivos retenidos y 256 MiB de blobs entre pendientes/fallidos/cancelados; cinco entradas de éxito en el historial. «Descartar» libera el blob; éxito también lo libera. Es un límite del gestor, no del heap total del navegador ni del editor/reel.
- **Destino estable:** la URL/empresa/inmueble se fija al crear la tarea y antes de codificar la foto. Cambiar de empresa durante la espera no redirige el archivo. Las nuevas tareas incluyen `X-Upload-User`; el servidor devuelve 409 si la cookie pasó a pertenecer a otra cuenta. La cabecera solo añade una restricción, nunca concede permisos. Clientes anteriores sin ella conservan la autorización normal.

### Reintento sin duplicados

Fotos POST: la interfaz conserva un `Idempotency-Key` aleatorio de 128 bits por tarea y reenvía el mismo blob. Después de autenticar y autorizar, el servidor deriva un ID HMAC con usuario, empresa, inmueble, clave y `APP_SESSION_SECRET`. Dentro del lock del inmueble, si el ID ya figura en el manifest se compara SHA-256 mediante streaming; mismo contenido devuelve el mismo ID, contenido diferente/archivo ausente devuelve 409. Si la respuesta original se pierde después del commit, el reintento no añade otra entrada ni otro archivo. Funciona tras reiniciar conservando datos y el mismo secreto sintético.

No introduce tabla, migración o registros de idempotencia ilimitados. Clientes sin clave conservan IDs aleatorios. La garantía corresponde a la misma tarea/usuario/clave y a una foto aún registrada: no es deduplicación visual de selecciones nuevas, no cubre rotación del secreto ni recuperación de un snapshot antiguo, y no impide volver a crear una foto eliminada mediante una nueva solicitud explícita. Las sesiones/secretos no se cambian en esta fase.

Portadas y medios PUT reintentan la misma ruta/posición; el commit por rename mantiene un único archivo válido por posición (JPG o MP4). Se conserva la semántica de última escritura; no se incorpora versionado/ETag para editar concurrentemente un mismo recurso. Las portadas automáticas sustituidas se retiran de la cola para no ofrecer un reintento obsoleto de esa tarea.

## Cuotas revisadas

| Control | Aplicación | Persistencia / efecto |
|---|---|---|
| Subida individual | Fotos/portadas 4 MiB; JPG de publicaciones 8 MiB; MP4 120 MiB | Límites anteriores conservados; exceso 413 |
| Receptores activos | Global 4, usuario 2, empresa 3 | Memoria de un solo proceso, sin migración; exceso 429 + Retry-After 2 s |
| Liberación | Fin, formato inválido, exceso, desconexión o aborto temprano | `finally` elimina contadores sin retener IDs inactivos; arranque comienza sin receptores |
| Sesiones | 2.000 globales, 20/usuario, 12 h | Sin cambios respecto a fase 0.2 |
| Cola del navegador | Dos envíos, 20 archivos y 256 MiB retenidos | No equivale a cuota de almacenamiento |

Administradores y propietario también tienen los límites de subidas. La concurrencia por empresa contempla varios usuarios; no se infiere por IP, cabecera arbitraria o nombre de archivo. El contexto procede del usuario autenticado y de la empresa autorizada. No se reduce almacenamiento existente, ni se eliminan o migran fotografías.

**Cuotas estructurales pendientes:** no se implementa un límite persistente de disco por usuario. Los archivos actuales no registran de forma completa su creador y un usuario puede pertenecer a varias marcas. Atribuir propiedad histórica por suposición sería incorrecto. La futura propuesta necesita recursos con empresa, autor/procedencia, bytes, versión y estado; inventario verificado; reservas/consumo transaccionales; reconciliación tras interrupciones y backups; decisiones explícitas para fotos huérfanas; alertas y políticas de retención. También requiere coordinar sesiones/locks/jobs antes de escalar. No se migra el modelo automáticamente. Una cuota de disco por empresa requiere contar/reservar de forma coherente archivos válidos y temporales; recorrer todo el árbol por cada petición no resuelve las carreras ni ofrece un coste acotado.

Los límites actuales protegen receptores concurrentes, no garantizan reparto equitativo bajo una inundación, capacidad de disco ni límites de descarga/JSON/CPU por organización. Quedan pendientes cuotas de almacenamiento y tasa, clientes lentos y límites de conexiones en aplicación/proxy. Los usuarios autorizados de una marca pueden crear medios en claves nuevas; sin cuota persistente, una cuenta abusiva puede agotar el disco. Esto debe bloquear tráfico abierto/producción hasta mitigarse. Para el primer staging solo datos sintéticos acotados y supervisión de espacio libre; no carga abierta de clientes.

## Pruebas y resultados

Código medido: **`80cfcb3e5bed4d1fb0aaaf0a10cd3878f034bcc3`**. [CI PR 40182903549](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40182903549): **Node 22, Node 24 y Docker verdes**. Local: Node 22.23.4 y 24.19.0, **72/72 pruebas por versión**, Chromium incluido, sin omisiones; `npm run check` correcto. El HEAD posterior de documentación y sus checks se enlazan en la PR.

Carga sostenida completada: **181,30 s**, 526 peticiones de subida (346 HTTP 200 / 180 HTTP 429), **0 fallos inesperados**, 158 sondeos de salud todos HTTP 200, 32 cancelaciones intencionales y 17 excesos rechazados con 413. El contador de peticiones de la tabla no incluye sondeos, cancelaciones, excesos ni controles cruzados 403.

| Concurrencia | Duración | Subidas 200 / 429 | Latencia p50 / p95 / p99 / máx. | Salud p95 |
|---|---:|---:|---|---:|
| 1 | 60,25 s | 60 / 0 | 4 / 753 / 843 / 843 ms | 7 ms |
| 2 | 60,78 s | 106 / 0 | 14 / 2217 / 2733 / 2739 ms | 8 ms |
| 8 | 60,27 s | 180 / 180 | 8 / 3653 / 4137 / 4144 ms | 47 ms |

Perfil del cgroup de aplicación (256 MiB, swap desactivado, 1 CPU; cliente separado 512 MiB): **173 muestras** durante 180,93 s. CPU media **19,32 %** de un núcleo, p95 83,06 %, máximo muestreado 104,43 %; la lectura por ventanas/sondeos puede exceder 100 % puntualmente sin que se cambie el límite. Pico acumulado de cgroup **269.029.376 bytes / 256,57 MiB**, incluye caché; máximo configurado comprobado **256 MiB**, sin aumentar RAM/swap. Mayor RSS muestreado **105,33 MiB**, anon 42,52 MiB. RSS inicial/final **81,53 / 92,82 MiB**: aumenta 11,30 MiB durante el ensayo; no se presenta como ausencia demostrada de fugas. Hace falta soak prolongado para separar calentamiento, GC y crecimiento sostenido. Swap usado 0, sin OOM.

Las dos empresas reciben servicio: en concurrencia 8, cada una obtiene 90 HTTP 200 y 90 HTTP 429. La distribución observada no garantiza equidad con tráfico adversario. Tras SIGKILL con temporal observado: **OOMKilled=false**, archivo válido previo con SHA-256 idéntico, vídeo incompleto **404**, **cero temporales** y salud correcta al reiniciar.

[Resultados versionados](evidence/phase-04-soak-results.json): resumen/fases obtenidos de anotaciones de Actions. La serie completa de muestras está en `soak-results.json`, artifact `docker-synthetic-results` del run. También pasan build, smoke de sesiones/permisos/reinicio y los 15 casos de límites/concurrencia/descarga de fase 0.3 bajo las nuevas cuotas ([JSON de capacidad](evidence/phase-04-resource-results.json)); no se atribuyen a esta fase los recuentos históricos de admisión anteriores.


- Nuevas regresiones: dos POST simultáneos con la misma clave, contenido distinto 409, reinicio y una sola foto; aislamiento A/B; quotas usuario/empresa/global y liberación por aborto.
- Chromium: 429 y reintento con misma clave; pérdida real de respuesta tras commit y una sola foto; destino congelado; cambio de cuenta rechazado; progreso visible; cancelación en cola/activa; 413; etiquetas hostiles inertes.
- La batería conserva H01/H02/H03, SMTP simulado, recuperación y sesiones de fases anteriores. Las pruebas no envían correos ni conectan proveedores reales.
- `npm audit`: **0** vulnerabilidades en todas las severidades; [JSON](evidence/phase-04-npm-audit.json). La CI mantiene bloqueo ante cualquier hallazgo.
- Primer run de `959400a`: Node 22/24 y límites Docker correctos; el cliente sostenido generado tenía un error de sintaxis en el seed JSON y no llegó a cargar la aplicación. Esta permaneció activa sin OOM. [Evidencia del fallo del harness](evidence/phase-04-initial-harness-failure.json). Se corrigió en `80cfcb3` y se validaron los cinco bloques generados. No se presenta aquel ensayo como carga ejecutada.

El ensayo sostenido de `scripts/test-soak.mjs` planifica tres fases de 60 s a concurrencia 1/2/8, con cuatro agencias de dos empresas. Cuerpos sintéticos de 256 KiB, 8 MiB y 120 MiB, cadencia de al menos un segundo por lote, rechazos esperados 429/413, cancelaciones intencionales y acceso cruzado esperado 403. Es carga controlada, no un soak de horas ni un benchmark comercial. Los MP4 grandes son fixtures de cabecera, no vídeos decodificables. La latencia incluye las respuestas rápidas 429: revisar las cantidades por estado junto con percentiles.

Se muestrea el cgroup cada ~1 s: memory.current/peak/max, anon, RSS, swap y CPU usage_usec. CPU es porcentaje de un núcleo obtenido de deltas y tiempo real, incluyendo pequeños sondeos docker exec; no consumo del cliente separado. memory.peak incluye caché y puede sobrepasar transitoriamente el máximo durante reclaim del kernel; RSS/anon son muestras, no máximos continuos. Se registran salud, latencias p50/p95/p99/max, resultados por empresa y errores inesperados. El archivo de artifact incluye la serie de muestras completa.

Al terminar la carga, se fuerza SIGKILL con un temporal realmente observado, se reinicia y se verifica: archivo anterior intacto por SHA-256, vídeo incompleto 404, cero temporales, contenedor sano y OOMKilled falso. La salida 137 de esa interrupción **es intencional**, no se interpreta como OOM. Las pruebas Docker anteriores verifican además la continuidad/revocación de sesiones y el vídeo completo de 120 MiB tras restart.

## Configuración preparada y comprobaciones externas pendientes

`node scripts/prepare-staging.mjs /tmp/DIRECTORIO_NUEVO` genera exclusivamente archivos privados locales: env sintético 0600, Compose y referencia manual de EasyPanel. Un proyecto UUID, volumen nuevo independiente, una réplica, actualización stop-first, un proceso Node 22, 1 CPU/256 MiB sin swap, 128 PIDs, raíz readonly y tmpfs /tmp de 32 MiB. Sin puertos, red `none`, dominio reservado `.example.invalid`, sin auto-deploy ni servicios externos. El Compose se valida mediante `docker compose config --quiet`; no se ejecuta `up` ni se crea volumen/servicio en Hostinger. El JSON no se presenta como payload de la API de EasyPanel.

Para una futura autorización, revisar [staging-checklist.md](staging-checklist.md): dominio nuevo y TLS válido/renovación; perímetro sobre todas las rutas, incluidos archivos y vendor; cabeceras de proxy sobrescritas; red exclusiva sin producción, puerto solo interno, egress y límites reales de Swarm; volumen nuevo UID/GID 1000; espacio para originales + hasta 480 MiB de temporales activos globales + backup + restauración; secreto sintético estable entre reinicios; backup externo/restore a destino nuevo; sesiones nuevas tras recuperación; fotos ambiguas sin asignar. Estas comprobaciones necesitan el entorno nuevo y siguen pendientes. No se han inspeccionado ni modificado dominios, redes o volúmenes existentes.

## Archivos modificados y commits

| Archivo | Cambio |
|---|---|
| `lib/upload-client.js` | Cola y panel DOM, XHR/progreso, cancelar, reintentar/descartar, límites de retención y cuenta original |
| `index.html` | Integra fotos, portadas, medios/reel; congela destino y elimina avisos de guardado prematuros |
| `lib/binary-transfer.mjs` | SHA-256 incremental y por archivo; cuotas activas por usuario/empresa además del máximo global |
| `server.mjs` | Vendor local, Retry-After, idempotencia de fotos y comprobación de cuenta de la tarea; autorización anterior conservada |
| `scripts/test-soak.mjs` | Carga sostenida aislada, CPU/memoria/latencia/salud e interrupción con recuperación |
| `scripts/prepare-staging.mjs`, `deploy/staging.compose.yml` | Una réplica/stop-first explícitos y plan manual con recursos y recuperación pendientes |
| `tests/phase-04.test.mjs`, `tests/uploads-browser.test.mjs` | Nuevas regresiones de backend y Chromium |
| `tests/html-policy.test.mjs`, `tests/staging.test.mjs` | Incluye script nuevo en el control de sinks y valida el plan de staging |
| `package.json`, `.github/workflows/ci.yml` | Check sintáctico del cliente, carga sostenida en Docker y artifacts |
| `docs/security/*`, `README.md` | Informe, métricas/evidencias, checklist y estado GitHub |

`959400a`: primera implementación, UX/cuotas/idempotencia y harness sostenido. `80cfcb3`: corrección del seed generado y protección ante cambio de cuenta. El commit de documentación final conserva resultados por SHA; la descripción de PR enlaza el último HEAD y sus checks. No se cambia package-lock/dependencias porque no hay paquetes añadidos ni actualizados.

## Riesgos abiertos y condiciones de aceptación

- Una sola réplica/proceso sigue siendo obligatoria: cachés/sesiones/locks/contadores/limpieza no están coordinados entre instancias. Sin rolling update con solapamiento.
- Carga acotada de tres minutos no acredita ausencia de fugas a largo plazo ni capacidad comercial; revisar crecimiento de RSS y repetir soak prolongado en el staging autorizado.
- Pendientes cuotas de disco/tasa persistentes y versionado de escrituras; cancelación no equivale a rollback de un commit terminado.
- El contenido solo se valida por firmas/tamaño, sin antivirus/decodificación completa. HTTP Range y reels reales grandes en navegador/proxy de staging pendientes.
- TLS, DNS, Traefik, redes, egress, recursos/Swarm, volumen y recuperación externa reales pendientes; no se sustituye su comprobación por la fixture HTTPS local.
- El builder local tenía un bloqueo DNS de npm en fase 0.3; el build válido de esta fase debe acreditarse con el run conectado de Actions. No se afirma haber reparado esa conectividad local.

**Recomendación: sí, es razonable autorizar el primer staging aislado y cerrado con datos sintéticos**, sujeto a revisión del diff y verificación previa de las puertas operativas de la checklist. La CI del código medido está verde y la carga acotada no presenta fallos inesperados, OOM ni residuos. El aumento de RSS, el alcance de tres minutos y las cuotas persistentes ausentes impiden extrapolar estos resultados a producción o tráfico abierto. La autorización futura debe limitarse a proyecto/volumen/red/dominio nuevos con datos sintéticos y perímetro cerrado. No autorizar producción, fusión ni datos reales con esta fase.
