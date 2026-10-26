# Supervisor sintético externo · borrador · 26/10/2026

Referencia PR #6 `12a6b71ada8c9c1d2da4b1788b063b529ca5ad2b`. Rama nueva `security/synthetic-supervisor`; no cambia servidor, main, PR anteriores, producción o infraestructura. No ejecuta seis horas. Solo tooling, regresiones y CI con contenedores/volúmenes UUID sintéticos desechables, sin puertos, egress ni proveedores. Las pruebas reales y limitaciones finales se enlazan en la nueva PR.

## Controles implementados

`lib/synthetic-supervisor.mjs` contiene motor, políticas, journal acotado y reservas. `scripts/test-supervisor.mjs` es el adaptador Docker corto; no permite adjuntarse a contenedores/volúmenes existentes. Crea únicamente recursos con UUID/label impredecible y conserva ID; comprueba ID+label antes de exec/start/stop/rm. No usa selección por prefijo global. Docker está accesible solo al operador/supervisor del laboratorio, nunca a la app o cliente. No es un servicio HTTP de control.

Aplicación 256 MiB, memory-swap=256 MiB (swap0), CPU1, PIDs128; cliente512MiB/CPU1; helper lector128MiB/CPU0,25 separado. Todos raíz readonly, capabilities vacías, no-new-privileges, sin Docker socket; app con tmpfs32MiB para /tmp. App network none; cliente solo comparte su loopback; helper network none y volumen readonly. Una app/proceso de negocio. El helper **lee** estadísticas e inventario, no persiste subidas ni hace negocio fuera del presupuesto de aplicación. La memoria extra no sustituye la corrección OOM de PR5.

Supervisor Node ejecutado en el host de CI, fuera del proceso/cgroup de app: lectura cgroup v2 de PID propio, gauge opt-in privado, disco/inodos e inventario limitado4096entradas sin seguir symlinks; configuración CPU/memoria y estado/health inspeccionados. Se vigila asimismo RSS del observador host ≤192MiB y CPU media≤25% tras30s; son límites de parada, **no un cgroup duro del proceso host**. Adaptar a un cgroup propio y watchdog independiente antes de horas/entorno persistente. Helper lector con límite duro128MiB adicional; presupuesto concurrente de contenedores896MiB/2,25CPU, más observador hasta192MiB y Docker/OS/proxy no medidos.

Política por defecto: duración7h30 (solo motor, el adaptador no ofrece modo largo), observación sin huecos>10s, timeout de probe5s (adaptador8s), cada comando Docker≤15s y salida combinada≤64KiB. OOM por memory.events.oom/oom_kill o State.OOMKilled; no depende de salida137 ni requiere que muera PID1. Tres health fallidos consecutivos, presión RSS>160MiB/heap>64MiB/external+arrayBuffers>96MiB durante60s; caché limpia alta por sí sola no detiene. External ya incluye ArrayBuffers, suma conservadora. Dirty+writeback>32MiB con current>95% durante60s, CPU>95% con health lento>500ms durante5min. Medianas/regresión de RSS tras30min de calentamiento, ventana30min: crecimiento>16MiB y pendiente>1MiB/min detienen. Datos incompletos/no finitos o fallo de lectura cierran el ensayo.

El adaptador corto utiliza health de Docker; no mide todavía p95 de HTTP ni aporta healthMs de red (valor0). Por tanto no acredita el criterio CPU+latencia de la prueba larga; sí aplica cuota CPU dura y detecta health fallido. Eventos OOM se leen de cgroup/estado, no de un stream ilimitado de Docker events.

Journal privado0600, creación exclusiva, presupuesto128MiB por defecto (1MiB en corto) y margen2048bytes; rechaza antes de rebasar. Sin buffers de logs ilimitados en memoria. Logs Docker local por contenedor max-size1m/max-file2 (hasta2MiB nominales cada uno, además del journal); no se vuelcan en artifacts. Artifacts contienen números, razones y IDs de fixtures/reservas, nunca env/cookies/fotos. Señales SIGTERM/SIGINT cierran admisión; techo global corto180s. En SIGKILL/caída del host no existe garantía de ejecutar finally: las reservas inciertas no se liberan automáticamente y no se permite reanudar sobre un ledger existente.

## Reservas y crecimiento

Ledger privado persistido con fsync de archivo y rename antes de iniciar HTTP; operaciones serializadas incluso ante Promise.all. Solo fixtures a/b y usuarios a1/a2/b1/b2, sin atribución histórica inventada. Contabiliza bytes finales comprometidos + reservas, conservadoramente sin deducir sobrescrituras. Admite hasta4 vuelos y512 operaciones comprometidas. Límites1GiB global/512MiBempresa/256MiBusuario; rechaza nueva admisión al80% y alerta de dataset al70%. Disco observado incluye metadata/temporales/backups; reservar además dos veces el tamaño íntegro de todos los vuelos para coexistencia/temporales. Mínimo12GiB libres previo, parar si free<6GiB o inodos libres<10%.

Commit solo acepta tamaño exacto reservado tras descargar y verificar hash. Fallo sin limpieza confirmada deja vuelo retenido y congela admisión; no adivina si un HTTP interrumpido ya guardó el archivo. Limpieza confirmada libera únicamente su token. Falla ledger: no se lanza trabajo nuevo. Un ledger existente impide reinicio automático. Esta persistencia permite inspección tras fallo de proceso, **no garantiza fsync del directorio ni recuperación transaccional ante pérdida eléctrica**.

Son controles del generador sintético de este adaptador, no cuotas comerciales de aplicación ni una cuota dura del filesystem. No aceptar tráfico fuera del generador ni ejecutar desatendido en un disco compartido: free es un muestreo, reservas no impiden escritores ajenos. No modificar cuotas reales. Hace falta filesystem sintético dedicado/cuota propia o ejecutor con aislamiento físico de disco, más watchdog validado para la futura carga larga.

## Parada y recuperación

El motor deja de admitir antes de stop; el adaptador para cliente, helper y app propios, con parada Docker3s y timeout acotado del comando. No reinicia para continuar la carga ni amplía RAM/swap. Si Docker no responde, se registra fallo y no afirma detención; requiere watchdog externo futuro. Los fallos preservan volumen y bundle privado local para revisión; artifacts conservan ledger sin secretos. En CI se perderán al eliminar el runner: no son backups externos. Éxito: verificar recuperación primero y después limpiar solo recursos UUID propios. No borrar fotos reales ni finales como respuesta al umbral.

Subensayo de recuperación explícito y separado: arranca las mismas tareas propias, login nuevo, SHA del archivo válido, empresaB403, logout y cookie401, cero temporales. El bucle de carga no se reanuda. Las pruebas persistentes anteriores se conservan. No sustituye restauración independiente externa del plan PR6.

## Ensayos cortos y evidencias

CI construye imagen local sin publicarla y ejecuta `node scripts/test-supervisor.mjs ruano-staging-check`: duración5s, cuota reducida de usuario para forzar rechazo sin enviar HTTP, health Docker deliberadamente fallido y OOM real mediante asignaciones sintéticas en un proceso exec del cgroup propio256MiB. El observador debe detener por OOM aunque sobreviva PID1. Techo del casoOOM20s y de todo script180s. Las duraciones cortas sirven para demostrar parada, no estabilidad de horas.

`node scripts/test-supervisor-disk.mjs ruano-staging-check`: app en tmpfs desechable4MiB, sin llenar filesystem host. Foto válida64KiB, foto permitida4MiB provoca ENOSPC real confirmado en log privado; HTTP500 actual (no507), hash válido conservado, reintento pequeño201 y cero parciales. No es volumen persistente; la recuperación se verifica **sin reiniciar ese tmpfs volátil**. Reinicios persistentes pertenecen al otro subensayo. No prometer semántica de disco real a partir de tmpfs.

Regresiones unitarias prueban ventanas completas con reloj virtual (incluida una hora virtual), OOM/swap/límites, stale/timeout/cancelación, CPU/health, crecimiento vs meseta, logs, reservas concurrentes/disco insuficiente/congelación. ENOSPC/EDQUOT/EIO de fdatasync se inyectan en el writer con un FileHandle real; se exige rechazo, original intacto y retry limpio. Esos tres fallos de sync son inyección controlada, no avería del proveedor. No se añade un error sintético al servidor real.

Archivos nuevos: `lib/synthetic-supervisor.mjs`, `scripts/supervisor-docker.mjs`, `scripts/test-supervisor.mjs`, `scripts/test-supervisor-disk.mjs`, `tests/synthetic-supervisor.test.mjs`, `tests/storage-faults.test.mjs`, este informe. CI añade los cortos y sus artifacts a los checks existentes. Se mantienen las79regresiones previas. Resultados finales reales y SHA en PR; no anticipar verde ni atribuir al motor una prueba de seis horas no ejecutada.

## GO/NO-GO actualizado

- [ ] CI de este SHA verde: pruebas previas+regresiones, Node22/24, Chromium, Docker, audit0; ver nueva PR.
- [ ] Cortos reales de OOM/health/cuota/duración/disco lleno correctos, logs limitados y recuperación sin perder válido.
- [x] Motor y ledger implementados; negativos de crecimiento, límites, logs, sync, timeout y concurrencia cubiertos con fixtures.
- [ ] Cgroup duro del observador y watchdog independiente ante muerte/daemon bloqueado; pérdida de observación falla cerrada solo mientras el supervisor sigue vivo.
- [ ] Ejecutor/almacenamiento dedicado con cuota dura de disco/inodos; probar ENOSPC persistente, rename/manifest/sesiones y corte eléctrico por separado. No inferirlos de writer/tmpfs.
- [ ] Integrar perfil6h con generador de claves acotadas/reemplazos reconciliados y medir p95HTTP real; el adaptador entregado se limita a cortos.
- [ ] Infraestructura futura autorizada: swap0 real por tarea, redes/volumen/dominio nuevos, TLS/perímetro, egress, capacidad sin coste ni impacto, fdatasync del volumen persistente y backup externo/restore independiente.
- [ ] Autorización nominativa separada para inspección/creación y carga larga. No se obtiene con CI verde.

**GO solo para revisar estos controles y sus ensayos cortos. NO-GO para crear staging o ejecutar seis horas.** Las puertas restantes no se sustituyen por más RAM, réplicas, cambios globales o contratación. No se despliega ni fusiona nada.

## Trazabilidad de la validación

Primer intento `d2827cc`, run [40307346402](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40307346402): Node22/24 correctos (88pruebas); Docker build, arranque y recursos previos correctos. El adaptador nuevo falló al inspeccionar Health inexistente **antes de start** y no ejerció las paradas. No se cuenta como OOM ni como aceptación. Se corrige con acceso opcional al campo; los posteriores resultados reales quedan en PR.

La telemetría se precarga únicamente en PID1 de la aplicación: los exec de diagnóstico limpian NODE_OPTIONS para no sobrescribir su gauge. Se lee CPU efectiva de cpu.max, no solo metadata Docker. Reservas incluyen metadata observada y todos los vuelos; journal serializa escrituras concurrentes, rechaza overflow antes de escribir y falla cerrado ante errores. Se amplían negativos de ledger obstruido y competencia por presupuesto de logs sin cambiar las79pruebas anteriores. `scripts/container-memory.mjs` añade únicamente la lectura cpu.max para ese control; ningún cambio de negocio.
