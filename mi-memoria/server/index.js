/*
 * Mi Memoria — Backend de recordatorios por WhatsApp
 * Objetiva Brain Construction · objetiva.app
 *
 * Qué hace: recibe recordatorios desde la app web y los envía por WhatsApp a la
 * hora exacta (un cron revisa cada minuto). Soporta WhatsApp Cloud API (Meta) y Twilio.
 *
 * Cómo correrlo:
 *   1. cp .env.example .env   y rellena tus valores
 *   2. npm install
 *   3. npm start
 * Despliega en Render / Railway / Fly / tu propio servidor (cualquiera con Node 18+).
 * Luego, en la app web → Ajustes → "WhatsApp automático": pega la URL pública y la API Key.
 *
 * IMPORTANTE (Meta): para enviar mensajes programados fuera de la ventana de 24h
 * necesitas una PLANTILLA aprobada (variable WHATSAPP_TEMPLATE). Sin plantilla solo
 * se entregan mensajes dentro de las 24h posteriores a que el usuario te escriba.
 */
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reminders.json');

const {
  PORT = 3000, API_KEY = '', ALLOW_ORIGIN = '*', DEFAULT_TO = '',
  PROVIDER = 'meta',
  WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE = '', WHATSAPP_TEMPLATE_LANG = 'es_MX',
  TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM,
} = process.env;

// ---------- almacenamiento (archivo JSON) ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function save(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

// ---------- envío por WhatsApp ----------
async function sendWhatsApp(to, text) {
  const num = String(to || DEFAULT_TO).replace(/[^\d]/g, '');
  if (!num) throw new Error('Sin número de destino');

  if (PROVIDER === 'twilio') {
    const body = new URLSearchParams({ From: 'whatsapp:+' + String(TWILIO_FROM).replace(/[^\d]/g, ''), To: 'whatsapp:+' + num, Body: text });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!r.ok) throw new Error('Twilio ' + r.status + ' ' + (await r.text()));
    return r.json();
  }

  // Meta WhatsApp Cloud API
  let payload;
  if (WHATSAPP_TEMPLATE) {
    payload = {
      messaging_product: 'whatsapp', to: num, type: 'template',
      template: {
        name: WHATSAPP_TEMPLATE, language: { code: WHATSAPP_TEMPLATE_LANG },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
      },
    };
  } else {
    payload = { messaging_product: 'whatsapp', to: num, type: 'text', text: { body: text } };
  }
  const r = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('Meta ' + r.status + ' ' + (await r.text()));
  return r.json();
}

// ---------- recurrencia: siguiente ocurrencia ----------
function nextOccurrence(iso, rec) {
  const d = new Date(iso);
  switch (rec?.freq) {
    case 'DAILY': d.setDate(d.getDate() + 1); break;
    case 'WEEKLY': d.setDate(d.getDate() + 7); break;
    case 'MONTHLY': d.setMonth(d.getMonth() + 1); break;
    case 'YEARLY': d.setFullYear(d.getFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString();
}

// ---------- cron: revisa cada minuto ----------
const DAY = 24 * 60 * 60 * 1000;
async function checkDue() {
  const items = load();
  let changed = false;
  const now = Date.now();
  for (const it of items) {
    if (it.sent) continue;
    const fireAt = new Date(it.fechaISO).getTime() - (it.alarmaMin || 0) * 60000;
    if (fireAt > now) continue;
    if (now - fireAt > DAY) { it.sent = true; changed = true; continue; } // demasiado viejo, no spamear
    try {
      const cuando = new Date(it.fechaISO).toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'short' });
      await sendWhatsApp(it.to, `🔔 Recordatorio: ${it.titulo}\n🗓️ ${cuando}\n— Mi Memoria · objetiva.app`);
      console.log('[enviado]', it.titulo, '→', it.to || DEFAULT_TO);
      if (it.recurrencia) { it.fechaISO = nextOccurrence(it.fechaISO, it.recurrencia) || it.fechaISO; it.sent = !it.recurrencia ? true : false; }
      else it.sent = true;
      changed = true;
    } catch (e) {
      console.error('[error envío]', it.titulo, e.message);
    }
  }
  if (changed) save(items);
}
cron.schedule('* * * * *', () => { checkDue().catch((e) => console.error(e)); });

// ---------- API ----------
const app = express();
app.use(cors({ origin: ALLOW_ORIGIN === '*' ? true : ALLOW_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json());

function auth(req, res, next) {
  if (!API_KEY) return next();
  if (req.get('X-Api-Key') === API_KEY) return next();
  return res.status(401).json({ error: 'no autorizado' });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, provider: PROVIDER, pendientes: load().filter((x) => !x.sent).length }));

app.post('/api/reminders', auth, (req, res) => {
  const { id, titulo, fechaISO, alarmaMin = 0, recurrencia = null, to = '' } = req.body || {};
  if (!id || !titulo || !fechaISO) return res.status(400).json({ error: 'faltan campos (id, titulo, fechaISO)' });
  const items = load();
  const i = items.findIndex((x) => x.id === id);
  const item = { id, titulo, fechaISO, alarmaMin, recurrencia, to: to || DEFAULT_TO, sent: false };
  if (i >= 0) items[i] = item; else items.push(item);
  save(items);
  res.json({ ok: true, item });
});

app.delete('/api/reminders/:id', auth, (req, res) => {
  save(load().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/reminders', auth, (_req, res) => res.json(load()));

app.post('/api/test', auth, async (req, res) => {
  try {
    await sendWhatsApp(req.body?.to || DEFAULT_TO, '✅ Mi Memoria conectado. Aquí recibirás tus recordatorios.');
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Permite que un cron externo (p.ej. cron-job.org) dispare el envío cada minuto.
// Útil en hosting gratuito que "duerme" el servicio: cada ping lo despierta y revisa.
// Autoriza por header X-Api-Key o por ?key=...
app.all('/api/cron', async (req, res) => {
  if (API_KEY && req.get('X-Api-Key') !== API_KEY && req.query.key !== API_KEY) {
    return res.status(401).json({ error: 'no autorizado' });
  }
  await checkDue().catch((e) => console.error(e));
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`Mi Memoria · WhatsApp backend en :${PORT} (proveedor: ${PROVIDER})`));
