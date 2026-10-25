# Fase 0.3 · staging aislado y consumo de memoria · 25/10/2026

Rama `security/phase-0-2026-10-24`, PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) en borrador. Sin fusión, despliegue, acceso a Hostinger, dominios/volúmenes existentes, datos de clientes ni credenciales de aplicación reales. Las imágenes de ensayo no se publican en ningún registro.

## Fallo original y causa verificada

Con `ca84afd`, el [ensayo PR 40126051337](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40126051337) mató el contenedor al recibir un MP4 sintético permitido de **125.829.120 bytes (120 MiB)**: `OOMKilled=true`, salida **137**, error cliente `UND_ERR_SOCKET` a los **689 ms**. Una réplica, 1 CPU, **268.435.456 bytes de memoria**, `--memory-swap 256m` (swap desactivado), red `none`. [Evidencia original](evidence/phase-03-original-oom.json).

El ensayo anterior `519d8e1` pasó con el mismo límite de RAM, pero no había desactivado swap: no demostraba que 256 MiB sin swap fueran suficientes. No se usa para certificar ese presupuesto.

Localización del problema:

- Recepción: `server.mjs::readRaw` almacenaba cada chunk en un array y al finalizar ejecutaba `Buffer.concat(chunks)`. Los bytes completos y su copia podían coexistir. `handleMeta` lo utilizaba con hasta 120 MiB; `handlePhotos` con hasta 4 MiB.
- Persistencia: `writeFile` recibía ese buffer completo. No se realizaba transcodificación en el servidor; la creación de reels sigue en el navegador.
- Descarga: `handleMeta`, `handlePublicMedia`, `handlePhotos`, `sendCover` y las fotografías de `handleWeb` utilizaban `readFile` antes de responder. Un vídeo completo por petición, agravado por descargas simultáneas.

## Cambios y compatibilidad

| Archivo | Modificación y razón |
|---|---|
| `lib/binary-transfer.mjs` | Recepción con backpressure a temporal aleatorio privado 0600; contador de bytes y cabecera de 16 bytes; máximo cuatro receptores activos; 429 al superar admisión. Descarga desde descriptor abierto con stream y Content-Length, sin buffer completo. Limpieza de error/aborto y de temporales interrumpidos al arrancar |
| `server.mjs` | Integra streaming después de autorización; conserva aislamiento `brandId`, manifests y firmas públicas. Renombra al nombre final solo tras completar y validar. Serializa reemplazos JPG/MP4 del mismo recurso. Mantiene archivos anteriores ante petición inválida |
| `scripts/test-resources.mjs` | Contenedor de aplicación de 256 MiB sin swap y cliente en cgroup separado; tamaños exactos y +1 byte, concurrencia progresiva, descargas, memoria, salud, reinicio, hashes y recuento de temporales |
| `tests/binary-transfer.test.mjs` | Límites, formatos, chunks separados, abortos, admisión, limpieza sin seguir symlinks, reemplazos concurrentes, permisos A/B, HTTP 413, conservación y reinicio |
| `tests/phase-01.test.mjs` | La regresión de exceso de tamaño exige ahora HTTP 413 en lugar de una desconexión de socket |
| `tests/migration.test.mjs` | Un plan manipulado tampoco puede forzar la asignación de un directorio con propietario ambiguo |
| `scripts/prepare-staging.mjs`, `tests/staging.test.mjs` | Generador exclusivamente local con secretos sintéticos, proyectos y volúmenes independientes; prueba TLS con CA sintética confiada, rechazo de hostname incorrecto, perímetro y Origin |
| `scripts/probe-replicas.mjs` | Diagnóstico negativo con dos procesos y datos sintéticos; deja evidencia de que varias réplicas NO están soportadas |
| `.github/workflows/ci.yml` | Ejecuta el diagnóstico y la carga Docker; conserva informes JSON y auditorías como artifacts |
| `deploy/staging.compose.yml`, `.gitignore` | Presupuesto sin swap explícito; los archivos `synthetic.env` no pueden añadirse accidentalmente a Git |
| `docs/security/*`, `README.md` | Evidencias, procedimiento y condiciones para staging; fases anteriores conservadas como histórico |

Límites conservados: fotos/portadas **4 MiB**, JPG de publicaciones **8 MiB**, MP4 **120 MiB**, posiciones 0–19. JPG/WebP/MP4 se identifican por firmas como antes; JPG requiere cabecera JPEG completa de tres bytes. Esto no es un antivirus ni una validación/decodificación completa del contenido. Los fixtures grandes son bytes sintéticos con cabecera válida, no vídeos reproducibles de 120 MiB.

No cambian las URLs ni los formatos de respuesta correctos. El frontend conserva la preparación de medios secuencial; hay subidas de fotos/reel/portada en segundo plano cuyo manejo de errores HTTP no es uniforme. El 429 requiere reintento y no se ha añadido una cola automática a la interfaz: revisar lotes grandes y múltiples pestañas en staging antes de afirmar compatibilidad completa bajo saturación. Se añaden 429 por admisión y 413 explícito por exceso. No se cambia el modelo de usuarios ni se invalida de nuevo el formato de sesiones v2. La transición de cookies antiguas sigue en [session-transition.md](session-transition.md). Las descargas siguen sin implementar HTTP Range, como antes.

Un temporal nunca figura en el manifest ni coincide con las rutas de archivos servibles. Se elimina al fallar/abortarse la petición. Ante una terminación forzada, el próximo arranque elimina únicamente nombres reservados `.upload-<32 hex>.tmp` en los árboles de recursos de `photos-v2` y `media`, sin seguir symlinks ni tocar fotografías finales o `photos/` antiguas. Un error de eliminación no se oculta. Esto exige ausencia de otro proceso escritor. El renombrado es atómico en el mismo filesystem; no se promete resistencia de los bytes a pérdida física de alimentación sin un protocolo adicional de fsync para medios.

## Pruebas y evidencia

Código y medición final: `389cba1cd87ae709330797d8d649138f606d33fd`.
[CI de PR 40180292748](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40180292748): **Node 22, Node 24 y Docker correctos**. Los checks del commit posterior de documentación se verifican y enlazan en la PR sin atribuirle mediciones de otro SHA. [Resultados JSON completos de las métricas publicadas](evidence/phase-03-resource-results.json).

**15 casos Docker correctos**: una sola réplica, `memory.max=268435456` comprobado en el cgroup, swap 0, 1 CPU, sin puertos/red externa. Cliente separado de 512 MiB, también sin swap. Ningún incremento del presupuesto de la aplicación.

| Caso | HTTP | Duración observada |
|---|---|---:|
| Foto/portada 4 MiB | 200 | 38 ms |
| Foto/portada 4 MiB + 1 byte | 413 | 36 ms |
| Imagen 8 MiB | 200 | 62 ms |
| Imagen 8 MiB + 1 byte | 413 | 66 ms |
| Vídeo 120 MiB | 200 | 2.833 ms |
| Vídeo 120 MiB + 1 byte | 413 | 778 ms |
| 1 vídeo de 120 MiB | 1 × 200 | 773 ms |
| 2 vídeos simultáneos de 120 MiB | 2 × 200 | 3.219 ms |
| 4 vídeos simultáneos de 120 MiB | 4 × 200 | 4.183 ms |
| 8 solicitudes de vídeo simultáneas | 4 × 200 / 4 × 429 | 4.217 ms |
| 16 solicitudes de vídeo simultáneas | 4 × 200 / 12 × 429 | 4.282 ms |
| 32 solicitudes de vídeo simultáneas | 4 × 200 / 28 × 429 | 4.422 ms |
| 4 descargas simultáneas de 120 MiB | 4 × 200, bytes completos | 2.223 ms |

Primer rechazo por admisión con vídeos: **8 solicitudes concurrentes** en esta progresión; no se afirma haber buscado el primer valor exacto entre 4 y 8. Es protección 429, no caída por memoria. Con imágenes de 256 KiB: 4/4 HTTP 200 en 35 ms; a concurrencia 8, cinco 200 y tres 429 en 29 ms (los slots pueden liberarse mientras llegan solicitudes).

Todos los casos mantienen `running=true`, `OOMKilled=false`; los lotes de vídeo responden `/health` 200 durante las solicitudes. Tras reiniciar: contenedor saludable, vídeo de 125.829.120 bytes con el mismo SHA-256 antes/después (`e849b6d2…e8f4d4c`), 14 archivos/643.043.158 bytes sintéticos y **cero temporales**. El smoke independiente verifica además persistencia de una sesión activa y rechazo de otra revocada tras el reinicio.

Pico acumulado de cgroup registrado: **272.437.248 bytes (259,82 MiB)**, incluidos caché y procesos de sondeo; el máximo configurado y comprobado sigue siendo **256 MiB**. El kernel puede sobrepasarlo transitoriamente durante reclaim, no se elevó el límite ni se activó swap. La subida individual registra pico acumulado de 185.536.512 bytes; las muestras de RSS/anon no son sus máximos continuos. El mayor RSS muestreado fue 96,97 MiB y el mayor anon muestreado 42,14 MiB; no son picos continuos. Consultar el JSON para cada caso. No se necesita ampliar RAM ni habilitar réplicas para superar este ensayo acotado.

- Local Node **22.23.4** y **24.19.0**: **65/65** pruebas, incluido Chromium, sin omisiones; `npm run check` correcto.
- `npm audit`: **0** vulnerabilidades en todas las severidades, 17 dependencias totales según npm. [JSON](evidence/phase-03-npm-audit.json). La CI bloquea cualquier hallazgo; una auditoría no cubre defectos propios de la aplicación.
- `d89e928`: Node 22/24 verdes y build/smoke Docker correctos. El vídeo de 120 MiB pasó en 2.658 ms, sin swap/OOM; +1 byte recibió 413. Dos vídeos simultáneos pasaron. La carga completa falló después: no se declaró éxito. Los avisos por caso superaron el límite de diez notices por step, ocultando el informe final en las anotaciones; la descarga del log desde este entorno devuelve Forbidden. `704f932` publica un único informe completo para poder identificar la causa real.
- `c39421a`: [run 40179978368](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40179978368) identifica el fallo posterior: `docker run exit 137` en el cliente separado al intentar 16 solicitudes; la aplicación permanece activa, `OOMKilled=false`. Cuatro vídeos pasan y ocho dan cuatro 200/cuatro 429, health 200. No se atribuye ese SIGKILL a OOM confirmado del cliente porque entonces se eliminaba automáticamente su contenedor. [Evidencia](evidence/phase-03-client-failure.json). El generador usaba fetch/undici; no se aisló la causa exacta del SIGKILL. Para acotar la producción y retención de cuerpos rechazados, `3d03b7e` usa HTTP nativo con backpressure y cancela generación al recibir respuesta. `e9301e2` conserva el estado de salida/OOM del cliente si falla. Sus recursos no aumentan (512 MiB, ahora sin swap explícito).
- Build local: falla en `npm ci` dentro del builder por `EAI_AGAIN registry.npmjs.org`; no se atribuye éxito al builder local. Los builds de Actions usan conectividad distinta y su resultado se informa por separado.
- Fallos de preparación corregidos: el primer fixture TLS reenvió una cabecera `undefined`; el primer test de aborto destruyó streams antes de registrar listeners, provocando una aserción nativa del runner local. Los fixtures se corrigieron y se repitieron. No se cuentan como vulnerabilidades reproducidas de la aplicación.

Los tiempos son observaciones de un runner compartido, no SLA. `memory.peak` incluye caché de archivos y puede superar transitoriamente el límite durante reclaim del kernel; no equivale al heap ni al RSS. Se registran también memoria anónima, RSS y swap. El proceso cliente tiene cgroup separado: su generación de datos no consume el presupuesto de la aplicación. El uso de `docker exec` para medir introduce una pequeña sobrecarga declarada. Se publica el pico retenido por el cgroup, no se estima a partir de muestras aisladas de RSS.

## Una sola réplica: restricción verificada

`node scripts/probe-replicas.mjs` arranca dos servidores locales con el mismo directorio **sintético** y configuración sintética. B rechaza una sesión nueva de A (401); después de reiniciar B la reconoce (200); tras logout en A, A devuelve 401 pero B todavía acepta la cookie (200). Esto reproduce falta de coherencia entre procesos, no un éxito multiinstancia. El diagnóstico comprueba y publica esa limitación.

**Staging debe usar una sola réplica y un proceso Node.** No usar cluster/PM2 workers, rolling updates con solapamiento, segunda instancia sobre el mismo volumen ni autoscaling. Archivos JSON, cachés, locks y tareas periódicas también son locales al proceso. El renombrado atómico no resuelve esa coordinación. Para escalar hace falta un almacén transaccional compartido, revocación consistente, exclusión distribuida y coordinación de jobs: propuesta para otra fase, sin migración automática.

## Fotos y recuperación

Se revisaron [phase-01.md](phase-01.md), [phase-02.md](phase-02.md), [session-transition.md](session-transition.md), [photo-recovery.md](photo-recovery.md) y [staging-checklist.md](staging-checklist.md). La herramienta mantiene colisiones, huérfanas y propiedad dudosa en `unresolved`. La nueva prueba demuestra que añadir manualmente una asignación ambigua al plan también se rechaza **antes de la copia**. Se conserva el ensayo de backup completo, restauración con SHA-256, copia sin borrar originales y acceso A/B tras migración.

El procedimiento específico para staging usa solo un volumen nuevo sintético, servidor parado, backup nuevo fuera de DATA_DIR y restauración en otro directorio nuevo. Ver [checklist](staging-checklist.md). La recuperación externa del VPS queda pendiente; no se ha comprobado ni operado con backups o fotografías reales. Nunca restaurar un registro antiguo de sesiones para reactivar accesos revocados.

## TLS, dominio, redes y preparación EasyPanel

El generador produce configuración reproducible **sin crear infraestructura**. `compose.yml` es para Docker Compose aislado, no una definición importable de EasyPanel/Swarm. `easypanel-plan.json` se identifica como referencia manual; no llama a APIs de infraestructura. Véanse los pasos exactos y las puertas de autorización en la [checklist de staging](staging-checklist.md).

TLS se ensaya mediante proxy HTTPS loopback con certificado/CA sintéticos y verificación activa. Se rechaza un hostname incorrecto, se verifican cookies Secure/HttpOnly y Origin, y se exige autenticación perimetral incluso a rutas públicas `/w`, `/r`, `/m`, `/health` y `/vendor`. El proxy sobrescribe Host/X-Forwarded-Host/Proto en vez de confiar en cabeceras del cliente. Esto valida el contrato de la aplicación en una fixture: **no demuestra** que Traefik, ACME, DNS, firewall, volumen o redes del VPS estén configurados así. No se ha inspeccionado infraestructura existente.

## Riesgos y recomendación

No se recomienda producción ni varias réplicas. **La aplicación supera las validaciones aisladas y es candidata a un staging sintético controlado con una réplica**, sujeto a autorización y a comprobar las puertas operativas de la checklist en la infraestructura nueva. Los ensayos no autorizan por sí solos crearla ni garantizan su configuración real. No se aumenta RAM ni se habilita swap para ocultar fallos.

Pendientes: verificación real de TLS/perímetro/red y volumen exclusivamente de staging tras autorización; capacidad y respaldo externo del VPS; límites globales de almacenamiento y número de archivos por empresa; admisión justa por tenant (el límite de cuatro es global al proceso); carga sostenida y clientes lentos/abortos masivos; límites de descargas/conexiones y peticiones JSON concurrentes; decodificación/antivirus; HTTP Range; ensayos con vídeos reproducibles y navegador real para reels grandes; proveedores sandbox cuando se habiliten. Las integraciones SMTP simuladas se mantienen, pero no se envían correos reales.

La prueba acotada no es un benchmark comercial ni una prueba de agotamiento ilimitado. No elevar replicas como mitigación. Al terminar, la PR sigue en borrador y cualquier futura creación de staging, integración o despliegue necesita su autorización correspondiente.


## Commits de esta fase

- `519d8e1`, `ca84afd`: medición inicial y reproducción estricta sin swap.
- `d89e928`: streaming, temporales, regresiones, generador de staging y diagnóstico de réplica.
- `704f932`, `c39421a`: evidencia de carga accesible sin exceder los límites de anotaciones de Actions; limpieza no oculta fallos de I/O.
- `3d03b7e`, `e9301e2`: cliente de carga acotado y registro separado de sus fallos.
- `389cba1`: comprueba `memory.max` real, además de swap, y publica métricas finales.
- El commit de documentación que contiene este informe conserva estas evidencias y la checklist; el HEAD y sus checks se enlazan en la PR #3.
