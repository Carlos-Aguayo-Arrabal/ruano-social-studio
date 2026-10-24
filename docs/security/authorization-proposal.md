# Autorización: límites actuales y propuesta pendiente (fase 0.2)

## Matriz actual, sin migrar usuarios

| Actor | Empresas | Gestión de usuarios | Administradores globales |
|---|---|---|---|
| Propietario de entorno (`owner`) | Todas | Agencias y administradores | Puede delegar/cambiar/revocar esos privilegios |
| `admin` | Todas: rol de plataforma de confianza | Puede gestionar cuentas `agency` | No puede crear, promover, cambiar ni borrar administradores, tampoco a sí mismo |
| `agency` | Solo las asignadas, comprobadas en servidor | Sin acceso | Sin acceso |

La UI identifica el rol como **Administrador global de plataforma** y oculta la
opción de crearlo a quien no sea propietario. Los límites se aplican en backend;
no dependen de botones ocultos. Los cambios se serializan y se revalida la sesión
del actor dentro de la cola antes de gestionar otra cuenta.

Los administradores existentes conservan acceso global a empresas, Drive y otras
funciones de plataforma. No convertir una agencia cliente en admin para darle
acceso a su equipo. No se han rebajado cuentas reales ni inventariado usuarios de
producción. Cambios de rol/permisos invalidan todas las sesiones afectadas; un
cambio de nombre visible por sí solo no revoca sesiones.

## Propuesta que requiere aprobación y migración independiente

No se implementa en esta fase: organización como cliente contractual, membresías
con roles por organización y marcas subordinadas. Separar propietario/admin de
organización, editor y revisor del superadministrador de plataforma. Aplicar la
organización a datos, archivos, cachés, trabajos, logs y conexiones externas.

Antes de migrar: inventariar asignaciones con autorización, identificar quién
administra cada organización, resolver cuentas compartidas y múltiples marcas,
aprobar la matriz por acción y comprobar permisos con dos organizaciones. No
inferir que todo `admin` actual pertenece a una organización concreta ni degradar
automáticamente sus permisos. Ensayar migración y rollback en copias sintéticas;
revocar sesiones al cambiar el modelo y nunca aceptar roles del navegador.

Hasta entonces la configuración es para un operador de plataforma de confianza
con cuentas de agencia asignadas, no un SaaS con administradores de tenant
independientes. No se añaden tablas ni migraciones automáticas de membresías.
