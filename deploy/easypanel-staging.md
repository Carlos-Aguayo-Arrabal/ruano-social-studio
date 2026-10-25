# Perfil propuesto EasyPanel · staging aislado (sin aplicar)

Especificación de estado deseado, **no importador/API de EasyPanel**. No se ha consultado la versión/configuración del panel ni creado recursos. Ver el informe de fase 0.5 y el bundle generado. Los nombres de campos de UI dependen de versión: si un control no puede aplicarse, no se sustituye por un cambio global o una suposición.

## Entradas obligatorias antes de autorizar creación

1. Commit completo aprobado y ejecutado en CI; repositorio `Carlos-Aguayo-Arrabal/ruano-social-studio`. No desplegar automáticamente la rama móvil ni main.
2. Digest de Node 22 obtenido del build verificado; imagen candidata identificada. `Dockerfile` admite `NODE_IMAGE=node@sha256:…`. No considerar una etiqueta mutable equivalente a una imagen idéntica.
3. FQDN nuevo bajo un dominio cuya titularidad/uso se confirme, sin reutilizar una ruta de producción. `.example.invalid` es solo un placeholder: no es un dominio creado ni disponible para ACME.
4. Nombres de proyecto, volumen y red nuevos, capacidad libre y soporte de controles verificados mediante una tarea futura autorizada. No inspeccionar secretos de aplicaciones existentes.

Generación local, sin acceso a DNS/panel ni creación de infraestructura:

```sh
node scripts/prepare-staging.mjs /tmp/BUNDLE_NUEVO \
  --source-sha COMMIT_COMPLETO_APROBADO \
  --domain HOSTNAME_NUEVO_CONFIRMADO \
  --node-image node@sha256:DIGEST_VERIFICADO
```

Los marcadores deben sustituirse por valores revisados. Se generan directorio 0700, `synthetic.env` y `perimeter.env` 0600, `compose.yml` y `easypanel-plan.json`. No imprimir/importar ambos env indiscriminadamente: el servicio de aplicación recibe solo `synthetic.env`; el perímetro usa su secreto independiente. No registrarlos en Git/logs. La contraseña del perímetro debe transformarse en bcrypt mediante entrada privada y el mecanismo soportado del panel, nunca pegada en argumentos/logs públicos. Conservar los valores entre reinicios, no regenerar el bundle encima del existente.

## Servicio y almacenamiento deseados

| Parámetro | Valor |
|---|---|
| Proyecto | `plan.project`, UUID nuevo `ruano-stage-*` |
| Servicio | `studio`, nuevo en ese proyecto |
| Fuente | Repo autorizado, commit `plan.source.commit`; sin auto-deploy |
| Build | Dockerfile, lockfile, `NODE_IMAGE=plan.build.nodeImage` con digest; registrar commit/digest reales antes de habilitar acceso |
| Imagen | `plan.image`; verificar imagen construida y etiqueta OCI de revisión, no confiar solo en el nombre |
| Réplicas/procesos | 1 / 1 Node; sin cluster ni PM2 workers |
| Actualización/rollback | Stop-first, paralelismo 1; sin tareas superpuestas sobre el volumen, pausa ante fallo; no prometer cero downtime |
| Usuario | UID/GID 1000 |
| Puerto | Interno 3000; ninguna publicación directa de puerto en el host |
| Health | GET loopback `/health`, intervalo 30 s, timeout 3 s, inicio 5 s, reintentos 3 |
| CPU/RAM | 1 núcleo de cuota, 268435456 bytes; comprobar límites realmente aplicados |
| Swap | Desactivado para la tarea; verificar `memory.swap.max=0` y uso 0, sin `swapoff` global ni sysctl del VPS |
| Seguridad | Raíz readonly, sin privilegios/capabilities, no-new-privileges, 128 PIDs; sin socket Docker |
| Temporal | `/tmp` tmpfs 32 MiB, noexec/nosuid; datos de carga temporal en el volumen, no en RAM |
| Volumen | `plan.volume.name`, nuevo/vacío, exclusivo, `/app/data`, propietario 1000:1000; nunca bind ni snapshot de producción |
| Dataset | Sintético acotado, presupuesto operativo 1 GiB; alertar al 70 %, suspender nuevas pruebas al 80 % hasta revisión |
| Disco libre | Al menos 8 GiB para dataset, temporales, snapshots/restauración y margen; comprobar realidad del host en la tarea autorizada |

El presupuesto no es una cuota de disco implementada. Las cuotas actuales son receptores 4 globales / 2 usuario / 3 empresa, no consumo acumulado. No ejecutar este staging desatendido o abierto mientras falten límites/monitorización apropiados. No cambiar cuotas o filesystem de producción para satisfacer el ensayo.

## Variables de la aplicación

`NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/app/data`, `PUBLIC_URL=https://FQDN_NUEVO`, `APP_USERNAME`, `APP_PASSWORD` y `APP_SESSION_SECRET` sintéticos propios del bundle. `OLLAMA_URL=http://127.0.0.1:1`; sin claves SMTP/Meta/Drive/IA/Telegram reales. No copiar `.env` de otra aplicación. No entregar `perimeter.env` al contenedor de Node.

`PUBLIC_URL` debe coincidir exactamente con el origen TLS. Si el dominio cambia antes de activar la tarea, preparar explícitamente esa nueva configuración; no alterar dominios ya operativos ni activar un wildcard.

## Red, dominio y TLS: puerta bloqueante

- Red nueva exclusiva indicada en `plan.stagingEdgeNetwork.name`; no reutilizar `easypanel`, ingress/overlay u otra red si da acceso a producción. Un proyecto distinto por sí solo no prueba aislamiento.
- Antes de crear el servicio, confirmar que la versión del panel permite evitar redes compartidas por defecto. El Compose `network_mode: none` es un ensayo Docker local: no se presenta como configuración Swarm importable.
- Tráfico de aplicación limitado al nuevo ingreso de staging; sin egress a Internet/proveedores/redes privadas. Resolver DNS o pertenecer a una red no demuestra que el tráfico esté bloqueado: verificar especificación y reglas efectivas con canarios sintéticos autorizados, nunca sondear clientes reales.
- El proxy debe ser gestionado por EasyPanel. No modificar su servicio global, redes, entrypoints, certificados, firewall o SSH existentes bajo la autorización de crear solo staging. Si enrutar la red exclusiva exige tocar el proxy o adjuntarse a una red de producción, **no crear**: elevar ese conflicto de alcance, sin instalar un proxy paralelo automáticamente.
- Dominio/ruta exclusivos, HTTPS válido (mínimo TLS 1.2), redirección HTTP y renovación demostradas; no desactivar verificación TLS. Comprobar ACME y DNS solo para el nuevo nombre tras autorización.
- Autenticación perimetral/allowlist antes de enrutar **todas** las rutas: `/`, login, APIs, `/w`, `/r`, `/m`, formularios, `/vendor`, robots/sitemap y health externo. Health interno usa loopback. No basta el login de la app ni un path secreto.
- Proxy sobrescribe Host/X-Forwarded-Host/Proto; no confiar en cabeceras del cliente. Límite de cuerpo debe aceptar 120 MiB y rechazar exceso; timeouts coherentes con XHR (5 min), sin buffering ilimitado en RAM/disco del proxy.

Swarm no ofrece en sus límites habituales una traducción directa garantizada de `docker run --memory-swap`; el JSON de referencia no demuestra que el panel pueda aplicarla. Si el host tiene swap activo y no puede garantizarse el límite de esa tarea sin un cambio global, detenerse. No afirmar equivalencia con el Docker aislado probado.

Si se usa el mismo VPS, CPU, disco y kernel siguen compartidos. La separación propuesta es de datos, credenciales y red, no independencia física ni garantía de impacto cero sobre otros servicios. Capacidad y topología reales no están comprobadas.

## Recuperación y aceptación antes de exponer

Backup offline consistente de todo DATA_DIR, env/config/versiones guardados aparte de forma privada, SHA-256 y restauración a volumen nuevo. No reactivar `sessions.json` de un snapshot antiguo: archivarlo privado fuera del DATA_DIR activo y crear sesiones nuevas. Revalidar A/B, fotos, hashes, 403 cruzado, 404 incompletos y salud; originales y backup conservados hasta revisión. Política propuesta: snapshot antes de cada actualización del staging y al terminar una sesión de pruebas; RPO equivale al último snapshot offline, RTO debe medirse en el entorno real. Ninguna política borra copias existentes automáticamente.

El ensayo de CI comprueba integridad y funcionamiento en volúmenes nuevos; **no prueba almacenamiento externo cifrado ni pérdida del VPS**. Ver `docs/security/photo-recovery.md`. No activar el staging si dominio/red/recursos/backup externo no cumplen sus puertas. No ampliar recursos, contratar infraestructura o alterar producción como alternativa automática a un bloqueo.
