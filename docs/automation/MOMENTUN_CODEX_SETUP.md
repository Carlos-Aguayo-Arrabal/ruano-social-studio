# Momentun: orquestación sin API de pago

## Qué hace

El workflow `.github/workflows/momentun-codex.yml` consulta PR abiertas mediante `GITHUB_TOKEN` de permisos de solo lectura y crea el artefacto `momentun-siguiente-prompt` con un encargo **predefinido**. No llama a OpenAI, no requiere `OPENAI_API_KEY`, no escribe al repositorio ni ejecuta tareas en Codex Cloud.

En la propuesta se incluye `workflow_dispatch` y una programación diaria. GitHub ejecuta programaciones normalmente desde la rama predeterminada; por ello, **no está activada** mientras permanezca en PR de borrador. Una vez aprobada y fusionada separadamente, descargar el artefacto desde Actions. Los retrasos o saltos de tareas programadas de GitHub son posibles.

## Costes y límites

No hay consumo de tokens de API. GitHub Actions usa minutos de runner: en repositorios privados se descuentan de la cuota incluida del plan y podrían generar cargos **si la cuenta permite sobreconsumo facturable**. Revisar presupuesto/límites de facturación de GitHub antes de activar, o usar un runner propio aprobado. Se ha fijado `timeout-minutes: 5` y solo una ejecución diaria para minimizar consumo, pero esto no garantiza coste cero en todas las cuentas.

## Lo que no hace

- No envía prompts a una sesión Codex Cloud ni encadena ejecuciones.
- No detecta de manera fiable el fin real de cada fase a partir de pruebas, ni avanza la numeración por sí mismo.
- No interpreta riesgos complejos. Cada propuesta debe validarse manualmente.
- No fusiona, despliega, toca Hostinger, VPS, dominios, secretos ni datos reales.

## Siguiente nivel sin factura API

Para ejecución local podría utilizarse Codex CLI autenticado mediante ChatGPT, si el usuario dispone de acceso dentro de los límites de su suscripción, en un equipo de confianza. Requiere configuración y verificación separadas; no trasladar tokens de sesión a GitHub ni al repositorio. Otra vía para análisis gratuito sin modelo es ampliar reglas fijas de GitHub/n8n.
