import express from "express";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);

// MVP Render gratuito: estado en memoria. El bot responde normalmente, pero historial/pausas
// se reinician cuando Render duerme o reinicia el servicio. Para producción se añade DB persistente.
const conversations = new Map();
const seenMessages = new Map();
const MAX_HISTORY = 12;
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

function cfg(name, fallback = "") {
  return process.env[name] || fallback;
}

app.get("/", (_req, res) => res.redirect("/admin"));
app.get("/health", (_req, res) => res.json({ ok: true, service: "whatsapp-rh-assistant", storage: "memory" }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === cfg("META_VERIFY_TOKEN")) {
    return res.status(200).send(challenge || "");
  }
  return res.sendStatus(403);
});

// Captura cuerpo raw para validar firma de Meta y después parsea JSON.
app.post("/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from(req.body || "");
  if (!verifyMetaSignature(raw, req.get("x-hub-signature-256"))) {
    return res.status(401).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).send("Bad JSON");
  }

  // Meta necesita 200 rápido; procesamos fuera de la respuesta HTTP.
  res.status(200).send("EVENT_RECEIVED");
  setImmediate(() => processWebhookPayload(payload).catch(err => console.error("Webhook processing error", err)));
});

app.use(express.json({ limit: "256kb" }));

app.get("/admin", (_req, res) => res.type("html").send(adminHtml()));

app.get("/api/admin/conversations", requireAdmin, (_req, res) => {
  const rows = [...conversations.entries()].map(([phone, c]) => ({
    phone,
    name: c.name || "",
    paused: !!c.paused,
    updated_at: c.updatedAt,
    last_message: c.history.at(-1)?.content || "",
  })).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  res.json({ ok: true, conversations: rows });
});

app.get("/api/admin/conversations/:phone", requireAdmin, (req, res) => {
  const c = conversations.get(req.params.phone);
  res.json({ ok: true, conversation: c ? { phone: req.params.phone, ...c } : null });
});

app.post("/api/admin/conversations/:phone/pause", requireAdmin, (req, res) => {
  const c = getConversation(req.params.phone);
  c.paused = Boolean(req.body?.paused);
  c.updatedAt = new Date().toISOString();
  res.json({ ok: true, paused: c.paused });
});

app.post("/api/admin/conversations/:phone/send", requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "text_required" });
    const phone = req.params.phone;
    const result = await sendWhatsAppText(phone, text);
    addHistory(phone, "assistant", text, "manual");
    res.json({ ok: true, wa_message_id: result?.messages?.[0]?.id || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`whatsapp-rh-assistant listening on ${PORT}`);
});

function verifyMetaSignature(rawBody, signature) {
  const secret = cfg("META_APP_SECRET");
  if (!secret) return true; // permite probar antes de cargar el secret; en producción sí debe existir.
  if (!signature?.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function processWebhookPayload(payload) {
  cleanupSeen();
  for (const event of extractIncomingMessages(payload)) {
    if (seenMessages.has(event.id)) continue;
    seenMessages.set(event.id, Date.now());
    try {
      await processIncomingMessage(event);
    } catch (err) {
      console.error("Message processing error", event.id, err);
    }
  }
}

function extractIncomingMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      const contacts = new Map((value?.contacts || []).map(c => [c?.wa_id, c?.profile?.name || ""]));
      for (const message of value?.messages || []) {
        const normalized = normalizeMessage(message);
        if (normalized) out.push({ ...normalized, name: contacts.get(message.from) || "" });
      }
    }
  }
  return out;
}

function normalizeMessage(message) {
  if (!message?.id || !message?.from) return null;
  if (message.type === "text") return { id: message.id, from: message.from, type: "text", text: message.text?.body?.trim() || "" };
  if (message.type === "button") return { id: message.id, from: message.from, type: "button", text: message.button?.text?.trim() || "" };
  if (message.type === "interactive") {
    const x = message.interactive || {};
    return { id: message.id, from: message.from, type: "interactive", text: (x.button_reply?.title || x.list_reply?.title || x.list_reply?.description || "").trim() };
  }
  if (message.type === "image" && message.image?.caption) return { id: message.id, from: message.from, type: "image_caption", text: message.image.caption.trim() };
  return { id: message.id, from: message.from, type: message.type || "unknown", text: "" };
}

async function processIncomingMessage(event) {
  const c = getConversation(event.from);
  if (event.name) c.name = event.name;
  addHistory(event.from, "user", event.text || `[${event.type}]`, event.type);
  if (c.paused) return;

  if (!event.text) {
    const fallback = "Recibí tu mensaje. Por ahora puedo ayudarte mejor por texto; si lo prefieres, RH puede continuar la conversación.";
    await sendWhatsAppText(event.from, fallback);
    addHistory(event.from, "assistant", fallback, "auto");
    return;
  }

  const input = c.history.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }));
  const answer = await generateReply(input);
  await sendWhatsAppText(event.from, answer);
  addHistory(event.from, "assistant", answer, "auto");
}

function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { name: "", paused: false, history: [], updatedAt: new Date().toISOString() });
  }
  return conversations.get(phone);
}

function addHistory(phone, role, content, source) {
  const c = getConversation(phone);
  c.history.push({ role, content, source, at: new Date().toISOString() });
  if (c.history.length > 40) c.history.splice(0, c.history.length - 40);
  c.updatedAt = new Date().toISOString();
}

async function generateReply(input) {
  const apiKey = cfg("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const instructions = [
    `Eres ${cfg("BOT_NAME", "un asistente de Recursos Humanos")} de ${cfg("COMPANY_NAME", "la empresa")}.`,
    cfg("BOT_RULES", "Responde de forma breve, clara y veraz."),
    "INFORMACIÓN AUTORIZADA DE LA EMPRESA:",
    cfg("BUSINESS_CONTEXT", "No hay información cargada todavía."),
    "Reglas estrictas:",
    "- Usa solamente la información autorizada anterior para datos concretos de la empresa.",
    "- Si no conoces una respuesta, di que RH la confirmará; no inventes.",
    "- No prometas contratación, aumentos, bonos, horarios o prestaciones que no estén autorizados.",
    "- No pidas contraseñas, NIP, datos bancarios ni documentos sensibles por chat.",
    "- Si el usuario pide hablar con una persona o el caso requiere decisión humana, deriva a RH.",
    "- Mantén las respuestas normalmente en 1 a 4 párrafos cortos."
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg("OPENAI_MODEL", "gpt-6-luna"),
      instructions,
      input,
      store: false,
      max_output_tokens: 300
    })
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("OpenAI error", response.status, body);
    throw new Error(`OpenAI ${response.status}`);
  }
  const data = await response.json();
  const text = extractOpenAIText(data)?.trim();
  return text || "En este momento no pude generar una respuesta. RH continuará la conversación.";
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && part?.text) chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

async function sendWhatsAppText(to, body) {
  const token = cfg("META_ACCESS_TOKEN");
  const phoneId = cfg("META_PHONE_NUMBER_ID");
  if (!token || !phoneId) throw new Error("Meta credentials missing");
  const version = cfg("META_GRAPH_VERSION", "v26.0");
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Meta send error", response.status, data);
    throw new Error(`Meta ${response.status}`);
  }
  return data;
}

function requireAdmin(req, res, next) {
  const expected = cfg("ADMIN_TOKEN");
  const supplied = req.get("x-admin-token") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

function cleanupSeen() {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [id, ts] of seenMessages) if (ts < cutoff) seenMessages.delete(id);
}

function adminHtml() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp RH</title><style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f5f6f7;color:#17212b}.wrap{max-width:900px;margin:auto;padding:24px}.card{background:white;border:1px solid #ddd;border-radius:14px;padding:18px;margin:12px 0}input,textarea,button{font:inherit}input,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bbb;border-radius:8px}button{padding:9px 13px;border:0;border-radius:8px;cursor:pointer}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.msg{padding:8px 10px;border-radius:9px;margin:6px 0;background:#eee}.assistant{background:#dcf8c6}.small{font-size:12px;color:#667}.danger{background:#ffd7d7}</style></head><body><div class="wrap"><h1>WhatsApp RH</h1><p class="small">Panel MVP. El historial y las pausas se reinician si el servicio gratuito de Render se duerme o reinicia.</p><div class="card"><label>ADMIN_TOKEN</label><input id="token" type="password" placeholder="Pega aquí tu token de administrador"><div class="row" style="margin-top:10px"><button onclick="loadConversations()">Cargar conversaciones</button></div></div><div id="list"></div></div><script>
  function H(){return {'x-admin-token':document.getElementById('token').value,'content-type':'application/json'};}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m];});}
  async function loadConversations(){
    var r=await fetch('/api/admin/conversations',{headers:H()}); var d=await r.json(); var el=document.getElementById('list');
    if(!d.ok){el.innerHTML='<div class="card danger">No autorizado</div>';return;}
    if(!d.conversations.length){el.innerHTML='<div class="card">Sin conversaciones todavía.</div>';return;}
    el.innerHTML=d.conversations.map(function(c){
      return '<div class="card"><b>'+esc(c.name||c.phone)+'</b><div class="small">'+esc(c.phone)+' · '+(c.paused?'IA pausada':'IA activa')+'</div><p>'+esc(c.last_message||'')+'</p><div class="row"><button data-action="open" data-phone="'+esc(c.phone)+'">Abrir</button><button data-action="pause" data-phone="'+esc(c.phone)+'" data-paused="'+String(!c.paused)+'">'+(c.paused?'Reactivar IA':'Pausar IA')+'</button></div><div id="chat-'+esc(c.phone)+'"></div></div>';
    }).join('');
    el.querySelectorAll('button[data-action="open"]').forEach(function(b){b.onclick=function(){openChat(b.dataset.phone);};});
    el.querySelectorAll('button[data-action="pause"]').forEach(function(b){b.onclick=function(){pause(b.dataset.phone,b.dataset.paused==='true');};});
  }
  async function openChat(p){
    var r=await fetch('/api/admin/conversations/'+encodeURIComponent(p),{headers:H()}); var d=await r.json(); var el=document.getElementById('chat-'+p); if(!el)return;
    if(!d.conversation){el.innerHTML='';return;}
    var html=(d.conversation.history||[]).map(function(m){return '<div class="msg '+(m.role==='assistant'?'assistant':'')+'"><b>'+(m.role==='assistant'?'RH/IA':'Persona')+':</b> '+esc(m.content)+'</div>';}).join('');
    html+='<textarea id="t-'+esc(p)+'" placeholder="Respuesta manual"></textarea><button id="s-'+esc(p)+'">Enviar</button>';
    el.innerHTML=html; document.getElementById('s-'+p).onclick=function(){sendManual(p);};
  }
  async function pause(p,v){await fetch('/api/admin/conversations/'+encodeURIComponent(p)+'/pause',{method:'POST',headers:H(),body:JSON.stringify({paused:v})});loadConversations();}
  async function sendManual(p){var t=document.getElementById('t-'+p);if(!t||!t.value.trim())return;await fetch('/api/admin/conversations/'+encodeURIComponent(p)+'/send',{method:'POST',headers:H(),body:JSON.stringify({text:t.value})});t.value='';openChat(p);}
</script></body></html>`;
}
