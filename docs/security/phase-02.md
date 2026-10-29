# Fase 0.2 · sesiones revocables y autorización · 24/10/2026

## Entrega y compatibilidad

Misma rama `security/phase-0-2026-10-24`, PR [#3](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/pull/3) en borrador. Sin fusión, despliegue, operaciones en Hostinger, cambio de credenciales existentes ni datos de clientes.

**Cambio incompatible:** todas las cookies stateless de las versiones anteriores
serán rechazadas. Los usuarios deben volver a entrar una vez al activar esta
versión. La estrategia se documentó **antes de implementar**, en el commit
`afd1065`, [session-transition.md](session-transition.md); el código siguió en
`dada4f6`. No se conservan cookies antiguas como fallback ni se convierten usuarios,
contraseñas, empresas o fotografías. No se ha activado esa transición en producción.

## Archivos y controles

| Archivo | Cambio |
|---|---|
| `lib/sessions.mjs` | Allowlist persistente de tokens opacos, hashes, caducidad, limpieza, cuotas y escritura atómica con fsync |
| `server.mjs` | Login espera persistencia, logout revoca en servidor, currentUser consulta registro y permisos actuales, gestión de usuarios serializada y revocación por cambios, health 503 si el almacén falla; resultados IA ligados al binding de seguridad del creador |
| `index.html` | Identifica administración global y limita sus controles de delegación al propietario; backend exige esos mismos límites |
| `tests/helpers.mjs` | Credenciales sintéticas estables entre reinicios de una fixture; login con contraseña sintética sustituida |
| `tests/sessions.test.mjs` | Logout, dos dispositivos, dos empresas, contraseña, desactivar/reactivar, permisos, promoción/democión, borrado, cookies v1 válidamente firmadas, reinicio, caducidad, cuotas, recuperación y fallos de disco |
| `tests/browser.test.mjs` | Chromium: logout, reinyección de cookie copiada, rechazo y continuidad de otra empresa tras reinicio |
| `scripts/test-docker.mjs` | Docker: cookie revocada sigue rechazada y otra activa sigue válida después de reiniciar |
| Documentación | Transición previa, este informe, propuesta de autorización y actualizaciones de staging/recuperación/estado GitHub |

Las validaciones H01/H02/H03 y de la fase 0.1 se mantienen. Nodemailer sigue 10.2.1.

## Almacenamiento y persistencia

- Cookie `ruano_session=v2.<64 dígitos hexadecimales>`: token aleatorio de **256 bits**;
  dos logins del mismo usuario generan tokens diferentes. Se conservan HttpOnly,
  SameSite=Lax y Secure en producción, también al borrar la cookie.
- `DATA_DIR/sessions.json`, versión 2. Cada fila contiene hash SHA-256 del token,
  UID, binding HMAC y timestamps. **No contiene cookie, token en claro, contraseña
  ni secreto de firma**. No hay listado HTTP de registros ni logging de cookies.
- Binding HMAC con `APP_SESSION_SECRET`: usuario, hash/versionado de contraseña,
  estado, rol y conjunto de empresas; propietario vinculado a sus credenciales de
  entorno. Se compara contra el usuario actual en cada petición. Cambiar esas
  credenciales en una configuración futura invalida sesiones tras reinicio.
- Login y revocación se serializan; fichero temporal exclusivo privado **0600**,
  fsync del archivo, rename y fsync del directorio antes de confirmar. El registro
  en memoria solo cambia tras la persistencia. La garantía depende de un FS que
  respete esas operaciones; no se ha probado un corte eléctrico ni FS remoto.
- TTL absoluto **12 horas**, sin extenderlo por actividad. Expiradas se rechazan
  inmediatamente. Limpieza al arrancar, al crear sesión y cada **60 segundos**.
  La limpieza periódica también elimina bindings invalidados. Si nada cambia no
  reescribe el archivo; logout desconocido no crea una lista de revocaciones.
- Logout elimina únicamente su sesión. Borrar usuario, desactivar, cambiar
  contraseña, rol o empresas invalida todas sus sesiones y conserva las de los
  demás. Reactivar/reasignar no resucita cookies eliminadas. El nombre visible no
  se considera un cambio de seguridad.
- Se comprueban existencia, estado y permisos actuales además de la sesión. Una
  petición ya autorizada/en curso puede terminar; no hay cancelación retroactiva.
  Los cambios por archivo directo no tienen hot reload: deben hacerse offline y
  reiniciar. La vía probada es la API de gestión.

Los trabajos de IA también conservan ese binding: cambiar permisos/rol o
contraseña impide recuperar resultados antiguos incluso después de volver a
autenticarse. No se cancelan operaciones de proveedor que ya estaban en curso.

### Fallos y recuperación

Archivo corrupto, formato desconocido, symlink o tamaño excesivo impiden un
arranque autenticado seguro; no se resetean silenciosamente. Un fallo de
persistencia durante ejecución deja la instancia con autenticación cerrada,
respuestas 503 y health 503. Un logout fallido **no** se comunica como éxito:
corregir almacenamiento antes de considerar confirmada su revocación. Reiniciar
sin reparar un fallo puede cargar el último estado confirmado, no una revocación
que nunca terminó. No se intenta seguir con validación stateless.

El almacén y `users.json` no forman una transacción de base de datos. Si la cuenta
ya cambió y falla la limpieza del registro, el binding la invalida y la instancia
queda cerrada; no se confirma un control de usuarios como si todo se hubiera
guardado. No se ha ensayado cada punto de corte eléctrico entre ambos archivos.

**Un único proceso/réplica por DATA_DIR.** No coordina varios procesos, hosts o
réplicas mediante locks distribuidos. Una copia del archivo a otra instancia no
sincroniza logout. Mantener una sola réplica hasta diseñar un backend de sesiones
compartido con garantías y probarlo.

**Restaurar un backup antiguo puede reactivar sesiones que estaban vigentes en
esa copia.** Antes de activar una restauración se debe preservar esa metadata
como histórico privado y usar un registro nuevo de sesiones en el directorio
restaurado, exigiendo nuevo login. No restaurar cookies/registro antiguo para
recuperar accesos. La prueba de recuperación con registro nuevo mantiene el
histórico y rechaza cookies anteriores. No se cambió automáticamente la
herramienta de fotos para borrar metadata ni se operaron datos reales.

## Límites y consumo

| Recurso | Control / evaluación |
|---|---|
| Cookie v2 | 67 caracteres para el valor; formato exacto antes de buscar/hash. No hay crecimiento de payload con los permisos |
| Sesiones globales | **2.000** registros; altas adicionales rechazan con **429**, no expulsan sesiones ajenas |
| Sesiones por usuario | **20** activas; límite 429. Logout o caducidad permite nuevas altas |
| Archivo | **2 MiB** máximo al cargar/persistir; se rechaza sin truncarlo. Con 2.000 registros del formato actual y UID máximo, estimación serializada de 506.026 bytes; no es un benchmark de disco |
| RAM/escrituras de sesiones | Map acotado y operaciones O(n) con n≤2.000; snapshots/serialización por mutación y cola en proceso. No hay prueba de carga/latencia p95 ni límite global de conexiones/solicitudes en cola |
| Fotos/estado/vídeo | Siguen 4 MiB por foto, 5 MiB por sync y hasta 120 MiB por vídeo; buffers completos, sin cuota total por empresa |
| Docker | Smoke con 1 CPU/256 MiB y dataset pequeño; no acredita que un vídeo de 120 MiB y sus copias en memoria quepan en ese límite |
| IA/rate limits | Cola IA y contadores globales, mapas por IP/token y recursos de imágenes/reels pendientes de límites integrales. El límite de sesiones no los resuelve |

Para una fase posterior: cuotas por organización, streaming de vídeos, límites de
concurrencia/cola/tamaño acumulado y limpieza de mapas, rate limit global y por
usuario delante del hash de contraseña, capacidad del disco/alertas y pruebas de
carga con métricas reales. No se ha ampliado memoria del VPS ni alterado redes.

## Pruebas y evidencia

- Suite local: **58/58 pruebas** en Node 22 y Node 24, incluidas Chromium; los
  recuentos definitivos y jobs de HEAD se registran en la PR.
- Se prueba una cookie v1 con firma correcta generada con una clave **sintética**:
  ahora recibe 401. No se confunde con una simple firma inválida.
- Dos sesiones A y una B: logout A1 → 401; A2/B → 200, igual tras reinicio. API de
  fotos de A sigue denegada a B. No se reutilizan cookies reales.
- Contraseña, desactivar/reactivar, empresas, rol, borrado: invalidación inmediata
  y tras reinicio, cookies anteriores sin recuperación de permisos. Sesiones B no
  afectadas. El propietario del fixture aprueba promociones; admin no propietario
  no puede delegarlas ni modificar otros administradores.
- Unidad con reloj controlado: TTL y limpieza sin sleeps de 12 horas; cuotas 429,
  hashes y permisos 0600; errores de archivo sin reset y fallo de escritura 503.
- Chromium: navegar a logout, reinyectar cookie antigua y obtener login; sesión B
  independiente conserva acceso después del reinicio del servidor.
- CI del código `dada4f6`: [push 40123931532](https://github.com/Carlos-Aguayo-Arrabal/ruano-social-studio/actions/runs/40123931532)
  verifica jobs Node 22, Node 24 y Docker **success**; esa revisión tenía 57 casos,
  antes de añadir la prueba de recuperación con registro nuevo. CI de HEAD se
  enlaza en la PR, para no atribuir a un SHA pruebas añadidas después.
- Docker construye la imagen y comprueba salud, usuario/permisos, volumen,
  persistencia de fotos, **cookie revocada rechazada y cookie activa válida tras
  restart**; sin red, puertos, bind mounts ni servicios de producción.
- `npm audit` sin avisos en la consulta de esta fase; la auditoría sigue siendo
  bloqueante, no se ha omitido el control para obtener CI verde.

No se declara éxito de una migración o despliegue en Hostinger. Los resultados
remotos se verifican mediante estados de cada job/paso; las limitaciones de
lectura de ZIP de logs/artefactos del entorno siguen documentadas en fase 0.1.

## Autorización y pendientes

[Matriz y propuesta](authorization-proposal.md): `admin` es global y de confianza;
`agency` solo sus empresas. **Solo owner gestiona administradores**, mientras los
otros admins gestionan agencias. Los actuales no se convierten en administradores
de tenant ni se rebajan automáticamente. El modelo organización/membresía,
editor/revisor y una migración de asignaciones requiere aprobación independiente.

La revocación en servidor no retira datos ya descargados. La aplicación conserva
copia local/drafts en localStorage; no se borraron automáticamente para no perder
cambios pendientes. Antes de equipos compartidos/clientes reales, definir caché
por usuario/permisos, vaciado de vistas al 401 y conciliación de borradores. No se
presenta esa limpieza de cliente como implementada.

La revocación de sesión no revoca enlaces públicos independientes de revisión o
medios firmados. Son autorizaciones bearer distintas; al retirar acceso debe
evaluarse su rotación/revocación por separado, sin invalidar silenciosamente
entregas del cliente. No se introdujo una migración automática de esos enlaces.

Siguen pendientes MFA, recuperación de cuentas, modelo tenant/admin, CSP estricta,
recursos globales, cifrado de tokens, publicación Meta recuperable y validaciones
de TLS, proveedores y recuperación externa. Recomendación: ensayo aislado con
datos sintéticos; **sin autorización de integración ni producción**. El riesgo de
replay tras logout confirmado en fase 0.1 queda corregido en esta implementación.
