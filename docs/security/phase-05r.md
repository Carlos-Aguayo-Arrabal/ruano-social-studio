# Fase 0.5R · OOM a 256 MiB · 25/10/2026

Rama independiente `security/phase-05r-oom`, desde `dd97f34`. PR [#5](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/5) en borrador **hacia la rama de seguridad**, sin fusionar. Main y PR #3 no se modifican. Sin producción, EasyPanel/Hostinger, staging real, datos/credenciales de clientes, compras ni publicación de imágenes.

## Alcance y método

Se revisan las trazas de 150,046 y 883,351 s de fase 0.5. Se reproduce con el mismo guion, base Node `node@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`, 1 CPU, 256 MiB, `--memory-swap 256m` (swap desactivado), PIDs 128, raíz readonly, tmpfs 32 MiB, red none y volumen/secretos UUID sintéticos nuevos. Cliente separado de 512 MiB sin swap; ningún puerto publicado. Son tres ejecuciones independientes, no réplicas compartiendo datos.

`scripts/test-soak-phase05-original.mjs` conserva **byte por byte** el guion de `dd97f34`: SHA-256 `ad244b9a9243786057feb74059453007aaf0c73fa6c7b642b8c2eeb40b983eda`. La primera reproducción usa el código anterior a la corrección, sin activar la telemetría del proceso. Coinciden configuración efectiva, rutas, límites, cuotas y algoritmo de fixtures. Los secretos/UUID son nuevos; no se pretende clonar la máquina física/kernel/hardware de un runner histórico. La imagen diagnóstica contiene un preload inactivo en ese caso; no se cambia el comando efectivo del servidor ni su heap.

Comparativas instrumentadas: observación original dentro del cgroup y lectura desde el host fuera del cgroup. `process.memoryUsage()` se obtiene con preload **opt-in** que escribe un gauge privado 0600 de 1.024 bytes, reutiliza su buffer y no crea endpoints. Campos: RSS, heapUsed/heapTotal, external, arrayBuffers, fecha y uptime, sin payloads, tokens ni env. No se fuerza GC ni cambia max-old-space-size. El módulo no está activado por defecto.

El observador externo lee únicamente el PID/cgroup del contenedor propio. Las comprobaciones de disco corren en un helper readonly separado de hasta 64 MiB; no se mueve trabajo de negocio fuera del presupuesto de aplicación. Se registra memory.current/peak/max/stat/events, CPU, swap, páginas sucias/writeback, sockets y eventos Docker oom/die. Los helpers de backup/restore también tienen 256 MiB sin swap y se observan aparte.

## Evidencia previa y aislamiento

| Caso | Resultado | Heap máximo muestreado | Memoria sucia máxima muestreada |
|---|---|---:|---:|
| Guion original, sin corrección | **OOMKilled=true, salida 137** | No instrumentado para preservar el caso original | No desglosado en aquel guion |
| Sin corrección, mixto, observador host | Correcto en esa corrida | ~14,4 MiB | ~202 MiB |
| Sin corrección, vídeos continuos, observador host | Correcto en esa corrida | ~14,2 MiB | ~170,8 MiB |
| Corregido, vídeos continuos, observador host | Correcto | ~16,8 MiB | ~13,6 MiB |
| Corregido, sesiones sin subidas durante carga | Correcto | ~14,9 MiB | 12 KiB |

Reproducción: [40221280417](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40221280417). Los dos casos instrumentados cortos del código anterior pasaron, mientras el caso original falló: se conserva la intermitencia, no se declara resuelto por escoger un verde. [Control de vídeos con escritor anterior 40222009598](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40222009598) usa `lib/binary-transfer.mjs` del commit revisado `72d4853`, recuperado explícitamente en el runner; resto de configuración/telemetría y tráfico coinciden con el control corregido [40221834220](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40221834220). No se trata esa imagen de control como candidata desplegable.

El control de sesiones ejerció 671 llamadas autenticadas y 21 rotaciones logout/login en tres minutos: cookies revocadas 401, nuevas válidas, sin OOM; memoria del cgroup máxima ~43,5 MiB. Descarta que ese patrón de sesiones sea por sí solo el origen observado, no prueba toda carga imaginable de usuarios.

Las comparaciones de vídeo mantienen 120 MiB, concurrencia progresiva 1/2/8, cuatro usuarios/dos empresas y cuotas 4 global/2 usuario/3 empresa. El control continuo cambia solo la frecuencia de vídeos para aislar escritura; se distingue del guion mixto de reproducción estricta. No se usan vídeos/fotos reales; fixtures binarios con cabecera válida, no ensayos de decodificación.

## Mecanismo y corrección

El flujo JS ya tenía backpressure, pero `createWriteStream` confirmaba escrituras cuando el kernel las aceptaba: eso no imponía un techo a las páginas de archivo **sucias**, todavía no persistidas. A varios escritores activos, esas páginas ocupaban la mayor parte de un cgroup de 256 MiB mientras heap y buffers del proceso eran mucho menores. La caché limpia es reclamable; dirty/writeback no es equivalente a memoria libre inmediata. Este es el componente de presión demostrado por las métricas y reducido por la intervención.

La corrección de `lib/binary-transfer.mjs` sustituye únicamente el sink por `lib/bounded-file-writer.mjs`:

- Cola JS de 64 KiB; escrituras secuenciales, incluyendo writes parciales.
- Como máximo 4 MiB por archivo pendientes de `fdatasync`; no se acepta la siguiente ventana hasta completarlo. Cuatro receptores admitidos implican ~16 MiB de datos de usuario sin sincronizar, además de metadatos/buffers pequeños. No es un límite del total de page cache del kernel.
- Sincroniza la última ventana y cierra antes de devolver éxito. Renombrado/manifests/autorización siguen en los mismos handlers/locks. No se cambian URLs, IDs, contenido, formatos o cuotas; no se leen ni reescriben archivos existentes para aplicar el cambio.
- Un error de write/sync rechaza la operación; el temporal se cierra/elimina y no se confirma ni sustituye el archivo válido previo. Abortos usan el mismo cleanup; no hay flush global, drop_caches, sysctl o cambio de swap.

En el control continuo, `file_dirty` bajó de **179.048.448** a **14.245.888 bytes**, y writeback máximo de 63.737.856 a 16.777.216 bytes. La caché total de archivos siguió pudiendo crecer cerca del límite: el objetivo es hacerla reclamable, no vaciarla artificialmente. Heap/external/arrayBuffers no muestran un crecimiento proporcional al volumen total transferido en esas ventanas. Hay calentamiento, buffers transitorios y asignaciones nativas; no se afirma ausencia universal de fugas ni se asigna todo RSS a JS.

La causalidad se apoya en reproducción, desglose de memoria, control de I/O y efecto acotado del cambio. La captura histórica no identifica la página/asignación exacta del instante del OOM; el sondeo dentro del contenedor puede influir, por eso hay observación externa y se exige pasar también el guion original con sus sondeos. No se concluye que bastara cambiar de observador.

## Regresiones y aceptación

Regresiones locales: Node 22.23.4 y 24.19.0, **78/78 por runtime**, incluidas las **75 existentes**, Chromium, aislamiento de empresas, cookies/revocación, foto idempotente, 429/413, cancelaciones y SMTP sintético. Nuevas pruebas: gauge privado/acotado, writer con writes parciales/límite de pendiente y error de sincronización que no se acepta como éxito. `npm audit`: 0 vulnerabilidades conocidas; no se añaden dependencias.

Aceptación ampliada en ejecución: [40222558069](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40222558069), commit `8e93d85`. Tres runs previstos de 15 min activos + 2 min de reposo: guion original y dos instrumentados host independientes. Se incorporan abajo resultados reales al terminar; no se atribuye éxito a la preparación.

Todos conservan 256 MiB/swap 0/1 CPU, mismas cuotas y límites 4/8/120 MiB. Se comprueban 413/429, salud, hashes, incompletos 404, cleanup tras SIGKILL/reinicio y restauración independiente con A/B y sesiones viejas 401. Un die por SIGKILL intencional no es OOM; el observador distingue eventos y flags.

## Compatibilidad, límites y rollback

El coste añadido es sincronizar incrementalmente: puede aumentar latencia o limitar throughput si el almacenamiento es lento, en vez de dejar que la ingesta agote memoria. Los errores de disco/sync se propagan; no se ignoran para aparentar éxito. La persistencia de datos mejora, pero no se promete atomicidad frente a fallo eléctrico de todo el conjunto rename/directorio/manifest ni se sustituye un backup.

Sin migración de fotos/usuarios/sesiones ni modificación del modelo multiempresa. Sigue siendo un proceso/réplica. No se resuelven aquí cuotas acumuladas de disco, JSON concurrente/rate limiting, mapas de otros endpoints, conexiones ilimitadas, providers reales, AV/decodificación ni HTTP Range. Esos riesgos de fases previas y los requisitos reales de TLS/red/swap/volumen/backup de EasyPanel siguen abiertos.

No se ha demostrado un mínimo de RAM universal: 256 MiB es el presupuesto probado, no se ensayan límites inferiores ni se dimensiona capacidad comercial. El caché limpio puede ocupar memoria disponible y `memory.peak` exceder transitoriamente `memory.max` durante reclaim del kernel; se publican los valores, sin cambiar el límite. No sumar máximos no simultáneos de RSS, anon/file ni confundir `memory.events.max` con `oom_kill`.

Rollback de código solo en la rama de trabajo: revertir el sink/cambio del escritor recuperaría el comportamiento anterior y su riesgo OOM. No hay rollback automático de producción ni borrado de datos. No recomendar la versión anterior para uso abierto. Esta PR debe revisarse antes de cualquier integración; no se fusiona ni se crea staging con esta fase.

## Archivos, evidencia y commits

- `72d4853`: reproducción/telemetría; `d297e98`: escritor con writeback acotado, pruebas y controles; `fcb5103`: obtención del commit de control; `8e93d85`: aceptación repetida y métricas de recuperación/eventos.
- `lib/bounded-file-writer.mjs`, `lib/binary-transfer.mjs`: única corrección del camino de negocio.
- `lib/oom-telemetry.mjs`, `scripts/container-memory.mjs`, `scripts/container-events.mjs`: medición privada, opt-in y acotada.
- `scripts/test-soak.mjs`, `scripts/test-soak-phase05-original.mjs`: controles/aceptación y original preservado.
- `scripts/summarize-oom-profile.mjs`, `.github/workflows/oom-investigation.yml`: comparación/ensayos y resúmenes de artifacts.
- `tests/bounded-writer.test.mjs`, `tests/oom-telemetry.test.mjs`: regresiones nuevas.
- Este informe y `docs/security/evidence/phase-05r-*.json`: resultados por SHA/run. La PR enlaza el HEAD y sus checks posteriores de documentación.

El primer intento de construir el control con checkout superficial no tenía el objeto Git necesario: falló antes de la carga. Se corrigió con fetch del único commit revisado; ese fallo de harness no se cuenta como reproducción OOM. Los negativos originales se conservan como tales, no se convierten en aceptación verde.
