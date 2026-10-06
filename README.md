# Social Studio — piloto multiempresa

Primera fase para convertir el planificador en una aplicación compartida: login por usuario, membresías owner/editor/viewer y datos persistentes en PostgreSQL. Owner y editor pueden preparar, aprobar y planificar; viewer solo puede consultar. No hay alta pública ni cambios de permisos desde la web: las altas se realizan mediante administración en consola.

## Incluido

- Sesiones revocables de 12 horas, token aleatorio y hash almacenado en PostgreSQL; contraseña derivada con scrypt.
- Comprobación de membresía en cada lectura y guardado; organizaciones filtradas por el usuario autenticado.
- Contenidos, inmuebles y paso del flujo guardados por empresa; control de versión para impedir sobrescrituras entre usuarios.
- Nombres y textos escapados en la interfaz; bloqueo de edición y exportación de cambios si falla el guardado.
- Fichas editables de inmuebles (referencia, precio, superficies, ubicación, características y enlace), cuatro borradores derivados solo de campos rellenados, edición de texto y descarga del paquete en TXT. Cambiar un texto lo devuelve a pendiente de aprobación. Las modificaciones de ficha no sobrescriben borradores existentes.
- Entrada manual de inmuebles y borradores de plantilla. No se introducen inmuebles ni publicaciones de demostración en nuevas empresas.
- Perfil de marca por empresa: nombre, lema, web, teléfono, color y logotipo PNG/JPEG de hasta 300 KB. Solo owner puede cambiarlo; editor debe conservarlo y viewer consulta. El logotipo heredado de Ruano se usa únicamente para su empresa hasta configurar su marca.
- Inmueble seleccionado persistente para continuar tras recargar. Aprobación de paquete en un solo guardado; rechaza textos vacíos y nueva programación en el pasado. Calendario editable y contador de próximas 14 jornadas.
- JavaScript externo con CSP sin unsafe-inline para scripts.
- Editor de fotos local; al cambiar empresa se limpia su sesión de edición. Las fotos no se suben ni persisten en el servidor.

## Pendiente

Integración con n8n, scraping real, IA, subida de fotografías, invitaciones por email, recuperación de contraseña, suscripciones y límites comerciales. Un contenido planificado no se publica en redes.

Los datos antiguos en localStorage se conservan en el navegador pero no se importan automáticamente a ninguna empresa. Antes de migrar, exportarlos, confirmar su propietario y preparar una importación validada.

## Preparar un entorno aislado

No sustituir el servicio actual: crear otro servicio EasyPanel desde la rama del piloto y una base dedicada en PostgreSQL 16 o 17. Mantener los datos fuera del filesystem efímero del contenedor. No publicar PostgreSQL en Internet.

Variables de la aplicación:

- DATABASE_URL: conexión interna de un usuario de aplicación con privilegios mínimos, sin superusuario ni BYPASSRLS.
- APP_ORIGIN: origen HTTPS exacto del piloto, sin ruta ni barra final; por ejemplo https://studio-piloto.tu-dominio.es.
- NODE_ENV=production, PORT=3000.

Este Dockerfile ejecuta Node en el puerto **3000**, no el Nginx anterior en 80. Ajustar el puerto del servicio piloto. /health comprueba conectividad con la base. No cambia automáticamente el esquema al arrancar.

Instalar dependencias para desarrollo con npm ci. Ejecutar npm run migrate usando una conexión de administración/migración, y después usar exclusivamente la conexión restringida para arrancar la aplicación. Si la aplicación ya ha arrancado antes de migrar, fallará deliberadamente.

Privilegios orientativos para un rol precreado rss_app; aplicar en la base dedicada con el propietario de las tablas, adaptando nombres:

```sql
GRANT USAGE ON SCHEMA public TO rss_app;
GRANT SELECT ON rss_users, rss_organizations, rss_memberships TO rss_app;
GRANT SELECT, INSERT, DELETE ON rss_sessions TO rss_app;
GRANT SELECT, UPDATE ON rss_states TO rss_app;
```

No usar la cuenta de aplicación para crear tablas o provisionar usuarios. Esta fase aplica aislamiento en servidor mediante consultas parametrizadas y membresías; no implementa RLS. Probar con el rol PostgreSQL que se utilizará en el piloto.

## Alta administrativa

Con DATABASE_URL de administración configurada solo en la consola de administración:

```bash
npm run migrate
read -rs -p 'Contraseña nueva (mínimo 12 caracteres): ' rss_password
printf '\n'
printf '%s' "$rss_password" | node scripts/admin.mjs provision usuario@example.test 'Empresa de prueba' owner
unset rss_password
```

El comando devuelve el ID de empresa. Para añadir otro usuario a esa empresa, recoger su contraseña del mismo modo y usar:

```bash
printf '%s' "$rss_password" | node scripts/admin.mjs assign colaborador@example.test ID_DE_EMPRESA editor
unset rss_password
```

No pasar contraseñas como argumentos ni guardarlas en el código. Si el usuario ya existe, estos comandos conservan su contraseña. Repetir provision siempre crea una empresa nueva. assign puede modificar el rol de una membresía existente: comprobar que es el usuario y empresa previstos.

## Verificación antes de un piloto

npm run check y npm test. Las pruebas usan PostgreSQL embebido PGlite y un DOM simulado: cubren SQL, autenticación, aislamiento, rol viewer, CSRF, sesiones, conflicto de versiones, escape HTML y cambio de empresa. No sustituyen una prueba contra PostgreSQL 16/17 ni una comprobación de navegador real.

En el entorno aislado: crear dos empresas y usuarios, abrir sesiones separadas, crear contenido, recargar, cambiar empresa, manipular el ID de empresa en llamadas API y comprobar denegación. Probar también un usuario viewer, dos ediciones concurrentes, logout y revocación de membresía. Construir y comprobar la imagen Docker; no se ha construido en el entorno de desarrollo por ausencia de Docker.

El limitador de login en memoria permite 10 intentos por email y 100 por dirección de conexión cada 15 minutos. Detrás de Traefik esta dirección puede ser la del proxy: añadir límites en el proxy con configuración de cabeceras confiables, sin aceptar X-Forwarded-For arbitrario. Con varias réplicas se requiere un limitador compartido. CSP permite scripts exclusivamente del propio origen; los estilos aún permiten unsafe-inline por la interfaz heredada.

## Copias y rollback

Preparar backup consistente de PostgreSQL y verificar restauración antes del piloto. No hay migración destructiva del servicio antiguo. Para rollback del piloto, retirar su routing o volver a la imagen anterior del piloto; conservar la base. No cambiar ni fusionar main hasta revisar el resultado. El despliegue automático de main puede afectar producción.
