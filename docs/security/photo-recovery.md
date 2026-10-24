# Fotografías: copia, migración y recuperación offline

Este procedimiento no se ha ejecutado con datos reales. Las pruebas automatizadas verifican su comportamiento con datos sintéticos. No sustituye la comprobación de propiedad de cada fotografía ni la validación operativa del VPS.

## Preparar y revisar

1. Detener el servidor y todos sus workers/réplicas. No aceptar subidas, cambios de cartera ni tareas de copia durante la operación. La opción `--offline-confirmed` es una declaración del operador, no detiene servicios ni demuestra por sí misma que estén parados.
2. Comprobar que `DATA_DIR` corresponde a la instancia prevista y que el destino de backup es nuevo, privado, externo a ese directorio y con espacio suficiente. Proteger el backup: contiene usuarios, contactos y posiblemente tokens de integraciones. La herramienta verifica integridad; no cifra el almacenamiento.
3. Con el checkout revisado y Node >=22, generar un plan sin copiar ni modificar fotos:

```sh
node scripts/photo-storage.mjs plan /ruta/DATA_DIR > /ruta/revision/plan.json
```

4. Revisar `assignments` y `unresolved` contra evidencia independiente de la empresa propietaria. Un ID único en el JSON actual **no demuestra** por sí solo la procedencia histórica. Verificar todas las fotos del directorio. El plan nace con `ownershipVerified: false`; cambiar a `true` solo tras esa revisión. Se pueden retirar asignaciones no verificadas. Conservar el plan y la evidencia fuera de ubicaciones públicas.
5. Colisiones entre empresas, huérfanas y claves no válidas no se asignan automáticamente. Incluso un plan editado no puede forzar una asignación que siga siendo ambigua en el almacén actual. Recuperar esos recursos en una operación separada, con procedencia por fotografía y copia previa. No adjudicar todo un directorio mezclado a una sola empresa.

## Aplicar una copia, sin borrar el origen

Con la aplicación detenida y un plan revisado:

```sh
node scripts/photo-storage.mjs apply /ruta/DATA_DIR /ruta/BACKUP_NUEVO /ruta/revision/plan.json --offline-confirmed
```

El comando:

1. Revalida el hash de `store.json`, el inventario antiguo y las asignaciones.
2. Rechaza destinos existentes, symlinks y backup dentro de datos (incluyendo alias por symlink).
3. Copia **todo DATA_DIR** a `BACKUP_NUEVO/snapshot`, con un manifiesto SHA-256 fuera del snapshot. Verifica igualdad con el origen y detecta cambios durante la copia.
4. Restaura ese snapshot en un directorio temporal independiente y verifica todos los hashes. Si falla, no inicia la copia a `photos-v2`.
5. Copia cada asignación a `photos-v2/<brandId>/<propertyId>` y vuelve a comparar hashes. Nunca sobrescribe un destino existente ni borra `photos/`.

Conservar `snapshot`, `manifest.json`, plan y salida de la operación. Copiar el backup verificado a un soporte externo protegido según la política operativa. La copia local por sí sola no cubre pérdida del disco.

El procedimiento es conservador: una segunda aplicación sobre destinos ya existentes se rechaza para evitar sobrescrituras de cambios posteriores. No editar hashes para forzar su paso. Si hubo ejecución parcial, mantener la aplicación parada, comparar los resultados y recuperar a un directorio nuevo.

## Recuperar sin sobrescribir datos activos

```sh
node scripts/photo-storage.mjs restore /ruta/BACKUP_NUEVO /ruta/RESTAURACION_NUEVA
```

La restauración exige un destino inexistente y separado del backup. Verifica el snapshot antes de copiar y la restauración después. No reemplaza automáticamente un volumen de producción.

Para recuperación operativa: mantener servicios detenidos, conservar el directorio fallido, verificar hashes/recuentos y hacer smoke en la restauración. La activación del volumen y la imagen requiere una revisión operativa independiente. Volver a la imagen vulnerable anterior recuperaría H01/H02/H03: no exponerla públicamente como rollback. Si se vuelve a un snapshot previo al namespace nuevo, mantener el servicio restringido hasta completar la copia segura de fotos.

## Validar antes de activar

- Inmuebles con fotos: recuentos, hashes, orden, ajustes y portada correctos.
- Dos empresas con el mismo ID: carpetas distintas y bytes correctos en cada API/web/revisión.
- Usuario B sin acceso a marca A: consulta, descarga, ajustes, portada, subida y eliminación rechazados; archivos de A intactos.
- Fotos huérfanas y directorios ambiguos: permanecen conservados y sin acceso automático.
- Galería y reels: generación/exportación en navegador de staging; comprobar copia Drive del nuevo árbol con cuenta de prueba.
- Backup original legible y restauración verificable fuera del volumen activo.

La retención o eliminación del árbol antiguo no forma parte de esta fase. No ejecutar borrados por ahorrar espacio sin una decisión posterior y una copia recuperable.


## Diagnósticos ampliados en fase 0.1

Regenerar el plan con la versión revisada de la herramienta. Incluye `duplicateIds`
para IDs repetidos entre marcas **y dentro de la misma marca**. `unresolved.reason`
distingue `orphan`, `duplicate-property-id`, IDs/propietarios inválidos,
`invalid-or-incomplete-manifest` y `unreferenced-files`. Un archivo que no aparece
en el manifest impide asignar automáticamente todo ese directorio. No moverlo ni
borrarlo por esa razón; requiere procedencia y recuperación individual revisadas.

Los hashes del inventario se calculan por streaming; sigue siendo obligatorio
disponer de espacio para copias completas. El runtime devuelve 503 ante un índice
corrupto y no lo sustituye por uno vacío. Recuperar desde una copia verificada, no
editar el índice a ciegas para hacer desaparecer el error.

El ensayo específico para un proyecto/volumen nuevo está en
[staging-checklist.md](staging-checklist.md); los resultados reales y límites están
en [phase-01.md](phase-01.md). No se han operado datos de clientes.


## Sesiones después de una restauración (fase 0.2)

El snapshot completo puede contener `sessions.json`. Su integridad no acredita
que refleje revocaciones posteriores al backup. En el **directorio nuevo de
restauración**, antes de activarlo, preservar esa metadata como histórico 0600
fuera del registro activo y preparar un registro nuevo para exigir login de todos
los usuarios. Conservar el snapshot original: no borrar ni modificar la copia
que se utilizó para verificar recuperación. No recuperar sesiones activas de una
copia antigua ni usar una imagen que vuelva a aceptar cookies stateless.

Esta decisión debe estar incluida en el plan revisado del operador. No hay un
borrado automático de sesiones en la herramienta de fotos y no se ha ejecutado
sobre una restauración real. Ver [transición de sesiones](session-transition.md)
y [operación/límites de fase 0.2](phase-02.md).
