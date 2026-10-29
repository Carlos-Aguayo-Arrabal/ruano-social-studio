# Fase 0.2 · estrategia de sesiones (documentada antes de implementar)

## Impacto incompatible y transición propuesta

Las cookies anteriores son tokens firmados sin registro del lado servidor. No es
posible revocarlas individualmente de forma persistente conservando ese formato
sin introducir una lista de revocación que crezca con todos los tokens antiguos.

Se introduce una cookie opaca `v2.<token aleatorio>` registrada mediante su hash en
`DATA_DIR/sessions.json`. **Todas las cookies anteriores se rechazarán** y los
usuarios tendrán que volver a iniciar sesión una vez al activar esta versión.
No habrá aceptación de tokens antiguos como fallback. No se cambian contraseñas,
credenciales, usuarios, empresas, fotos ni contenidos. La presente fase solo se
prueba con datos sintéticos; no activa esta transición en producción.

Despliegue futuro: revisar y anunciar el cierre de sesiones, comprobar volumen y
permisos, parar la instancia anterior y activar una única instancia nueva. No
mezclar versiones: la anterior seguiría aceptando cookies sin revocación. No
hacer rollback público al servidor antiguo para recuperar sesiones. Si falla el
almacén nuevo, detener/reparar la instancia: no convertir un error de lectura en
un almacén vacío silencioso ni seguir con validación stateless.

## Garantías de diseño

- Tokens independientes de 256 bits, hash SHA-256 como clave, sin token/cookie ni
  contraseña en disco o logs. Archivo privado 0600 y escritura temporal/rename.
- TTL absoluto de 12 horas, sin renovación automática. Logout elimina solo esa
  sesión y espera confirmación de disco antes de confirmar éxito.
- La sesión se vincula mediante HMAC a identidad, versión, contraseña, rol y
  empresas asignadas; las del propietario incluyen sus credenciales de entorno.
  Cambios de seguridad invalidan sesiones en cada petición y tras reinicios.
- Los cambios de contraseña, desactivación, rol o empresas por API revocan las
  sesiones afectadas. Cambiar solo el nombre visible no exige cierre de sesión.
- Persistencia en un único proceso/volumen. Las revocaciones sobreviven al
  reinicio; el almacén no es una base compartida entre réplicas.
- Limpieza al iniciar, al crear y periódica; límites previstos 2.000 sesiones
  globales y 20 por usuario, con rechazo explícito en lugar de crecimiento
  ilimitado. Un archivo mayor de 2 MiB o corrupto impide inicialización segura.
- Un fallo de persistencia deja autenticación cerrada en esa instancia. Si logout
  devuelve error, no se afirma que la revocación haya quedado persistida.

## Límites administrativos sin migrar usuarios

`admin` sigue significando administrador global de plataforma, nunca
administrador de una sola empresa. `agency` solo accede a sus empresas. El
propietario definido por entorno controla la delegación de privilegios admin;
los otros administradores no deben crear, promover ni modificar administradores.
No se convierten usuarios existentes ni se crean organizaciones/membresías
nuevas automáticamente. El administrador de empresa requiere una propuesta y
migración revisada en una fase posterior.

## Recuperación y recursos

Restaurar un backup antiguo de sesiones puede revivir tokens revocados después
de esa copia. Antes de activar una restauración, preservar ese archivo como
histórico privado y arrancar con un almacén nuevo de sesiones en el directorio
restaurado; obligar reautenticación. No hacerlo sobre datos reales en esta fase.
No interpretar un backup íntegro como una lista de revocación actualizada.

Los límites del almacén no resuelven cuotas de vídeo, mapas de rate limit,
procesamiento de imágenes, cola IA o concurrencia multiinstancia. Se documentan
por separado; esta fase no migra a Redis/PostgreSQL ni introduce roles por tenant.
