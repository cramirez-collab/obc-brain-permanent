'use client';
/*
 * Mi Memoria — componente React para integrar dentro de objetiva.app (Next.js + Tailwind)
 * Reusa toda la lógica de ./memoria-core.js (parser de voz, ICS, Google Calendar, WhatsApp, notificaciones).
 *
 * Integración (App Router):
 *   1. Copia memoria-core.js y MiMemoria.jsx a, p.ej., src/app/mi-memoria/
 *   2. Crea src/app/mi-memoria/page.jsx  ->  export { default } from './MiMemoria';
 *   3. Agrega el enlace en el Sidebar (sección "Personal"):  { href:'/mi-memoria', label:'Mi Memoria' }
 *   El layout/sidebar existente envuelve la página automáticamente.
 *
 * Las clases Tailwind y los tokens --color-primary / --color-accent ya existen en la app.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  TIPOS, parseSpanish, crearItem, store, descargarICS, googleCalendarUrl,
  whatsappUrl, formatFechaHumana, hablar, pedirPermisoNotificaciones,
  programarNotificaciones, backendSync, backendDelete,
} from './memoria-core.js';
import { initGoogle, googleConectado, conectarGoogle, desconectarGoogle, crearEventoGoogle } from './google-calendar.js';

const SET_KEY = 'obc_mi_memoria_set_v1';
const loadSettings = () => Object.assign(
  { lang: 'es-MX', defaultHour: 9, leadMin: 10, whatsapp: '', googleClientId: '', backendUrl: '', backendKey: '' },
  (typeof localStorage !== 'undefined' && JSON.parse(localStorage.getItem(SET_KEY) || '{}')) || {}
);
const toLocalInput = (d) => {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
};

export default function MiMemoria() {
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(loadSettings);
  const [parsed, setParsed] = useState(null);   // preview editable
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [manual, setManual] = useState('');
  const [gconn, setGconn] = useState(false);
  const recogRef = useRef(null);

  // Carga Google Identity Services una sola vez
  useEffect(() => {
    if (document.getElementById('gis-script')) return;
    const s = document.createElement('script');
    s.id = 'gis-script'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    document.head.appendChild(s);
  }, []);
  useEffect(() => { initGoogle(settings.googleClientId); }, [settings.googleClientId]);

  const refresh = useCallback(() => {
    const all = store.all().sort((a, b) => new Date(a.fechaISO) - new Date(b.fechaISO));
    setItems(all);
    programarNotificaciones(all, {
      leadMin: settings.leadMin, lang: settings.lang,
      onFire: (it) => { store.update(it.id, { notificado: true }); refresh(); },
    });
  }, [settings.leadMin, settings.lang]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { localStorage.setItem(SET_KEY, JSON.stringify(settings)); }, [settings]);

  // ---- voz ----
  useEffect(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return;
    const r = new SR();
    r.lang = settings.lang; r.interimResults = true; r.continuous = false;
    r.onstart = () => { setListening(true); setTranscript(''); };
    r.onend = () => setListening(false);
    r.onresult = (e) => {
      let fin = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t; else interim += t;
      }
      setTranscript(fin + interim);
      if (fin) setParsed(parseSpanish(fin, { defaultHour: settings.defaultHour }));
    };
    recogRef.current = r;
  }, [settings.lang, settings.defaultHour]);

  const toggleMic = () => {
    const r = recogRef.current;
    if (!r) { alert('Tu navegador no soporta dictado. Usa el campo de texto.'); return; }
    if (listening) r.stop(); else { r.lang = settings.lang; try { r.start(); } catch {} }
  };
  const procesar = (txt) => { if (txt && txt.trim()) setParsed(parseSpanish(txt, { defaultHour: settings.defaultHour })); };

  const guardar = () => {
    const fecha = new Date(parsed._fecha || parsed.fecha);
    if (isNaN(fecha)) return;
    const item = crearItem({
      titulo: parsed.titulo?.trim() || 'Recordatorio',
      tipo: parsed.tipo, fecha, tieneHora: true,
      duracionMin: parsed.tipo === TIPOS.AGENDA ? 60 : 30,
      recurrencia: parsed.recurrencia, alarmaMin: settings.leadMin, raw: parsed.raw || '',
    });
    store.save(item); setParsed(null); setTranscript(''); refresh();
    hablar('Listo. Te recordaré ' + item.titulo, settings.lang);
    sincronizar(item);
  };

  // Empuja a Google Calendar y/o backend de WhatsApp si están configurados
  const sincronizar = async (item) => {
    if (settings.googleClientId && googleConectado()) {
      try { await crearEventoGoogle(item); } catch (e) { alert('Google: ' + (e.message || 'error')); }
    }
    if (settings.backendUrl) {
      try { await backendSync(settings.backendUrl, settings.backendKey, item, settings.whatsapp); }
      catch (e) { alert('WhatsApp backend: ' + (e.message || 'error')); }
    }
  };

  const onAct = (it, act) => {
    if (act === 'done') { store.update(it.id, { hecho: !it.hecho }); refresh(); }
    else if (act === 'gcal') window.open(googleCalendarUrl(it), '_blank');
    else if (act === 'ics') descargarICS(it);
    else if (act === 'wa') { if (!settings.whatsapp) return alert('Agrega tu WhatsApp en Ajustes'); window.open(whatsappUrl(it, settings.whatsapp), '_blank'); }
    else if (act === 'speak') hablar(it.titulo + '. ' + formatFechaHumana(it.fechaISO, it.tieneHora), settings.lang);
    else if (act === 'edit') { setParsed({ ...it, _fecha: it.fechaISO, fecha: new Date(it.fechaISO) }); store.remove(it.id); refresh(); if (settings.backendUrl) backendDelete(settings.backendUrl, settings.backendKey, it.id).catch(() => {}); }
    else if (act === 'del') { store.remove(it.id); refresh(); if (settings.backendUrl) backendDelete(settings.backendUrl, settings.backendKey, it.id).catch(() => {}); }
  };

  const activos = items.filter((i) => !i.hecho);
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <div className="p-8 max-w-[60rem] mx-auto">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-widest text-[var(--color-accent)] font-semibold mb-1">Neurona · Personal</p>
        <h1 className="text-3xl font-semibold text-slate-900">Mi Memoria</h1>
        <p className="text-sm text-slate-500 mt-1">Dicta por voz lo que quieres recordar. Lo agendo, te aviso y lo envío a tu calendario o WhatsApp.</p>
      </header>

      {/* Captura */}
      <section className="bg-white border border-slate-200 rounded-xl p-8 text-center">
        <button onClick={toggleMic}
          className={`w-22 h-22 mx-auto flex items-center justify-center rounded-full text-white transition shadow-lg ${listening ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-primary)]'}`}
          style={{ width: 88, height: 88 }} aria-label="Hablar">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
        </button>
        <p className="mt-4 text-sm text-slate-500 min-h-[1.25rem]">{listening ? 'Escuchando…' : 'Toca el micrófono y dicta tu recordatorio'}</p>
        {transcript && <p className="mt-2 text-lg font-medium text-slate-900">{transcript}</p>}
        <p className="mt-3 text-xs text-slate-400">Ej.: «junta de obra el viernes a las 9», «pagar nómina cada mes», «comprar material en 2 horas»</p>
        <div className="mt-4 flex gap-2 max-w-md mx-auto">
          <input value={manual} onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { procesar(manual); setManual(''); } }}
            placeholder="…o escríbelo aquí" className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm" />
          <button onClick={() => { procesar(manual); setManual(''); }} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium">Agregar</button>
        </div>
      </section>

      {/* Preview editable */}
      {parsed && (
        <section className="mt-5 border border-[var(--color-accent)] bg-emerald-50/40 rounded-xl p-5">
          <div className="grid sm:grid-cols-3 gap-3 mb-3">
            <label className="sm:col-span-2 flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Qué recordar</span>
              <input value={parsed.titulo} onChange={(e) => setParsed({ ...parsed, titulo: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Tipo</span>
              <select value={parsed.tipo} onChange={(e) => setParsed({ ...parsed, tipo: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                <option value="recordatorio">Recordatorio</option><option value="tarea">Tarea</option><option value="agenda">Agenda / Evento</option>
              </select>
            </label>
          </div>
          <div className="grid sm:grid-cols-3 gap-3 mb-3">
            <label className="sm:col-span-2 flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Fecha y hora</span>
              <input type="datetime-local" value={toLocalInput(parsed._fecha || parsed.fecha)}
                onChange={(e) => setParsed({ ...parsed, _fecha: e.target.value })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Repetir</span>
              <select value={parsed.recurrencia?.freq || ''} onChange={(e) => setParsed({ ...parsed, recurrencia: e.target.value ? { freq: e.target.value } : null })} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                <option value="">No repetir</option><option value="DAILY">Cada día</option><option value="WEEKLY">Cada semana</option><option value="MONTHLY">Cada mes</option><option value="YEARLY">Cada año</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button onClick={guardar} className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium">Guardar recordatorio</button>
            <button onClick={() => { setParsed(null); setTranscript(''); }} className="px-4 py-2 rounded-lg text-sm text-slate-600">Descartar</button>
          </div>
        </section>
      )}

      {/* Stats */}
      <section className="grid grid-cols-3 gap-3 mt-6">
        {[['Hoy', items.filter((i) => !i.hecho && esHoy(i)).length],
          ['Próximos', items.filter((i) => !i.hecho && !esHoy(i) && new Date(i.fechaISO) >= new Date()).length],
          ['Total activos', activos.length]].map(([l, n]) => (
          <div key={l} className="bg-white border border-slate-200 rounded-lg px-4 py-3">
            <div className="text-2xl font-semibold text-slate-900">{n}</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold mt-0.5">{l}</div>
          </div>
        ))}
      </section>

      {/* Lista */}
      <div className="mt-6 space-y-2">
        {items.length === 0 && <div className="text-center text-slate-400 text-sm py-10">Aún no tienes recordatorios. Toca el micrófono y dime qué recordar 🎙️</div>}
        {items.map((it) => {
          const venc = !it.recurrencia && new Date(it.fechaISO) < new Date() && !it.hecho;
          return (
            <div key={it.id} className={`flex items-start gap-3 p-4 border border-slate-200 rounded-lg bg-white ${it.hecho ? 'opacity-50' : ''}`}>
              <button onClick={() => onAct(it, 'done')} className={`w-5 h-5 mt-0.5 shrink-0 rounded border-2 flex items-center justify-center ${it.hecho ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-white' : 'border-slate-300'}`}>
                {it.hecho && <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${it.hecho ? 'line-through' : ''}`}>{it.titulo}</div>
                <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-2">
                  <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${badge(it.tipo)}`}>{it.tipo}</span>
                  <span>{formatFechaHumana(it.fechaISO, it.tieneHora)}</span>
                  {venc && <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-600">vencido</span>}
                </div>
              </div>
              <div className="flex gap-0.5 shrink-0">
                {[['gcal', 'Google Calendar'], ['ics', 'Descargar .ics'], ['wa', 'WhatsApp'], ['speak', 'Leer'], ['edit', 'Editar'], ['del', 'Borrar']].map(([a, t]) => (
                  <button key={a} title={t} onClick={() => onAct(it, a)} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-[var(--color-primary)] text-xs">{ICON_TXT[a]}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Ajustes */}
      <details className="mt-6">
        <summary className="cursor-pointer text-sm font-semibold text-slate-600 py-2">Ajustes</summary>
        <div className="bg-white border border-slate-200 rounded-lg p-5 mt-2">
          <div className="flex items-center justify-between py-2">
            <div><strong className="text-sm">Notificaciones</strong><p className="text-xs text-slate-400">Avísame en este dispositivo cuando llegue la hora</p></div>
            <button onClick={async () => { await pedirPermisoNotificaciones(); refresh(); }} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm">Activar</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 mt-2">
            <Field label="Idioma de voz">
              <select value={settings.lang} onChange={(e) => set('lang', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white w-full">
                <option value="es-MX">Español (México)</option><option value="es-ES">Español (España)</option><option value="es-AR">Español (Argentina)</option><option value="es-CO">Español (Colombia)</option>
              </select>
            </Field>
            <Field label="Hora por defecto"><input type="number" min="0" max="23" value={settings.defaultHour} onChange={(e) => set('defaultHour', +e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
            <Field label="Avisarme antes (min)"><input type="number" min="0" max="1440" value={settings.leadMin} onChange={(e) => set('leadMin', +e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
            <Field label="WhatsApp (código país)"><input type="tel" placeholder="521…" value={settings.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
          </div>

          {/* Google Calendar */}
          <div className="border-t border-slate-200 mt-4 pt-4">
            <div className="flex items-center justify-between mb-2">
              <div><strong className="text-sm">Google Calendar</strong><p className="text-xs text-slate-400">Crea el evento directo en tu Google al guardar</p></div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${gconn ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{gconn ? 'Conectado' : 'Sin conectar'}</span>
            </div>
            <Field label="Client ID de Google (OAuth)"><input type="text" placeholder="xxxx.apps.googleusercontent.com" value={settings.googleClientId} onChange={(e) => set('googleClientId', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
            <div className="flex gap-2 mt-2">
              <button onClick={async () => { if (!settings.googleClientId) return alert('Pega tu Client ID'); try { await conectarGoogle(); setGconn(true); } catch (e) { alert('Google: ' + (e.message || 'error')); } }} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm">Conectar Google</button>
              <button onClick={() => { desconectarGoogle(); setGconn(false); }} className="px-3 py-1.5 rounded-lg text-sm text-slate-600">Desconectar</button>
            </div>
          </div>

          {/* WhatsApp automático */}
          <div className="border-t border-slate-200 mt-4 pt-4">
            <div className="flex items-center justify-between mb-2">
              <div><strong className="text-sm">WhatsApp automático</strong><p className="text-xs text-slate-400">Envía el recordatorio a tu WhatsApp a la hora exacta (requiere backend)</p></div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${settings.backendUrl ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{settings.backendUrl ? 'Activo' : 'Apagado'}</span>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="URL del backend"><input type="url" placeholder="https://tu-backend.onrender.com" value={settings.backendUrl} onChange={(e) => set('backendUrl', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
              <Field label="API Key del backend"><input type="password" placeholder="clave secreta" value={settings.backendKey} onChange={(e) => set('backendKey', e.target.value)} className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-full" /></Field>
            </div>
            <button onClick={async () => {
              if (!settings.backendUrl || !settings.whatsapp) return alert('Configura URL del backend y tu WhatsApp');
              try {
                const r = await fetch(settings.backendUrl.replace(/\/+$/, '') + '/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': settings.backendKey || '' }, body: JSON.stringify({ to: settings.whatsapp.replace(/[^\d]/g, '') }) });
                alert(r.ok ? 'Mensaje de prueba enviado ✓' : 'Error backend ' + r.status);
              } catch { alert('No se pudo contactar el backend'); }
            }} className="mt-2 px-3 py-1.5 border border-slate-200 rounded-lg text-sm">Enviar WhatsApp de prueba</button>
          </div>
        </div>
      </details>
    </div>
  );
}

function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{label}</span>{children}</label>;
}
const esHoy = (i) => { const d = new Date(i.fechaISO), n = new Date(); return d.toDateString() === n.toDateString(); };
const badge = (t) => t === 'tarea' ? 'bg-indigo-50 text-indigo-600' : t === 'agenda' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-100 text-amber-700';
const ICON_TXT = { gcal: '📅', ics: '⬇️', wa: '🟢', speak: '🔊', edit: '✏️', del: '🗑️' };
