# Staging controlado · fase 0.1

Documento de preparación; no autoriza integración ni operación sobre producción. No se ha accedido a Hostinger/EasyPanel ni a datos reales.

## Ensayo reproducible en Docker, sin servicios externos

```sh
docker build --pull -t ruano-staging-check .
node scripts/test-docker.mjs ruano-staging-check
```

El script crea nombres UUID, contenedor y volumen desechables propios. No publica puertos ni usa bind mounts. `--network none` impide conexión a Hostinger, redes privadas, DNS externo y proveedores. Solo hace peticiones loopback desde `docker exec`. Usa credenciales sintéticas, elimina exclusivamente sus recursos propios y genera `artifacts/docker-results.json`.

Comprueba Node 22, UID 1000, filesystem raíz de solo lectura, escritura en el volumen, cookie Secure/HttpOnly, autenticación, guardado, subida de foto, healthcheck y persistencia de estado/bytes tras `docker restart`. Esto es una prueba de contenedor, no un despliegue. No acredita TLS del dominio, SMTP remoto, Meta o Google.

`deploy/staging.compose.yml` ofrece una configuración equivalente para un ensayo manual prolongado: ningún puerto publicado, ninguna red externa y volumen nuevo `synthetic-data` dentro de un proyecto independiente. Requiere variables `STAGING_APP_*` sintéticas; no lee secretos de producción. No reutilizar nombres de proyectos/volúmenes existentes. No ejecutar `down -v` contra proyectos ajenos. No se ha iniciado este Compose en Hostinger.

## Configuración propuesta para EasyPanel/Hostinger (sin aplicar)

- [ ] Crear un proyecto **nuevo** de staging. Usar el commit revisado de la rama de seguridad, construcción Dockerfile y una sola réplica (JSON/bloqueos son de un proceso).
- [ ] Aplicación `node server.mjs`, usuario `node` (UID 1000), puerto interno 3000; healthcheck `/health`. No exponer el puerto del host directamente a Internet.
- [ ] Volumen **nuevo y vacío**, exclusivo de staging, en `/app/data`, escribible por UID/GID 1000. No montar rutas o snapshots de producción; usar dataset sintético preparado para el ensayo.
- [ ] Variables propias de staging: `NODE_ENV=production`, `DATA_DIR=/app/data`, `PORT=3000`, `PUBLIC_URL=https://<dominio-staging>`, `APP_USERNAME`, `APP_PASSWORD`, `APP_SESSION_SECRET`. Generar valores nuevos sintéticos de staging, sin copiar credenciales existentes ni registrarlos en Git/logs.
- [ ] No configurar claves de IA, Meta, Drive, Telegram ni SMTP reales. Usar simuladores o cuentas sandbox aprobadas en una tarea independiente. Si no hay IA local simulada, `OLLAMA_URL=http://127.0.0.1:1` evita el hostname del VPS de producción.
- [ ] Red del proyecto separada. No adjuntar redes Swarm de producción, bases de datos, sockets Docker ni servicios internos. Para el ensayo aislado mantener `network_mode=none`; la validación web con Traefik necesita una red exclusiva de staging y una revisión explícita posterior.
- [ ] Dominio staging propio con TLS y control de acceso perimetral (VPN/allowlist/autenticación) que cubra también `/w`, `/r`, `/m`, formularios y APIs públicas. El login de la app no protege todas esas rutas públicas.
- [ ] EasyPanel debe conservar la fuente de configuración. No modificar Swarm/Traefik por fuera ni instalar un proxy paralelo. Desactivar integración/despliegue automático de la PR. No cambiar el servicio de producción.
- [ ] Usar raíz read-only y tmpfs `/tmp` cuando el panel lo permita, `cap_drop=ALL`, sin privilegios y límites inicialmente 1 CPU/256 MiB/128 PIDs como en el smoke. Dimensionar fotos/reels en pruebas de carga; esos límites no son una capacidad comercial garantizada.

La configuración real del VPS, disponibilidad de recursos, topología Swarm, volumen, dominio y TLS siguen sin inspeccionar. La referencia adicional `hostinger-context.md` enlazada por la skill no estuvo disponible; no se han inferido datos de infraestructura.

## Recuperación: solo dataset sintético

- [ ] Detener las escrituras de todas las instancias de prueba; registrar imagen, commit y ubicación del volumen sintético.
- [ ] Generar el plan con `scripts/photo-storage.mjs plan`. Revisar `duplicateIds`, `unresolved.reason`, archivos sin referencia, manifests inválidos/incompletos y propietario de cada foto.
- [ ] Verificar independientemente las asignaciones y marcar `ownershipVerified=true` solo tras la revisión. No forzar colisiones, huérfanas ni archivos de procedencia dudosa.
- [ ] Aplicar exclusivamente sobre el dataset sintético, con backup nuevo fuera de DATA_DIR y espacio para original, snapshot, restauración de ensayo y copia nueva.
- [ ] Exigir restauración con hashes antes de la copia. Verificar usuario/permisos del volumen restaurado; si el operador copia como root, preparar la propiedad UID 1000 en el volumen de staging antes de activarlo. No cambiar propiedad de rutas reales.
- [ ] Comparar recuentos/hashes, orden, ajustes y portada. Probar A/B con ID duplicado, fotos públicas y revisión por token. Conservar árbol antiguo sin servicio automático.
- [ ] Conservar una copia externa protegida y verificar restauración desde ella. El ensayo local de la herramienta no demuestra que el soporte externo del VPS funcione.

Ver [procedimiento offline detallado](photo-recovery.md). No reutilizar un rollback que vuelva a exponer el servidor vulnerable original.

## Puerta de salida antes de cualquier operación real

- [ ] PR #3 revisada, aún en borrador hasta decisión de revisión; sin fusión ni despliegue automático.
- [ ] CI Node 22/24 y Docker del **mismo SHA de código** completadas y audit sin hallazgos.
- [ ] Revisar el informe de compatibilidad y límites de la auditoría; no interpretar CI verde como certificación SaaS.
- [ ] Ensayo de Hostinger/EasyPanel, TLS y recuperación externa completado con datos sintéticos.
- [ ] Permisos/credenciales sandbox y pruebas de integraciones si esas funciones se habilitan.
- [ ] Nueva autorización explícita antes de integrar o tocar producción; la presente fase se detiene antes de esos pasos.


## Puerta adicional de fase 0.2

- [ ] Anunciar cierre único de sesiones: cookies antiguas rechazadas; no fallback.
- [ ] DATA_DIR exclusivo y escribible; `sessions.json` 0600, volumen persistente y
  una sola réplica/proceso. Probar logout y reinicio con dos sesiones y empresas.
- [ ] Probar cambio de contraseña, desactivar/reactivar y permisos sin revivir
  cookies; no delegar admin global a una agencia.
- [ ] Confirmar health 503 ante fallo del almacén y no declarar logout exitoso si
  falló su persistencia. No resetear archivos corruptos a ciegas.
- [ ] En recuperaciones usar registro nuevo y conservar metadata anterior privada;
  no reactivar sesiones desde un backup obsoleto.
- [ ] Revisar cuotas 2.000/20, TTL 12 h y límites ajenos a sesiones; no atribuir al
  smoke pequeño capacidad para subidas de vídeo grandes o cargas multiempresa.
- [ ] Revisar [fase 0.2](phase-02.md) y [propuesta de roles](authorization-proposal.md)
  sin migrar usuarios reales automáticamente.

## Fase 0.3: preparación reproducible y puertas operativas

Informe vigente: [phase-03.md](phase-03.md). Los documentos anteriores conservan sus resultados históricos.

### Preparar archivos, sin crear infraestructura

Desde el checkout revisado y Node 22/24:

```sh
node scripts/prepare-staging.mjs /tmp/ruano-staging-review-NUEVO
```

Solo crea un directorio privado nuevo (0700), `synthetic.env` (0600), `compose.yml` y `easypanel-plan.json`. El nombre de proyecto UUID y su volumen son independientes; la contraseña y la clave de sesiones son aleatorias y sintéticas. No imprime sus valores, no lee configuración de producción, no conecta con Docker/EasyPanel/DNS y se niega a sobrescribir un directorio existente. Proteger y conservar ese env para los reinicios; regenerarlo puede invalidar sesiones. No incorporarlo a Git ni copiarlo a esta PR.

El dominio generado termina en `.example.invalid`: es un placeholder reservado, no un dominio provisionado. El JSON de EasyPanel es una **referencia manual**, no un payload para su API. El Compose aislado no tiene puertos ni red y no permite acceso web desde fuera. No ejecutarlo en Hostinger bajo esta autorización.

### Repetir las validaciones aisladas

```sh
npm ci --no-fund
npx playwright install --with-deps chromium
npm run check
npm test
npm audit
node scripts/probe-replicas.mjs
docker build -t ruano-staging-check .
node scripts/test-docker.mjs ruano-staging-check
node scripts/test-resources.mjs ruano-staging-check
```

Repetir `check`/`test`/`audit` con Node 22 y 24, o revisar la matriz del mismo SHA en Actions. El diagnóstico multiinstancia **debe informar que no está soportada**; terminar el diagnóstico no significa que sea seguro escalar. Los ensayos Docker crean y limpian únicamente recursos locales UUID propios. El ensayo de carga usa un cliente desechable en cgroup separado, comparte solo la red loopback sin salida del contenedor de aplicación y escribe `artifacts/resource-results.json` sin cookies/contraseñas. Máximo ensayado: 32 solicitudes simultáneas, cada una de hasta 120 MiB; algunas se rechazan con 429 por admisión. No requiere servicios externos ni proveedores de pago.

### Antes de solicitar una futura creación de staging en EasyPanel

- [ ] CI verde del SHA revisado, informe de carga completo, audit sin hallazgos y PR todavía en borrador. Revisar los fallos originales, no ocultarlos con un nuevo presupuesto.
- [ ] Proyecto nuevo y volumen vacío con nombres independientes; comprobar disponibilidad de los nombres en la futura tarea autorizada, sin tocar ni reutilizar proyectos, redes o volúmenes existentes.
- [ ] Una réplica, un proceso Node 22, 1 CPU, 256 MiB RAM y swap desactivado según resultados de la carga. En Swarm/EasyPanel comprobar el límite real aplicado en runtime; no asumir que `memswap_limit` de Compose se traduce automáticamente. No hacer actualizaciones con dos tareas superpuestas sobre el volumen.
- [ ] UID/GID 1000 y volumen persistente `/app/data`; filesystem raíz read-only, tmpfs `/tmp` de 32 MiB, sin capabilities/privilegios, 128 PIDs. Verificar que la versión del panel admite estos controles; cualquier desviación exige revisión.
- [ ] Puerto interno 3000, ningún puerto publicado directamente en el host. Red nueva exclusiva de staging para el proxy; ningún acceso a red privada, servicios, datos o sockets de producción. Verificar egress y acceso desde/hacia otros proyectos.
- [ ] Subdominio nuevo autorizado, TLS válido con renovación comprobada, HTTP redirigido a HTTPS y autenticación/allowlist perimetral en **todas** las rutas, incluidas las públicas y archivos firmados. Health interno puede usar loopback sin atravesar el perímetro.
- [ ] Proxy sobrescribe cabeceras reenviadas, no confía en valores del cliente; `PUBLIC_URL` coincide exactamente con el origen HTTPS nuevo. No usar el placeholder `.invalid` como dominio real ni desactivar validación TLS para pasar una prueba.
- [ ] Secretos solo sintéticos propios, mismo `APP_SESSION_SECRET` tras restart, integraciones reales ausentes; `OLLAMA_URL=http://127.0.0.1:1` mientras no exista un simulador autorizado. No copiar `.env` de producción.
- [ ] Dataset ficticio con dos empresas y usuarios independientes, ID de inmueble duplicado, huérfana y plan ambiguo. Backup fuera de DATA_DIR, restauración nueva verificada con hashes antes de copiar; originales conservados, ambiguas sin asignación.
- [ ] Probar login/logout y reinicio con una sesión activa y otra revocada; archivos válidos y hashes conservados; temporales no servibles y eliminados. La recuperación operativa empieza con sesiones nuevas, sin revivir registros obsoletos.
- [ ] Probar en el entorno nuevo subida/descarga de un reel reproducible, límites exactos/+1 byte, 429 y reintento manual; vigilar memoria, disco y salud. Registrar métricas y capacidad disponible del VPS nuevo sin cargas sobre producción.
- [ ] Backup externo protegido del staging y restauración a volumen nuevo ensayados; presupuesto de disco para originales + temporales + snapshot + restauración + copia. Cero recolección o migración de fotografías reales en esta fase.
- [ ] Sin auto-deploy de rama/PR, sin fusión y sin operación de producción. Obtener autorización expresa para crear infraestructura real antes de aplicar esta preparación.

## Puerta de fase 0.4: UX, cuotas y estabilidad

Referencia vigente: [phase-04.md](phase-04.md). Las métricas anteriores conservan el SHA que las produjo.

- [ ] Revisar el commit de código, informe sostenido y CI final Node 22/24, Chromium, audit y Docker. No considerar un fallo del generador de carga como una prueba ejecutada satisfactoriamente.
- [ ] Probar panel de subidas: cola, progreso, espera de confirmación, 429 + Retry-After, reintento sin duplicados, desconexión después de guardar, cancelación y 413. Revisar que cambiar de empresa no altera el destino y cambiar de cuenta impide reintentar la tarea antigua.
- [ ] Informar que recargar/cerrar el navegador pierde archivos pendientes en memoria; cancelar no deshace un commit que ya terminó. Confirmar en la galería antes de una selección nueva. Un reintento de la misma tarea conserva clave y blob.
- [ ] Aceptar cuotas activas: global 4, usuario 2 y empresa 3; observar 429 y reintentos con dos pestañas. No confundir concurrencia con cuotas de disco, rate limiting o reparto justo garantizado.
- [ ] Limitar el dataset sintético y vigilar disco. Reservar originales, hasta 480 MiB de temporales activos globales, snapshot y restauración de ensayo. No hay cuota persistente de disco por usuario/empresa ni atribución histórica de autor implantada.
- [ ] Generar **otro directorio nuevo** con `scripts/prepare-staging.mjs`, conservar env 0600 sin Git/logs, validar `docker compose -f <nuevo>/compose.yml config --quiet`. Este comando no autoriza `up` ni crea infraestructura.
- [ ] Referencia manual EasyPanel: una réplica/proceso, actualización stop-first, sin auto-deploy, 1 CPU/256 MiB y swap desactivado realmente comprobados, UID/GID 1000, volumen nuevo, raíz readonly y tmpfs; no importar el Compose aislado como si fuera una definición Swarm validada.
- [ ] Antes de habilitar acceso, validar dominio/TLS/renovación y perímetro sobre **todas** las rutas; puerto solo interno, red nueva y sin producción, egress restringido, proxy sobrescribe cabeceras. Ningún proveedor real.
- [ ] Ensayar SIGKILL durante una subida sintética, reinicio, SHA-256 del archivo previo, 404 del incompleto, cero temporales y sesiones/revocaciones persistentes. Una salida 137 inducida no debe etiquetarse OOM si OOMKilled es falso.
- [ ] Repetir carga sostenida más larga y un reel reproducible sobre el proxy real del nuevo staging; registrar CPU, memoria, disco, latencia, estados HTTP y salud. Definir monitorización y parada ante poco disco o inestabilidad antes de exponerlo.
- [ ] Backup/restauración externos verificados, sesiones nuevas tras recuperación y fotos ambiguas sin reasignar. No copiar fotografías ni snapshots reales al ensayo.
- [ ] PR #3 sigue en borrador. Una decisión explícita y separada debe autorizar únicamente el primer staging aislado; no main, fusión, publicación ni producción.


### Evidencias automáticas de fase 0.4

- [x] Código `80cfcb3`: CI Node 22/24 y Docker verdes, 72/72 pruebas por runtime; audit 0.
- [x] 181,30 s de carga sintética, 526 subidas, 0 fallos inesperados, 158 health HTTP 200; cancelaciones/excesos y cuotas observados.
- [x] Interrupción SIGKILL con temporal observado, recuperación del archivo previo por SHA-256, incompleto 404, cero temporales y OOMKilled falso.
- [x] Configuración generada validada con Compose sin iniciar servicios ni volúmenes; proyecto y env sintéticos independientes.
- [ ] Revisar crecimiento de RSS y repetir soak prolongado en el nuevo staging; los tres minutos de CI no descartan fugas.
- [ ] Verificar que el proxy no introduce buffering ilimitado de subidas/descargas y que límites de tamaño/timeout conservan los 120 MiB permitidos sin aumentar recursos para ocultar fallos.

Los checks del HEAD de documentación se enlazan en la PR. Ninguna casilla automática da por verificados TLS, DNS, egress, volúmenes, recursos Swarm ni backups externos reales.

## Puerta final de fase 0.5

Plan de parámetros: [deploy/easypanel-staging.md](../../deploy/easypanel-staging.md).
Informe vigente: [phase-05.md](phase-05.md).

- [ ] Commit revisado y base de Node fijados a los SHA/digest efectivamente probados; revisar build e imagen, no solo rama/etiqueta.
- [ ] Bundle privado nuevo, validación de Compose sin `up`, `synthetic.env` y `perimeter.env` distintos 0600. El plan no crea DNS, red, volumen o servicio ni demuestra disponibilidad de nombres.
- [ ] Revisar ensayo largo, crecimiento/pendiente de RSS, reposo y disco. No equiparar meseta de minutos con ausencia de fugas ni cuota activa con cuota de almacenamiento.
- [ ] Backup offline en volumen nuevo, restauración exacta por SHA-256 en otro nuevo, negativo de corrupción y rechazo de destinos existentes; sesiones obsoletas archivadas fuera del DATA_DIR restaurado; cookie antigua 401 y A/B revalidados.
- [ ] Dominio nuevo confirmado; TLS/renovación, perímetro de todas las rutas y límite de cuerpo/timeout/buffering del proxy verificados antes de acceso.
- [ ] **Antes de crear**: confirmar que el panel permite red exclusiva sin conectar ni siquiera temporalmente a una overlay de producción. Si necesita cambiar el proxy o una red global existente, detenerse; esta autorización no cubre ese cambio.
- [ ] Verificar cómo se garantiza swap desactivado en la tarea Swarm; no asumir que `memswap_limit` de Compose se aplica. Sin swapoff/sysctl global o ampliación de RAM para pasar pruebas.
- [ ] Confirmar capacidad libre real y límites aplicables sin afectar servicios existentes; el mismo VPS comparte kernel/CPU/disco. Presupuesto sintético 1 GiB (operativo, no cuota), alertar al 70 %, suspender nuevas pruebas al 80 %, al menos 8 GiB libres para ensayos y copias.
- [ ] Backup fuera del host protegido y restore real del nuevo staging antes de uso sostenido; fijar RPO/RTO/retención. No presentar los volúmenes de CI como copia externa operativa.
- [ ] La autorización posterior debe nombrar proyecto/servicio/FQDN/red/volumen nuevos y su rollback; excluir main, merge, producción, servicios existentes, cambios globales, datos/credenciales reales y recursos de pago. Si no se puede satisfacer esa matriz, **no crear**.

### Resultado de validación 0.5: bloqueado

- [x] 75/75 regresiones Node 22 y 24, Chromium y auditoría npm 0; configuración sintética generada y validada sin crear infraestructura.
- [x] Backup/restore sintéticos correctos en el corto `13ed3c0`: inventario idéntico, corrupción rechazada, sesiones antiguas 401 y A/B revalidados.
- [ ] **Cerrar F05-MEM-01 antes de autorizar creación real:** OOM en `d64e947` tanto en corto (150 s observados) como ampliado (883 s), 256 MiB sin swap. Un check posterior verde no cierra estos fallos.
- [ ] Medir fuera del cgroup y aislar memoria de aplicación, caché/kernel y sondeos; repetir con presupuesto idéntico y conservar evidencia de fallos. No aumentar RAM para ocultarlos.
- [ ] No atribuir a los runs interrumpidos reposo, limpieza final o restauración que no llegaron a ejecutar. Revisar el informe y las trazas originales.

La autorización de creación real sigue **no recomendada**. El siguiente paso es diagnóstico sintético de memoria y comprobación autorizada de capacidades del panel; no crear servicios para sortear un bloqueo ni modificar otros existentes.
