# WhatsApp RH Assistant — Render

MVP para responder mensajes de WhatsApp Business usando **Meta WhatsApp Cloud API + OpenAI Responses API**.

## Qué incluye
- `GET /webhook`: verificación del webhook de Meta.
- `POST /webhook`: recepción de mensajes de WhatsApp.
- Respuesta automática con OpenAI.
- Envío de respuesta por WhatsApp Cloud API.
- Validación opcional de firma `X-Hub-Signature-256` con `META_APP_SECRET`.
- Panel `/admin` con historial temporal, envío manual y pausa de IA por contacto.
- `GET /health` para Render.

## Importante sobre Render Free
Render Free puede dormir y reiniciar el servicio. Esta versión guarda historial, deduplicación y pausas **en memoria**, por lo que esos datos pueden perderse al reiniciar. El bot vuelve a funcionar al despertar porque las credenciales permanecen como variables de entorno. Para uso permanente, añade una base de datos persistente (por ejemplo Supabase/Neon o un plan de base de datos de pago).

## Variables obligatorias
- `OPENAI_API_KEY`
- `META_ACCESS_TOKEN`
- `META_PHONE_NUMBER_ID`
- `META_VERIFY_TOKEN`
- `ADMIN_TOKEN`

Recomendado:
- `META_APP_SECRET`

Variables de comportamiento:
- `OPENAI_MODEL=gpt-6-luna`
- `META_GRAPH_VERSION=v26.0`
- `COMPANY_NAME`
- `BUSINESS_CONTEXT`
- `BOT_RULES`

## Render
Este repositorio incluye `render.yaml`. Al crear un Blueprint o Web Service, Render puede usar:
- Build: `npm install`
- Start: `npm start`
- Health check: `/health`

No pongas ninguna clave en GitHub. Cárgalas únicamente como secretos/Environment Variables en Render.
