# Momentun — activación controlada de Codex (Social Studio)

**Estado: propuesta no activada.** Este archivo pertenece a la rama `automation/momentun-codex-orchestrator`. El workflow solo podrá despacharse normalmente desde la rama predeterminada una vez revisado e integrado. No hay ejecución automática por finalización de PR y no se realiza `git push`, `merge` ni `deploy`.

## Requisitos previos (requieren autorización)

1. Revisar el diff de la PR de automatización y la documentación de la acción `openai/codex-action@v1`.
2. Comprobar política de seguridad, titularidad y límite de gastos de la API; usar una clave restringida y separada, guardada como **GitHub Actions secret** `OPENAI_API_KEY`. No pegar claves en archivos ni en conversaciones.
3. Configurar la variable de repositorio `MOMENTUN_CODEX_ENABLED=true` solo después de autorizar el coste. Su ausencia mantiene el job omitido.
4. Autorizar la incorporación del workflow a la rama predeterminada mediante revisión humana. Sin ese paso, `workflow_dispatch` no es una integración activa.
5. Ejecutar la acción manualmente una vez y revisar coste, logs, salida, permisos y sanitización de artefactos.

## Funcionamiento y límites

- Se activa **manualmente** (`workflow_dispatch`), no al terminar GitHub Actions. Produce solo un informe y un prompt propuesto en un artefacto con retención de siete días.
- Usa checkout de la rama predeterminada. **No asume que las PR pendientes estén integradas**; sus resultados deben consultarse por separado. No usa documentos locales de Codex Cloud.
- `permission-profile: :read-only` y `safety-strategy: drop-sudo` son medidas de defensa en profundidad, no sustituyen la revisión de los datos que puedan aparecer en logs o artefactos.
- No existe conexión de escritura con una sesión abierta de Codex Cloud, ni flujo n8n configurado: **no encadena la ejecución de fases**.
- La clave API y cualquier ejecución facturable requieren una decisión explícita del propietario; no hay límite económico impuesto por este YAML.
- Antes de activar la ejecución automática se necesitarán detección fiable de SHA/PR, idempotencia, estado persistente de fases, aprobación de permisos y parada por errores.

## Política de seguridad

Sin datos reales, secretos, Hostinger, producción, modificaciones de main, despliegues, merges ni compras. Cualquier resultado es una propuesta para revisión humana.
