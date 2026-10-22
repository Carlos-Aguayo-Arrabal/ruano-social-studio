# Seguridad de Meta — revisión previa al despliegue

Esta rama no modifica la producción ni la rama principal.

## Cambios
- La publicación manual en `/api/meta/publish` exige que el contenido esté `approved` o `scheduled` (HTTP 409 en caso contrario).
- `publishItem` también rechaza contenidos que no estén aprobados/programados.
- Los tokens de página se guardan cifrados mediante AES-256-GCM en los archivos `data/meta/*.json`.
- La primera lectura de un archivo antiguo con tokens en claro lo reescribe cifrado.

## Precauciones antes de fusionar
1. Realizar copia de seguridad del volumen persistente `/app/data` y de las variables de configuración **sin compartir los secretos**.
2. Mantener fijo `APP_SESSION_SECRET`: de él se deriva la clave de cifrado. Si se cambia, será necesario reconectar Meta o migrar los tokens antes.
3. Las copias de seguridad antiguas pueden contener tokens sin cifrar. Protegerlas y aplicar una política de eliminación segura.
4. Revisar permisos del volumen `/app/data` y acceso a las copias externas.
5. Probar en staging OAuth, selección de página, publicación aprobada, rechazo de borrador y programación, usando una cuenta de prueba.
6. La protección de publicación está aplicada en el momento de iniciar el trabajo: revisar posibles carreras si un usuario edita el estado durante una publicación en curso.
7. Verificar en staging que los archivos `data/meta/*.json` contienen `encryptedTokens` y no `tokens`.

## Limitaciones restantes
- No se ha comprobado la configuración de Meta en EasyPanel ni se han realizado publicaciones reales.
- PostgreSQL no se ha incorporado todavía: los datos de la aplicación siguen en JSON.
- La clave de cifrado debería separarse de la clave de sesión en una evolución posterior, con migración de claves planificada.
