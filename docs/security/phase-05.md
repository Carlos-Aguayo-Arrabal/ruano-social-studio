# Fase 0.5 · preparación final de staging aislado · 25/10/2026

Base solicitada `865e1b5`; misma rama `security/phase-0-2026-10-24`, PR #3 en borrador. No se crean servicios/dominios/redes en Hostinger, no se modifican servicios existentes ni main, no se usan datos/credenciales de producción ni se contratan recursos. Todos los contenedores/volúmenes de ensayo son UUID nuevos de CI, con red sin salida y secretos sintéticos; se eliminan únicamente esos recursos al finalizar.

Se revisan los informes 0.1–0.4, transición de sesiones, recuperación y checklist. Se aplican las skills de EasyPanel y recuperación; la referencia `hostinger-context.md` no está disponible. No se deduce de ella una topología real, versión de panel o capacidad del VPS.

**Resultado: no recomiendo crear todavía el staging real.** Se han observado dos OOM con la aplicación limitada a 256 MiB sin swap. El ensayo ampliado no completó el perfil previsto; la causa no está aislada. La configuración y recuperación sintéticas quedan preparadas, sin aprobación de uso.

## Configuración preparada

La [especificación exacta del estado deseado](../../deploy/easypanel-staging.md) describe proyecto/servicio, código, build, volumen, recursos, secretos, ingreso y recuperación. `scripts/prepare-staging.mjs` genera el bundle **local**, valida formato de commit completo/hostname/base de Node y nunca llama al panel ni DNS.

- Una réplica/proceso, actualización stop-first, sin auto-deploy ni publicación directa de puertos; 1 CPU/256 MiB, swap desactivado, 128 PIDs, UID/GID 1000, raíz readonly y tmpfs 32 MiB.
- Proyecto/volumen/red con nombres nuevos `ruano-stage-*`, sin redes/volúmenes de producción. App y perímetro con secretos distintos en archivos 0600, carpeta 0700; no se imprimen ni versionan.
- Commit inmutable de la rama y digest Node 22 en `NODE_IMAGE`. La CI hace pull, resuelve digest y construye con ese digest, registra ID de imagen y revisión. La etiqueta por sí sola no garantiza la identidad.
- FQDN real exclusivo pendiente de titularidad/autorización. El nombre por defecto `.example.invalid` es un placeholder único, **no un dominio creado ni una verificación DNS**. El JSON del plan es referencia manual, no una definición de API del panel.
- Presupuesto sintético operativo 1 GiB, alerta 70 %, suspender nuevas pruebas al 80 %, 8 GiB libres previstos para datos/copia/restauración y margen. Estos umbrales no son cuotas persistentes implementadas.

## Ensayos

| Comprobación | Resultado verificable |
|---|---|
| Regresiones Node 22/24 + Chromium | 75/75 por runtime en el código candidato y sucesivos checks |
| npm audit | 0 vulnerabilidades de todas las severidades |
| Build fijado, smoke y 15 casos de límites | Correctos en los runs citados; no equivalen a estabilidad sostenida |
| Corto `13ed3c0`, [40217442868](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217442868) | Correcto, incluida copia/restauración sintética |
| Corto `d64e947`, [40217906593](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217906593) | **Falló por OOM**, 143 muestras / 150,046 s observados |
| Ampliado `d64e947`, [40217901995](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40217901995) | **Falló por OOM**, 844 muestras / 883,351 s observados, sin completar carga y reposo |

El corto correcto de `b31f61e` ([40219003872](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40219003872)) no borra los fallos anteriores. No se considera resuelto el OOM por obtener después una corrida verde. Los runs del HEAD documental se enlazan en la PR con sus resultados reales.

[OOM corto](evidence/phase-05-short-oom.json), [OOM ampliado](evidence/phase-05-long-oom.json), [validación corta y restore correctos](evidence/phase-05-short-validation.json), [npm audit](evidence/phase-05-npm-audit.json). La serie completa permanece en artifacts `docker-synthetic-results` de los respectivos runs; los resúmenes se recuperaron en el [job de diagnóstico 40219760323](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40219760323).

Local: Node 22.23.4 y 24.19.0, **75/75 pruebas por runtime**, Chromium incluido. `npm run check` valida también sintaxis y rutas de importación de diez módulos generados del ensayo, con ambos perfiles. `npm audit` sin vulnerabilidades conocidas; evidencia JSON al cerrar la fase.

### Memoria y estabilidad

Perfil ampliado planificado: 15 minutos activos (tres fases de 5 min a concurrencia 1/2/8) y 2 minutos de reposo. Mismos 256 MiB sin swap, sin forzar GC ni ampliar recursos. Cliente separado de 512 MiB y sin swap; cuatro usuarios de dos empresas, fixtures 256 KiB/8 MiB/120 MiB, rechazos y abortos intencionales, sondeos de salud y acceso cruzado esperado 403.

Se registran CPU, RSS, anon, memory.current/peak/max, swap y disco cada ~1 s/10 s. Para RSS se calculan pendiente OLS MiB/min y medianas inicial/final de ventanas de hasta 60 s por fase y reposo. Son descripciones: ni un incremento prueba fuga ni una meseta de minutos la descarta. No se hace profiling invasivo ni heap snapshot que cambie el presupuesto. La serie completa queda en artifacts, resúmenes versionados desde anotaciones de Actions.

La prueba larga se selecciona con `[staging-long]` en un push autorizado; no se repite en cada actualización documental ni en cada PR. Timeout Docker 35 min. El resto de runs conserva perfil corto. El trigger no ejecuta despliegues ni publica imágenes.

### Hallazgo F05-MEM-01 · verificado, causa pendiente

En ambos fallos `finalState={running:false, oomKilled:true, exitCode:137}`. La excepción del cliente fue `unexpected upload outcome`; ocurrió **antes** del SIGKILL intencional del ensayo de recuperación. No se confunde una parada planificada con un OOM.

| Métrica observada | Corto fallido | Ampliado fallido |
|---|---:|---:|
| Memoria configurada | 256 MiB | 256 MiB |
| Swap usado | 0 | 0 |
| CPU media de la ventana | 17,88 % de un núcleo | 16,30 % de un núcleo |
| Mayor RSS muestreado | 108,14 MiB | 145,32 MiB |
| Mayor anon muestreado | 45,00 MiB | 83,76 MiB |
| Pico de cgroup observado | 256,25 MiB | 260,61 MiB |
| Mediana RSS inicial/final de ventanas | 88,36 / 100,44 MiB | 85,70 / 98,06 MiB |
| Pendiente OLS de toda la ventana | +6,894 MiB/min | +0,594 MiB/min |

El ampliado aportó 844 muestras de memoria y 86 sondeos de disco antes de fallar. La última muestra de RSS fue ~102,27 MiB, mientras la memoria cargada al cgroup estaba en ~253,89 MiB. No se puede equiparar RSS con memoria total del contenedor ni afirmar una fuga de heap con estos datos. Tampoco se puede deducir estabilidad de una pendiente pequeña: hubo un OOM real.

**Condiciones/hipótesis pendientes:** los sondeos `docker exec` consumen CPU/memoria del mismo cgroup de 256 MiB. Pueden influir, pero no se ha demostrado que sean la causa. Caché de páginas, memoria sucia/writeback, kernel, sockets y picos entre muestras no se desglosaron en esta captura. No se atribuye el fallo a un buffer completo ni se concluye que aumentar RAM sea la solución. El código de recepción/descarga sigue siendo streaming.

Para cerrar el hallazgo: medir desde fuera del cgroup de aplicación, repetir A/B sin/con sondeos con el mismo commit/base/256 MiB sin swap, registrar `memory.stat` (anon/file/file_dirty/file_writeback/sock/slab), `memory.events`, pressure, CPU/IO y fase/petición fallida; aislar la causa y comprobar cualquier corrección con regresiones y varias corridas sostenidas. No se modifica ahora el modelo de usuarios ni se contrata infraestructura para investigar. Los percentiles de las fases interrumpidas y el reposo no se presentan como medidos: el cliente no emitió el resumen completo.

### Disco, cuotas y temporales

Muestreo de uso asignado, recuento de archivos/temporales, uso por empresa y espacio libre; la carga reutiliza claves acotadas, no intenta llenar el disco. Un probe adicional crea diez claves de 256 KiB y mide el crecimiento real. En el corto correcto: uso asignado inicial **45.056 bytes**, posterior **269.606.912 bytes**, máximo muestreado **527.876.096 bytes**, hasta cuatro temporales observados y cero tras quiescencia/reinicio. Diez claves nuevas de 256 KiB añadieron diez archivos y **2.662.400 bytes asignados** (payload 2.621.440), sin intentar llenar disco. Las 86 muestras de disco del ampliado están en su artifact, pero no se declara una limpieza final correcta tras el fallo. El volumen de ensayo usa driver local sin cuota de aplicación; no se confunde ese hecho con una cuota del proveedor ni se cambia el filesystem.

Siguen vigentes límites individuales 4/8/120 MiB y concurrencia 4/2/3; no existe contador persistente de bytes/archivos por usuario/empresa. Una cuenta autorizada puede crecer en nuevas claves. La propuesta estructural de inventario/reservas/atribución de fase 0.4 sigue pendiente, sin migración automática. El primer staging debe ser cerrado y con dataset acotado; no tráfico abierto ni datos de clientes.

El corto correcto de `13ed3c0` comprobó interrupción con temporal observado y reinicio: archivo válido por SHA-256, incompleto 404 y cero temporales. Los dos runs fallidos de `d64e947` no llegaron a ejecutar esa comprobación final ni la restauración posterior; no se les atribuye esa cobertura. Una salida 137 de SIGKILL intencional se distingue de `OOMKilled`.

### Backup/restauración sintéticos

Tras parar la instancia de origen, un helper aislado monta su volumen en **solo lectura**. Se crean otros dos volúmenes UUID: backup y restauración. `verifiedBackup` inventaría SHA-256, copia y ensaya una restauración interna con hashes; el espacio temporal de verificación está en el volumen de scratch, no en el tmpfs de 32 MiB. Después se restaura otra vez en el volumen independiente y se compara todo el inventario con el origen.

Se rechaza una copia corrupta sintética separada sin alterar el backup válido, y un destino existente no se sobrescribe. Antes de arrancar el restaurado, `sessions.json` se archiva privado **fuera** de DATA_DIR para impedir reactivar cookies antiguas. Se prueban nuevo login, cookie antigua 401, foto/media de A 200, acceso de B 403 y hash del archivo estable. El origen permanece sin modificar hasta el cierre del laboratorio; al final se destruyen exclusivamente los recursos sintéticos creados. No se conserva una copia operativa real por generar un artifact de métricas.

El corto correcto registró **24 archivos**, inventario agregado SHA-256 `9ccfe39c0fe61b95bb2be87d4b4d49d364fb31e4583fa481ac11c3e28d3cc124` idéntico en origen/restauración, copia con restore interno en **5.289 ms**, restore independiente en **3.602 ms** y recuperación hasta servicio/API verificados en **16.098 ms**. Cookie antigua 401, nuevas sesiones válidas, A 200 / B cruzado 403. El archivo estable conservó SHA-256 `238a88eccac1cb7d878234e3c406deeadb38c3a2186b41e790c4a6adf87c9bf9`. Corrupción rechazada, origen intacto hasta teardown. Es la última prueba válida de copia/restauración de esta fase (25/10/2026); los volúmenes fueron desechados al cerrar el laboratorio, no existe por ello un backup operativo real. Son RTO del laboratorio, no promesas del VPS. No se valida cifrado/almacenamiento fuera del servidor, pérdida del host ni backups de clientes.

## Requisitos bloqueantes antes de crear el staging real

1. **Dominio:** FQDN nuevo confirmado y autorización DNS/ACME acotada al nuevo nombre; TLS válido/renovación y perímetro en todas las rutas, también públicas, vendor y archivos firmados.
2. **Red:** confirmar que el panel permite red exclusiva sin adjuntar por defecto la overlay compartida de producción. Un proyecto nuevo no demuestra aislamiento. Si enrutarla exige modificar proxy/red global o añadir red de producción, no crear y presentar ese conflicto para autorización distinta.
3. **Swap/recursos:** verificar límites efectivos de Swarm. `memswap_limit` del Compose local no es garantía de traducción a servicio Swarm. Si no puede garantizarse sin modificar globalmente el VPS, detenerse, sin swapoff/sysctl ni aumento automático de RAM.
4. **Volumen/capacidad:** volumen nuevo UID/GID 1000, espacio libre y supervisión adecuados; nunca snapshot/bind de producción. En un mismo VPS CPU/disco/kernel siguen compartidos, no se promete independencia física o impacto cero.
5. **Código/imagen:** commit aprobado, digest base y candidato comprobados; si el panel solo acepta rama móvil, verificar mecanismo de pinning/imagen inmutable antes de habilitar acceso. Nada de auto-deploy.
6. **Recuperación:** destino externo protegido, política RPO/RTO/retención aprobada y restore real del nuevo staging antes de su uso sostenido; no restaurar sesiones obsoletas ni reasignar fotos ambiguas.

La autorización para una fase posterior debe enumerar proyecto, FQDN, volumen y red nuevos y permitir solo esas operaciones. Debe excluir main/merge, servicios existentes, producción, cambios globales, datos reales, compras y proveedores reales. Si la topología del panel no puede satisfacer estos límites, no se crea infraestructura como alternativa automática.

## Archivos y commits

| Archivos | Cambio |
|---|---|
| `Dockerfile`, `.github/workflows/ci.yml` | Base Node por digest/label, perfil largo selectivo, observaciones y recuperación, lectura de evidencia sintética en jobs con actions:read solo allí |
| `scripts/test-soak.mjs`, `lib/soak-analysis.mjs` | Memoria/CPU/disco, fases/reposo, estadísticas de RSS, crecimiento acotado y restore en otros volúmenes |
| `scripts/check-soak-clients.mjs`, `package.json` | Comprueba sintaxis e imports de módulos generados antes de ejecutar la carga |
| `scripts/analyze-soak-report.mjs`, `scripts/read-build-provenance.py` | Recupera telemetría de fallos sin convertirlos en éxito; intenta extraer solo digests públicos de logs |
| `scripts/prepare-staging.mjs`, `.gitignore` | Commit/hostname/base, presupuesto/red/perímetro; secretos separados privados e ignorados |
| `scripts/photo-storage.mjs` | Nuevo backup offline sin migración, usando verificación y restore existente |
| `tests/phase-05.test.mjs`, `tests/soak-analysis.test.mjs`, `tests/backup-cli.test.mjs` | Configuración, tendencia RSS y CLI de backup/restore sin overwrite |
| `deploy/easypanel-staging.md`, `docs/security/*`, `README.md` | Perfil exacto propuesto, evidencias, procedimiento, puertas y decisión |

Commits: `eb15b6f` preparación; `13ed3c0` corrige import de diagnóstico y lo valida; `d64e947` CLI/plan y ensayo largo; `b31f61e`, `b2f7f06`, `161e9ec` recuperan evidencia y separan diagnóstico/proveniencia opcional. El primer run falló en el harness por una ruta relativa antes de la carga ([evidencia](evidence/phase-05-initial-harness-failure.json)); se conserva separado del OOM de la aplicación. La primera extracción opcional de logs falló y canceló su job hermano; se separó del análisis y se eliminó ese fail-fast. Esa recuperación diagnóstica no es una corrección de memoria.

No se modifica el código funcional de uploads/autenticación. El cambio de build parametriza la base del Dockerfile para fijar el digest. El [plan revisable](evidence/phase-05-staging-plan.json) marca explícitamente `candidateApproved=false`; el digest propuesto procede del corto correcto, no se usa como afirmación de igualdad de todas las corridas. Formato validado no equivale a dominio/commit/imagen autorizados.

## Decisión y siguiente autorización

**No crear todavía el staging real.** La aplicación no supera de forma consistente la validación de memoria, y las capacidades reales de red/swap/volumen/TLS del panel no están verificadas. Un run posterior verde no cierra los dos OOM ni los requisitos externos.

Primero cerrar F05-MEM-01 en Docker sintético con medición menos intrusiva y evidencia repetida. Después autorizar, si procede, una verificación de metadatos del panel/capacidad sin leer secretos de aplicaciones. Solo si las puertas de aislamiento se satisfacen, autorizar la creación de los recursos nuevos enumerados en el plan, con perímetro cerrado y datos sintéticos, y comprobar recuperación externa antes de uso sostenido. Si el panel exige redes de producción o cambios globales, detenerse y presentar una alternativa; no ampliar recursos ni modificar servicios existentes automáticamente.

Para la primera creación el rollback es detener exclusivamente el servicio nuevo y conservar sus datos/copia hasta revisión, no desplegar main/vulnerable ni tocar otro servicio. Esta fase termina en el informe y PR en borrador: no hay fusión, despliegue ni solicitud implícita para operar producción.
