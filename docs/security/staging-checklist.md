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
