# Autorización técnica propuesta de staging · 26/10/2026

**Estado: borrador; no autoriza crear ni desplegar.** Referencia exacta PR #5, `6277f7baee4202d655aaf015b3adde6663c98e0b`. Rama independiente `planning/isolated-staging-authorization`, basada en ese commit; PR nueva apilada hacia `security/phase-05r-oom`, para revisar únicamente esta propuesta. No modifica main, PR #3 ni PR #5. Sin infraestructura real, panel, dominios, redes, servicios externos, datos o secretos reales. No hay gastos autorizados.

Especificación legible por máquina: [plan.json](../../deploy/staging-authorization/plan.json); **no es un payload de EasyPanel**. Configuración previa: [perfil EasyPanel](../../deploy/easypanel-staging.md), [checklist histórica](staging-checklist.md). Este documento añade puertas nuevas; no marca como realizadas comprobaciones históricas pendientes. La referencia de proveedor `hostinger-context.md` de la skill no está disponible. No se infiere topología o capacidad real.

## 1. Revisión de OOM y compatibilidad

[Informe 0.5R](phase-05r.md), pruebas y evidencia numérica revisados. El único cambio de negocio respecto a fase 0.5 es el sink `boundedFileWriter` en `receiveBinary`: escritura secuencial, cola 64 KiB, sincronización `fdatasync` cada 4 MiB y al final, manejo de writes parciales y cierre ante error. La presión de páginas sucias baja en el control continuo de ~171 a ~14 MiB. Tres ensayos de 15 min activos + 2 min de reposo a 256 MiB/swap 0 pasan. No se conoce la asignación exacta del OOM histórico ni se ha demostrado estabilidad a días. `memory.peak` transitorio publicado supera 256 MiB durante reclaim; no ocultarlo ni confundirlo con elevar el límite. Usar `memory.max`, swap y eventos OOM efectivos como evidencia.

| Fase/control | Compatibilidad revisada | Límite que permanece |
|---|---|---|
| H01 cookies | El sink no interviene en parseo ni manejo global de errores | Repetir cookies malformadas vía proxy sintético |
| H02 fotografías | Empresa/permisos se comprueban antes del receptor; rename y namespace no cambian | Huérfanas/colisiones requieren revisión; ninguna reasignación automática |
| H03 XSS | Sanitización y texto dinámico no cambian | Repetir Chromium y rutas públicas con fixtures XSS |
| 0.1 Nodemailer | Lockfile conserva 10.2.1; sin dependencias nuevas | Solo SMTP simulado; no conectar proveedor real |
| 0.2 sesiones | Registro persistente y revocación intactos; mismo DATA_DIR y secreto tras reinicio | Un solo proceso; al restaurar archivar sesiones viejas y crear registro nuevo |
| 0.3/0.4 transferencias | Límites 4/8/120 MiB, 429, reintento idempotente, streaming y limpieza conservados | Más latencia de disco es esperable; timeout y proxy deben medirse |
| 0.5 recuperación | No cambia esquema ni migra recursos | Copia offline completa, hash y restore independiente; CI no es backup externo |

El orden de rename/manifest/directorio no ofrece transacción ante pérdida eléctrica. No atribuir a `fdatasync` de un temporal garantía de persistencia de toda la aplicación. Revocar no borra las cookies del navegador: el servidor debe rechazarlas. Admin global sigue siendo privilegiado; no entregar esa cuenta a usuarios de empresa ni afirmar un nuevo modelo de roles. Mantener dos empresas y dos usuarios limitados por empresa en pruebas; admin sintético solo para preparación, no para demostrar aislamiento.

## 2. Configuración reproducible, sin aplicar

No se cambia Dockerfile, servidor, credenciales existentes ni formato de datos. Reutilizar el generador local revisado, que solo crea archivos privados; **no ejecutar Compose up, Docker run ni comandos del panel con esta tarea**.

```sh
node scripts/prepare-staging.mjs /tmp/ruano-authorization-BUNDLE_NUEVO \
  --source-sha 6277f7baee4202d655aaf015b3adde6663c98e0b \
  --domain review.example.invalid \
  --node-image node@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
```

El comando solo es preparación offline. El directorio debe ser nuevo y se niega a sobrescribir; proyecto/volumen UUID, env sintético aleatorio 0600, directorio 0700. No publicar los env en artifacts/PR ni registrar secretos. `.invalid` no sirve para ACME. El campo `source.branch` del generador antiguo es informativo: **la única fuente autorizable es el SHA completo**, no esa rama móvil. El presupuesto nuevo de 12 GiB de este plan prevalece sobre los 8 GiB mínimos históricos del bundle. No importar el JSON antiguo como si validase capacidades del proveedor.

| Parámetro deseado | Comprobación futura bloqueante |
|---|---|
| Una réplica y un proceso Node 22 | Sin cluster/PM2; stop-first sin solapar tareas; auto-deploy desactivado |
| Imagen por digest, revisión OCI y lockfile | Reconstruir y revisar digest real; digest de base no equivale a digest de app; no publicar imagen en esta fase |
| 1 CPU, memoria 268435456 bytes | Leer quota y `memory.max` de la tarea propia; no aumentar RAM para pasar |
| Swap 0 | `memory.swap.max=0`, uso 0; `memswap_limit` Compose no garantiza traducción a Swarm |
| UID/GID 1000, PIDs 128 | Raíz readonly, cap_drop ALL, no-new-privileges, sin Docker socket/host mounts |
| tmpfs /tmp 32 MiB | Temporales de subidas en volumen, no RAM; tmpfs también consume memoria del cgroup |
| /app/data en volumen nuevo vacío persistente | Nombre UUID aprobado; sin snapshots/binds/redes de producción; ownership 1000:1000 |
| Puerto interno 3000 y health /health | Ningún puerto publicado directamente; health interno cada 30 s, timeout 3 s, 3 reintentos |
| Secretos ficticios exclusivos y estables | APP_USERNAME/PASSWORD/SESSION_SECRET propios; PUBLIC_URL exacta; OLLAMA_URL loopback:1 |
| Integraciones deshabilitadas | Sin tokens SMTP/Meta/IA/Drive/Telegram; tampoco importar snapshots con integraciones configuradas |

**NO-GO** si el panel necesita tocar proxy/red global, si no puede garantizar swap por tarea o si falta capacidad disponible. No resolver con swapoff, sysctl, conexión temporal a producción o nuevas compras. Un VPS compartido no es independencia física: CPU, disco y kernel pueden afectar a otros servicios. La futura autorización debe escoger capacidad ya disponible realmente aislable o rechazar la creación.

## 3. TLS, red y persistencia

Solo tras autorización nominativa: proyecto/servicio, FQDN, volumen y red nuevos, responsable y ventana de prueba. Dominio bajo titularidad confirmada, sin tocar registros existentes ni wildcard. TLS mínimo 1.2, certificado válido/cadena/nombre/renovación verificables, redirección HTTP sin contenido servido en claro. Nunca saltar verificación TLS. No fijar HSTS includeSubDomains sobre un dominio compartido por esta preparación.

Ingreso por proxy gestionado por panel, autenticación perimetral o allowlist **antes** de todas las rutas: `/`, login, `/api/*`, `/w/*`, `/r/*`, `/m/*`, formularios, vendor y health externo. Probar 401/403 sin perímetro incluso con token público válido; después probar permisos A/B con perímetro y usuario limitado. Las rutas públicas funcionales no equivalen a un fallo si el perímetro las protege según este diseño.

Red exclusiva, sin overlay por defecto ni conexiones a bases/servicios/redes privadas de producción. Default deny egress; sin proveedores externos desde Node. Probar con canarios sintéticos propios explícitamente autorizados; no sondear producción. Resolver DNS no prueba aislamiento. El certificado/proxy puede requerir egress ACME propio, separado del de aplicación; su autorización no abre egress a Node. Si el panel no puede cumplirlo sin cambios globales, NO-GO y propuesta separada.

Proxy sobrescribe Host/X-Forwarded-* confiables; no aceptar esos valores del cliente como prueba de TLS. PUBLIC_URL coincide con origen HTTPS. Verificar cookie Secure/HttpOnly/SameSite, rechazo de Origin ajeno y CSRF en mutaciones, CORS sin wildcard con credenciales. Tamaño del cuerpo compatible con 120 MiB y rechazo de +1 byte por app; presupuestar buffering del proxy y timeouts sin cargas ilimitadas. Medir flujo completo y reintentos 429 sin duplicados. Node no requiere segunda réplica para pasar.

Prueba posterior de persistencia: sesión A vigente y otra revocada, archivo válido y SHA conocido; reinicio de tarea con mismo volumen/env; A sigue válida, revocada 401, hashes idénticos, parcial 404, cero temporales tras startup. Distinto de recuperación desde snapshot, que exige nuevas sesiones.

## 4. Latencia fdatasync en almacenamiento persistente

Herramienta nueva [probe-fdatasync.mjs](../../scripts/probe-fdatasync.mjs), sin red/Docker. Solo escribe en un directorio hijo nuevo privado del parent elegido y lo limpia al terminar. Ventana de 4 MiB, chunks de 64 KiB, 1/2/4 escritores, archivos de hasta 120 MiB; no rellena todo el disco. `fdatasync` se mide aparte de la duración completa de cada archivo. Uso **solo futuro**, en scratch nuevo del volumen sintético autorizado, como UID 1000, contenedor de prueba limitado a 256 MiB/swap 0/1 CPU:

```sh
node scripts/probe-fdatasync.mjs /SCRATCH_SINTETICO_AUTORIZADO workers=1 mib=120 rounds=10
node scripts/probe-fdatasync.mjs /SCRATCH_SINTETICO_AUTORIZADO workers=2 mib=120 rounds=10
node scripts/probe-fdatasync.mjs /SCRATCH_SINTETICO_AUTORIZADO workers=4 mib=120 rounds=10
```

La imagen de aplicación no incluye esta sonda. Para la futura ejecución, usar un helper Node con el mismo digest de base probado, UID/GID 1000, raíz readonly, sin red, 256 MiB/swap0/1 CPU/PIDs128, montando **solo** este script revisado readonly y un scratch sintético nuevo del volumen candidato en modo escritura. No montar el socket Docker ni el DATA_DIR activo. Registrar SHA-256 del script montado; no asumir que el comando está disponible dentro de la imagen de aplicación. La creación de ese helper también requiere la autorización futura.

No ejecutar sobre DATA_DIR, producción ni filesystem que no sea el persistente candidato. Ejecutar secuencialmente y repetir tres veces cada nivel, registrando identidad del volumen/driver, kernel, imagen, límites, espacio libre, UTC y métricas numéricas sin env. Cada nivel escribe hasta 1,2/2,4/4,8 GiB acumulados pero borra cada archivo terminado; pico máximo ~480 MiB. La prueba no mide pérdida eléctrica ni confirma que el soporte remoto cumpla flush.

Criterios propuestos, previos a medir: sync p95 ≤100 ms, p99 ≤500 ms, máximo ≤2 s; archivo completo ≤60 s a cada concurrencia; cero EIO/ENOSPC/EDQUOT, hashes funcionales correctos en prueba HTTP posterior. Código 0 cumple latencias; 2 incumple; cualquier error de I/O/interrupción falla. Medir además proxy a 120 MiB: p95 ≤60 s, ninguno >120 s, health p95 ≤500 ms y todos 200. No cambiar umbrales a posteriori sin justificar/revisar.

La herramienta es una sonda offline, **no un supervisor**: un I/O bloqueado puede no responder a SIGTERM hasta que vuelva el kernel; SIGKILL puede dejar solo su scratch propio. El futuro supervisor debe aplicar timeout 15 min por nivel y conservar inventario/ruta privada del scratch para revisión; limpiar solo ese directorio tras comprobar cero escritores. No eliminar rutas por glob. Los ensayos pequeños locales validan el programa, no el almacenamiento de Hostinger. Se exige el guard de disco del apartado siguiente antes de la prueba grande.

## 5. Cuotas acumuladas, alertas y disco lleno

**Situación verificada en código:** cuotas 4 global/2 usuario/3 empresa son de concurrencia. No hay cuota persistente acumulada por empresa/usuario. ENOSPC/EDQUOT no se traducen específicamente a 507: los handlers API pueden devolver 500. El temporal se intenta eliminar al fallar la recepción; no afirmar atomicidad de todas las escrituras de metadata o respuesta correcta bajo cualquier fallo de disco. Un error de sesiones puede cerrar la salud con 503. El backup periódico interno no sustituye copia externa consistente.

**Política propuesta sin implementar cambios de negocio:** dataset final total 1 GiB, empresa 512 MiB, usuario 256 MiB; alertas al 70%, parar nuevas escrituras al 80% en cualquiera. Estas cifras son máximos operativos del ensayo; no planes comerciales. Medir bytes finales y número de archivos por namespace; medir por separado temporales, metadata, backups y scratch. En el modelo actual falta atribución histórica de autor: cuota por usuario solo para fixtures cuyo creador conste en un registro sintético independiente; si la atribución es desconocida, no adivinar ni permitir crecimiento. Se detiene el generador y se solicita revisión.

Para un ensayo vigilado, reservar antes de cada lote su peor incremento (incluyendo originales coexistentes y hasta 4×120 MiB de temporales), mantener un conjunto fijo de claves y contar reintentos como la misma operación. No permitir una prueba de crecimiento ilimitado. Watchdog externo cada segundo; alerta al 70%, parada al 80% o espacio libre <6 GiB durante carga. Un muestreo no garantiza cuota dura: admisión/reservas antes del lote y filesystem dedicado con cuota propia son requisitos para ejecución desatendida. **Guard/reservas y cuota dura no están implantados por esta PR; NO-GO para ejecutar seis horas hasta implementarlos y probarlos con fixtures.** No aplicar cuotas al filesystem compartido real sin autorización separada.

Futuro diseño de cuota en app: ledger persistente por empresa con bytes finales + reservas en vuelo, reserva atómica antes de aceptar, release en error/abort, reconciliación al arrancar; distinguir reemplazo y retención del original. Autoría por usuario requiere diseño/migración revisados; no inferir de IDs ni migrar ahora. Respuesta 507 o error de cuota estable, interfaz sin reintento automático destructivo; no se promete que exista actualmente.

Prueba ENOSPC futura: filesystem desechable con límite de bytes/inodos, nunca llenar disco host; sin montajes privilegiados al servicio. Si requiere privilegios adicionales, pedir autorización para fixture aislado o usar inyección EIO/ENOSPC controlada, declarando que no sustituye el filesystem real. Probar write, datasync, rename, manifest y sessions; ningún 2xx falso, hash del archivo anterior conservado, incompletos no servidos, recuperación verificable. Ante error: cerrar ingreso de pruebas y detener clientes; conservar datos/logs privados, cero borrado automático de fotos finales. Si fallan metadata o salud, parar tarea propia; recuperar offline a volumen nuevo desde copia verificada. No ampliar disco ni borrar para forzar verde.

## 6. Backup externo y recuperación, sin conectar servicios

[Procedimiento existente](photo-recovery.md) conserva originales, ambiguas sin dueño y destinos nuevos. No reasignar fotos huérfanas/colisiones. Política propuesta: snapshot antes de cada cambio/reinicio destructivo y al terminar la sesión; si hay actividad continua, snapshot offline diario (RPO ≤24 h). RTO provisional ≤30 min desde disponibilidad de backup, medir transferencia/restore completo aparte. Hasta tres snapshots iniciales, sin borrado automático; al agotarse presupuesto detener ensayos y revisar retención, no contratar.

1. Cerrar ingreso y generador del staging autorizado, comprobar cero escritores y parar solo su tarea. Registrar SHA/digest/UID, inventario y topología sin secretos. `--offline-confirmed` no detiene servicios por sí mismo.
2. Montar solo origen sintético readonly en helper propio 256 MiB/swap 0, scratch de disco nuevo separado. Usar `photo-storage.mjs backup` con destino nuevo fuera de DATA_DIR; verificar inventario, recuentos y SHA-256. Copiar todo DATA_DIR, no solo JPG; guardar config/env de staging separadamente cifrados, sin imprimirlos.
3. Diseño externo: exportación cifrada con herramienta/formato previamente aprobados (por ejemplo age), permisos 0600 y claves fuera de backup/repo/host de app. Destino independiente bajo control autorizado, sin credenciales reales ni proveedor conectado en esta tarea. Hash de archivo cifrado + inventario de contenido; canal autenticado, verificación en destino y prueba de descifrado. Una copia en otro volumen del mismo VPS NO satisface este punto. No poner claves ni URLs firmadas en argumentos/logs/artifacts.
4. Ensayar retorno desde ese soporte a máquina/volumen de recuperación nuevo y aislado. Verificar hash cifrado, descifrar privado y restaurar con `photo-storage.mjs restore`; negativo de corrupción y destino ya existente deben rechazarse. No montar origen ni producción en el recuperado.
5. Comparar inventario exacto **antes de arrancar**. Archivar sessions.json del snapshot fuera de DATA_DIR activo en área privada; iniciar registro nuevo sin alterar backup ni rotar secretos reales. Cookies anteriores 401, nuevos logins válidos, A200/B403, archivos válidos con hashes y parcial404. Repetir plan de propiedad: ambiguas siguen sin asignación.
6. Registrar RPO/RTO, errores, checksums y restauración efectiva. Mantener origen/copia/restauración hasta revisión. Si falla, NO-GO; original detenido/intacto, sin reemplazar automáticamente ni restaurar encima.

Esta tarea no valida cifrado/proveedor/transferencia remota. Prueba local de backup ya existente acredita solo el laboratorio. La elección de soporte externo sin coste y custodia de claves es una autorización pendiente; no declarar backup operativo antes de recuperar desde él.

## 7. Ensayo prolongado diseñado, no ejecutado

Objetivo: 6 h activas (2 h a concurrencia 1, 2 h a 2, 2 h a 8) + 30 min reposo, máximo 7 h 30 min incluyendo interrupción, reinicio y restauración. Dos empresas/cuatro usuarios, datos/secretos sintéticos; mismas cuotas y límites, un solo servidor. Subidas mixtas 256 KiB/8 MiB/120 MiB, cancelaciones, +1 byte, idempotencia, rotaciones logout/login y cookies antiguas. Mantener claves fijas para acotar dataset; crecimiento separado hasta 70% y parada controlada antes del 80%. Reinicios programados solo en subensayo separado; no reiniciar automáticamente el servidor para disimular una fuga.

El guion `scripts/test-soak.mjs` existente acepta duración por fase; **no basta con poner SOAK_PHASE_SECONDS=7200**: falta integrar/probar el supervisor con cuotas, límites de logs y parada externa. Esa integración se autoriza como trabajo de laboratorio separado, no se ejecuta aquí. GitHub-hosted tiene límites temporales y política de minutos: no lanzar trabajos de horas ni contratar runner bajo esta tarea. Elegir después ejecutor autorizado ya disponible con aislamiento y capacidad confirmada.

Supervisor fuera del cgroup, identificado por UUID/labels exactos y validación de SHA/volumen antes de cualquier stop. Nunca buscar por nombres genéricos. Cliente 512 MiB sin swap, observador 64 MiB; aplicación 256 MiB/swap0/1 CPU/PIDs128. Limitar CPU del cliente a 1 núcleo y observador a 0,25; no introducir otra réplica ni mover trabajo de negocio al observador. Muestreo 1 s, gauge proceso 250 ms; NDJSON numérico ≤128 MiB, rotación acotada con resumen persistente, sin request bodies, cookies, tokens, env ni fotos. Conservar evidencia anterior a fallo; no truncar silenciosamente ni perder el evento OOM. Si falla observación, detener ensayo.

| Señal automática | Acción del supervisor propuesto |
|---|---|
| memory.max distinto / swap.max distinto / procesos >1 / swap usado >0 | Abortar antes de carga; desviación de configuración |
| Incremento oom/oom_kill, evento Docker oom o OOMKilled | Parar clientes inmediatamente, conservar métricas y estado; no reiniciar para continuar |
| RSS >160 MiB 60 s, heapUsed >64 MiB 60 s o external+arrayBuffers >96 MiB 60 s | Parar y diagnosticar; external incluye ArrayBuffers, suma deliberadamente conservadora, no consumo independiente |
| Tras calentamiento de 30 min, medianas RSS suben >16 MiB entre ventanas de 30 min y pendiente >1 MiB/min durante 30 min | Parar por crecimiento sostenido; analizar caché/native/heap, no declarar fuga solo por RSS |
| memory.current >95% durante 60 s Y dirty+writeback >32 MiB | Parar por presión de escritura; caché limpia alta sola no prueba fallo |
| CPU >95% 5 min con p95 health >500 ms, o 3 health fallidos seguidos | Parar carga; mantener evidencias, sin ampliar CPU/RAM |
| Cualquier 5xx inesperado, archivo cruzado/2xx indebido, hash incorrecto, cookie revocada aceptada | Parar inmediatamente, incidencia de integridad/seguridad |
| Uso ≥80% de presupuesto, reserva insuficiente, free <6 GiB, error ENOSPC/EDQUOT/EIO o inodos <10% | Parar admisión antes de siguiente lote; no limpiar datos válidos automáticamente |
| Sin métricas >10 s, log próximo al límite, watchdog/cliente muerto o plazo 7h30 | Terminar con fallo/inconcluso; no contabilizar carga no ejecutada |

Secuencia de parada: bloquear nuevas admisiones del generador, cancelar clientes propios, esperar drenaje hasta 30 s, capturar estado/hash/inventario y parar tarea propia si no drena. Terminación forzada solo sobre UUID aprobado y registrada como intencional, no confundir con OOM. Temporales no accesibles antes ni después; limpiar únicamente por mecanismo revisado al arrancar o revisión offline. Fallar observación no autoriza tocar infraestructura ajena.

Aceptación al final: sin OOM/restarts no previstos, cero fallos inesperados/5xx, 413 de excesos y 429 solo por saturación prevista con Retry-After; concurrency1/2 sin 429 en perfil acotado y concurrency8 con rechazos esperados sin starvation A/B. Health todas200 y p95≤500 ms; transferencias120 MiB p95≤60 s/ninguna>120 s. RSS mediano última hora no más de 16 MiB sobre primera hora comparable poscalentamiento, pendiente última hora ≤0,5 MiB/min; heap/external sin tendencia monotónica no explicada. Repo no aporta aún estos resultados. Tras reposo, reinicio, logout/revocación, SHA, 404 de incompletos, cero temporales y restore independiente deben pasar; desconocido o incompleto equivale a NO-GO, no éxito.

## 8. Presupuesto sin gastos y plan de reversión

| Recurso reservado para el ensayo | Techo propuesto |
|---|---:|
| Aplicación | 256 MiB, CPU 1, swap 0 |
| Cliente sintético | 512 MiB, CPU 1, swap 0 |
| Observador | 64 MiB, CPU 0,25, swap 0 |
| Pico concurrente de esos contenedores | 832 MiB RAM, CPU hasta 2,25 |
| Backup/restore, no simultáneo con cliente | 256 MiB por helper; ejecutar uno a la vez |
| Dataset final / temporales activos | 1 GiB / hasta 480 MiB adicionales |
| Tres snapshots / scratch / restore | Hasta 3 / 1 / 1 GiB |
| Imagen/build y logs numéricos | Reserva 1 GiB / 128 MiB; medir build aparte |
| Margen y reserva de recuperación | Al menos 4 GiB |
| Espacio libre previo dedicado | **12 GiB**, sin contar datos ajenos/OS |

No es una reserva ya hecha ni un mínimo comercial universal. Proxy/panel/OS/build tienen consumo adicional no medido: no autorizar si solo hay 832 MiB libres ni restar recursos a producción. Verificar CPU, disco/inodos, cuota, IOPS y memoria reales en una tarea de inspección futura expresamente autorizada. Coste autorizado **0 €**; ninguna suscripción, almacenamiento externo nuevo o ampliación. Si no hay capacidad/soporte sin gasto y sin impacto ajeno, detener.

Rollback de staging: cerrar perímetro, parar generador/tarea propios, conservar imagen/config/volumen y evidencias. Si hay error de aplicación, volver solo a una imagen revisada que incluya la corrección OOM y H01/H02/H03; **no volver a dd97f34 para abrir servicio**. Si no existe alternativa verificada, mantener staging apagado. Ante corrupción, restaurar a volumen nuevo y revalidar; no sobrescribir ni borrar origen. Sin downgrade/migración de datos, DNS o secretos automáticos. Desmantelamiento y eliminación de volúmenes/copias requieren autorización separada con inventario y recuperación verificada. La presente tarea no ejecuta rollback ni cambia rutas/proxy existentes.

## 9. Checklist GO/NO-GO y autorizaciones pendientes

| Puerta | Evidencia necesaria | Estado actual |
|---|---|---|
| Base y compatibilidad | SHA6277f7b, informe0.5R y CI originales; diff nuevo sin negocio | Revisado; nuevos checks enlazados en PR |
| Revisar esta propuesta | Revisor, límites/umbrales y alcance aceptados | Pendiente |
| Inspección limitada del proveedor | Autorización de solo lectura de capacidades/recursos, sin secretos ajenos | No autorizada/no realizada |
| Aislamiento y swap efectivos | Panel permite red exclusiva, sin prod/global, swap por tarea0 | Pendiente, bloqueante |
| Nombres y dominio nuevos | Proyecto/servicio/red/volumen/FQDN nominativos y titularidad | Pendiente; placeholders no utilizables |
| Recursos sin coste/impacto | Capacidad libre, presupuesto y almacenamiento dedicado | Pendiente |
| Controles de disco y supervisor | Reservas/cuota dura/alertas y negativos ENOSPC/watchdog probados | Diseñados, no implantados; bloqueante para carga larga |
| Backup externo | Soporte autorizado, custodia de claves, exportación/retorno/restore | Diseñado, no conectado ni verificado |
| Creación de staging | Autorización expresa solo de recursos nuevos y rollback | **No otorgada** |
| Acceso a staging | TLS/perímetro/egress/persistencia/fdatasync/restore verificados | Pendiente después de creación autorizada |
| Carga de seis horas | Ejecutor, ventana, límites y guard validado | Diseñada, no ejecutada |
| GO de validación controlada | Todas las puertas aplicables con enlaces/fechas/responsable; ninguna desconocida | **NO-GO actual** |

Se puede revisar y aprobar el **diseño** ahora. Para avanzar se requieren autorizaciones separadas: (A) inspección técnica limitada sin cambios ni datos reales, (B) implementar/ensayar supervisor/cuotas de laboratorio, (C) seleccionar soporte de backup/custodia sin gasto, (D) crear únicamente los recursos nuevos nominados si A–C cumplen, (E) habilitar acceso y ejecutar la carga tras validar perímetro/almacenamiento. Ninguna incluye main, fusión, producción, infraestructura existente, datos reales o compras. Un fallo debe volver a revisión, no ampliar el alcance automáticamente.

## 10. Verificación de esta propuesta

Solo se añaden este informe, plan JSON, sonda offline y su regresión. No se ejecuta prueba de varias horas ni prueba de volumen del proveedor. La regresión crea 2 MiB sintéticos locales y comprueba salida/limpieza y conservación de un sentinel; la latencia local no se usa para aprobar infraestructura. El resultado de Node22/24, Chromium, Docker y audit de este HEAD se registra en la PR con sus URLs reales cuando termina, separado de la evidencia histórica de 0.5R.
