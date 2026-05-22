/*
 * Mi Memoria — núcleo de lógica (framework-agnostic, sin dependencias)
 * Objetiva Brain Construction · objetiva.app
 *
 * Convierte lenguaje natural en español (dictado por voz o texto) en
 * tareas / recordatorios / eventos de agenda, y los exporta a:
 *   - Google Calendar (enlace TEMPLATE, sin API key)
 *   - Cualquier calendario / Recordatorios de Apple / Outlook (archivo .ics)
 *   - WhatsApp (enlace wa.me con el texto del recordatorio)
 * Además: almacenamiento local, notificaciones del navegador y lectura por voz (TTS).
 *
 * Se usa tanto en la página estática (index.html) como en el componente React (MiMemoria.jsx).
 */

export const TIPOS = { TAREA: 'tarea', RECORDATORIO: 'recordatorio', AGENDA: 'agenda' };
const STORE_KEY = 'obc_mi_memoria_v1';

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ---------- utilidades ----------
const sinAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => sinAcentos(String(s || '').toLowerCase()).replace(/\s+/g, ' ').trim();
const dosD = (n) => String(n).padStart(2, '0');

function uid() {
  return 'mm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- parser de lenguaje natural (es) ----------
/**
 * Analiza un texto en español y devuelve los datos de la actividad.
 * @returns {{titulo, tipo, fecha:Date, tieneHora:boolean, duracionMin:number,
 *            recurrencia:object|null, alarmaMin:number, confianza:number, raw:string}}
 */
export function parseSpanish(text, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const defaultHour = opts.defaultHour != null ? opts.defaultHour : 9;
  const raw = String(text || '').trim();
  let n = norm(raw);          // texto normalizado para detección
  let resto = raw;            // texto del que iremos quitando lo reconocido (para el título)
  let confianza = 0.4;

  const quitar = (re) => { resto = resto.replace(re, ' '); };

  // --- tipo ---
  let tipo = TIPOS.TAREA;
  if (/\b(reunion|junta|cita|evento|comida con|cena con|cafe con|llamada con|videollamada|reservar|agendar|agenda)\b/.test(n)) {
    tipo = TIPOS.AGENDA;
  } else if (/\b(recuerda|recuerdame|recordar|recordatorio|no olvides|acuerdate|acordarme|avisame)\b/.test(n)) {
    tipo = TIPOS.RECORDATORIO;
  }

  // --- recurrencia ---
  let recurrencia = null;
  if (/\b(todos los dias|cada dia|a diario|diariamente|diario)\b/.test(n)) {
    recurrencia = { freq: 'DAILY' };
    quitar(/\b(todos los d[ií]as|cada d[ií]a|a diario|diariamente|diario)\b/gi);
  } else {
    const semDia = n.match(/\b(cada|todos los|todas las)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
    if (semDia) {
      const idx = DIAS.indexOf(semDia[2]);
      recurrencia = { freq: 'WEEKLY', byday: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][idx] };
      quitar(/\b(cada|todos los|todas las)\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi);
    } else if (/\b(cada semana|semanal(mente)?)\b/.test(n)) {
      recurrencia = { freq: 'WEEKLY' };
      quitar(/\b(cada semana|semanal(mente)?)\b/gi);
    } else if (/\b(cada mes|mensual(mente)?)\b/.test(n)) {
      recurrencia = { freq: 'MONTHLY' };
      quitar(/\b(cada mes|mensual(mente)?)\b/gi);
    } else if (/\b(cada a[nñ]o|anual(mente)?)\b/.test(n)) {
      recurrencia = { freq: 'YEARLY' };
      quitar(/\b(cada a[nñ]o|anual(mente)?)\b/gi);
    }
  }

  // --- alarma "X minutos antes" ---
  let alarmaMin = 0;
  const mAlarma = n.match(/(\d{1,3})\s*(min(uto)?s?|hora?s?)\s+antes/);
  if (mAlarma) {
    const v = parseInt(mAlarma[1], 10);
    alarmaMin = /hora/.test(mAlarma[2]) ? v * 60 : v;
    quitar(/\d{1,3}\s*(min(uto)?s?|h(ora)?s?)\s+antes/gi);
  }

  // --- fecha base ---
  let fecha = new Date(now);
  let tieneFecha = false;
  let tieneHora = false;

  // hoy / mañana / pasado mañana
  if (/\bpasado ma[nñ]ana\b/.test(n)) {
    fecha.setDate(fecha.getDate() + 2); tieneFecha = true; confianza = 0.8;
    quitar(/\bpasado ma[nñ]ana\b/gi);
  } else if (/\bma[nñ]ana\b/.test(n) && !/\bde la ma[nñ]ana\b/.test(n) && !/\bpor la ma[nñ]ana\b/.test(n)) {
    fecha.setDate(fecha.getDate() + 1); tieneFecha = true; confianza = 0.85;
    quitar(/\bma[nñ]ana\b/gi);
  } else if (/\bhoy\b/.test(n) || /\besta (tarde|noche)\b/.test(n)) {
    tieneFecha = true; confianza = 0.8;
    quitar(/\bhoy\b/gi);
  }

  // día de la semana ("el viernes", "este lunes", "próximo martes")
  if (!tieneFecha) {
    const reDia = /\b(este|el|la|pr[oó]ximo|proximo|proxima|pr[oó]xima|siguiente)?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/;
    const m = n.match(reDia);
    if (m) {
      const target = DIAS.indexOf(sinAcentos(m[2]));
      const dow = fecha.getDay();
      let diff = (target - dow + 7) % 7;
      const esProximo = m[1] && /pr[oó]ximo|proximo|proxima|pr[oó]xima|siguiente/.test(sinAcentos(m[1]));
      if (esProximo && diff < 7) diff += 7;  // "próximo" = la semana siguiente
      fecha.setDate(fecha.getDate() + diff);
      tieneFecha = true; confianza = 0.8;
      quitar(/\b(este|el|la|pr[oó]xim[oa]|proxim[oa]|siguiente)?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi);
    }
  }

  // "en N minutos/horas/días/semanas/meses"
  if (!tieneFecha) {
    const m = n.match(/\ben\s+(\d{1,4})\s*(min(uto)?s?|hora?s?|d[ií]as?|semanas?|mes(es)?)\b/);
    if (m) {
      const v = parseInt(m[1], 10);
      const u = m[2];
      if (/min/.test(u)) { fecha.setMinutes(fecha.getMinutes() + v); tieneHora = true; }
      else if (/hora/.test(u)) { fecha.setHours(fecha.getHours() + v); tieneHora = true; }
      else if (/d[ií]a/.test(u)) fecha.setDate(fecha.getDate() + v);
      else if (/semana/.test(u)) fecha.setDate(fecha.getDate() + v * 7);
      else if (/mes/.test(u)) fecha.setMonth(fecha.getMonth() + v);
      tieneFecha = true; confianza = 0.85;
      quitar(/\ben\s+\d{1,4}\s*(min(uto)?s?|h(ora)?s?|d[ií]as?|semanas?|mes(es)?)\b/gi);
    }
  }

  // fecha explícita "25 de mayo (de 2026)"
  if (!tieneFecha) {
    const m = n.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(\s+(?:de\s+)?(\d{4}))?\b/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mes = MESES.indexOf(m[2]);
      const anio = m[4] ? parseInt(m[4], 10) : fecha.getFullYear();
      fecha = new Date(anio, mes, d, defaultHour, 0, 0, 0);
      if (!m[4] && fecha < now) fecha.setFullYear(anio + 1); // si ya pasó este año → siguiente
      tieneFecha = true; confianza = 0.9;
      quitar(/\b\d{1,2}\s+de\s+\w+(\s+(?:de\s+)?\d{4})?\b/gi);
    }
  }

  // fecha numérica "25/05" "25/05/2026" "25-05"
  if (!tieneFecha) {
    const m = n.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mes = parseInt(m[2], 10) - 1;
      let anio = m[3] ? parseInt(m[3], 10) : fecha.getFullYear();
      if (anio < 100) anio += 2000;
      fecha = new Date(anio, mes, d, defaultHour, 0, 0, 0);
      if (!m[3] && fecha < now) fecha.setFullYear(anio + 1);
      tieneFecha = true; confianza = 0.85;
      quitar(/\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/gi);
    }
  }

  // día del mes "el día 15" / "el 15" (útil con recurrencia mensual)
  if (!tieneFecha) {
    const m = n.match(/\b(?:el\s+)?d[ií]a\s+(\d{1,2})\b/) || n.match(/\bel\s+(\d{1,2})\b/);
    if (m) {
      const d = parseInt(m[1], 10);
      if (d >= 1 && d <= 31) {
        let cand = new Date(fecha.getFullYear(), fecha.getMonth(), d, defaultHour, 0, 0, 0);
        if (cand < now) cand.setMonth(cand.getMonth() + 1);
        fecha = cand; tieneFecha = true; confianza = 0.7;
        if (recurrencia && recurrencia.freq === 'MONTHLY') recurrencia.bymonthday = d;
        quitar(/\b(el\s+)?d[ií]a\s+\d{1,2}\b/gi);
        quitar(/\bel\s+\d{1,2}\b/gi);
      }
    }
  }

  // --- hora ---
  const ampm = (h) => {
    if (/\b(pm|p\.m\.|de la tarde|de la noche|por la tarde|por la noche)\b/.test(n) && h < 12) return h + 12;
    if (/\b(am|a\.m\.|de la ma[nñ]ana|por la ma[nñ]ana|de la madrugada)\b/.test(n)) return h === 12 ? 0 : h;
    // heurística: 1–7 sin indicador → tarde; 8–11 → mañana
    if (h >= 1 && h <= 7) return h + 12;
    return h;
  };

  let hh = null, mm = 0;
  if (/\b(al )?mediod[ií]a\b/.test(n)) { hh = 12; mm = 0; tieneHora = true; quitar(/\b(al )?mediod[ií]a\b/gi); }
  else if (/\b(a (la )?)?medianoche\b/.test(n)) { hh = 0; mm = 0; tieneHora = true; quitar(/\b(a (la )?)?medianoche\b/gi); }
  else {
    const mh = n.match(/\ba\s+la?s?\s+(\d{1,2})(?:[:\.](\d{2}))?\s*(?:hrs?|horas?)?\b/);
    if (mh) {
      hh = parseInt(mh[1], 10);
      mm = mh[2] ? parseInt(mh[2], 10) : 0;
      if (/\by media\b/.test(n)) mm = 30;
      if (/\by cuarto\b/.test(n)) mm = 15;
      if (/\bmenos cuarto\b/.test(n)) { mm = 45; hh = (hh + 23) % 24; }
      if (!mh[2]) hh = ampm(hh);
      tieneHora = true; confianza = Math.max(confianza, 0.85);
      quitar(/\ba\s+la?s?\s+\d{1,2}([:\.]\d{2})?\s*(hrs?|horas?)?(\s+(de la|por la)\s+(ma[nñ]ana|tarde|noche|madrugada))?(\s+(a\.?m\.?|p\.?m\.?))?/gi);
      quitar(/\b(y media|y cuarto|menos cuarto|en punto)\b/gi);
    }
  }

  // limpiar restos de franja horaria del título
  quitar(/\b(de la|por la|en la)\s+(ma[nñ]ana|tarde|noche|madrugada)\b/gi);
  quitar(/\b(a\.?\s?m\.?|p\.?\s?m\.?)\b/gi);

  if (hh != null) { fecha.setHours(hh, mm, 0, 0); }
  else if (!tieneHora) { fecha.setHours(defaultHour, 0, 0, 0); }

  // si no se reconoció fecha y la hora ya pasó hoy → mañana
  if (!tieneFecha && fecha < now) fecha.setDate(fecha.getDate() + 1);

  // --- limpiar título ---
  let titulo = resto
    .replace(/\b(recu[ée]rdame|recuerda|recordar|recordatorio|no olvides|acu[ée]rdate|acordarme|av[ií]same|agenda(r)?|p[oó]n(?:me)?|crea(r)?|a[ñn]ade|anota|apunta|tengo que|debo|necesito|quiero)\b/gi, ' ')
    .replace(/\b(que|de|el|la|los|las|un|una|para|por|a|en|del|al|con|este|esta|mi|mis)\b\s*$/gi, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!titulo) titulo = raw || 'Recordatorio';
  titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);

  const duracionMin = tipo === TIPOS.AGENDA ? 60 : (tieneHora ? 30 : 0);

  return { titulo, tipo, fecha, tieneHora, duracionMin, recurrencia, alarmaMin, confianza, raw };
}

// ---------- modelo / almacenamiento ----------
export function crearItem(parsed) {
  return {
    id: uid(),
    titulo: parsed.titulo,
    tipo: parsed.tipo || TIPOS.RECORDATORIO,
    nota: parsed.raw || '',
    fechaISO: parsed.fecha.toISOString(),
    tieneHora: !!parsed.tieneHora,
    duracionMin: parsed.duracionMin || 0,
    recurrencia: parsed.recurrencia || null,
    alarmaMin: parsed.alarmaMin || 0,
    hecho: false,
    notificado: false,
    creadoISO: new Date().toISOString(),
  };
}

export const store = {
  all() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
    catch { return []; }
  },
  _write(items) { localStorage.setItem(STORE_KEY, JSON.stringify(items)); },
  save(item) {
    const items = this.all();
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item; else items.push(item);
    this._write(items);
    return item;
  },
  update(id, patch) {
    const items = this.all();
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) { items[i] = { ...items[i], ...patch }; this._write(items); return items[i]; }
    return null;
  },
  remove(id) { this._write(this.all().filter((x) => x.id !== id)); },
  clear() { this._write([]); },
};

// ---------- exportación a calendario ----------
function fmtUTC(date) {
  const d = new Date(date);
  return d.getUTCFullYear() + dosD(d.getUTCMonth() + 1) + dosD(d.getUTCDate()) +
    'T' + dosD(d.getUTCHours()) + dosD(d.getUTCMinutes()) + dosD(d.getUTCSeconds()) + 'Z';
}

export function rruleString(rec) {
  if (!rec) return '';
  let r = 'FREQ=' + rec.freq;
  if (rec.byday) r += ';BYDAY=' + rec.byday;
  if (rec.bymonthday) r += ';BYMONTHDAY=' + rec.bymonthday;
  return r;
}
const rrule = rruleString;

export function toICS(item) {
  const start = new Date(item.fechaISO);
  const end = new Date(start.getTime() + (item.duracionMin || 30) * 60000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Objetiva//Mi Memoria//ES',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    'UID:' + item.id + '@objetiva.app',
    'DTSTAMP:' + fmtUTC(new Date()),
    'DTSTART:' + fmtUTC(start),
    'DTEND:' + fmtUTC(end),
    'SUMMARY:' + escICS(item.titulo),
    'DESCRIPTION:' + escICS('[' + item.tipo + '] ' + (item.nota || item.titulo) + ' · Mi Memoria · objetiva.app'),
  ];
  if (item.recurrencia) lines.push('RRULE:' + rrule(item.recurrencia));
  const alarm = item.alarmaMin || (item.tieneHora ? 10 : 0);
  if (alarm > 0) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      'DESCRIPTION:' + escICS(item.titulo),
      'TRIGGER:-PT' + alarm + 'M', 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function escICS(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function descargarICS(item) {
  const blob = new Blob([toICS(item)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (item.titulo.replace(/[^\w\s-]/g, '').trim().slice(0, 40) || 'recordatorio') + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function googleCalendarUrl(item) {
  const start = new Date(item.fechaISO);
  const end = new Date(start.getTime() + (item.duracionMin || 30) * 60000);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: item.titulo,
    dates: fmtUTC(start) + '/' + fmtUTC(end),
    details: '[' + item.tipo + '] ' + (item.nota || '') + '\nCreado con Mi Memoria · objetiva.app',
  });
  if (item.recurrencia) p.append('recur', 'RRULE:' + rrule(item.recurrencia));
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

export function whatsappUrl(item, phone) {
  const txt = '🔔 ' + textoRecordatorio(item);
  const num = (phone || '').replace(/[^\d]/g, '');
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(txt);
}

// ---------- presentación ----------
export function formatFechaHumana(date, tieneHora = true) {
  const d = new Date(date);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const difDias = Math.round((dd - hoy) / 86400000);
  let dia;
  if (difDias === 0) dia = 'Hoy';
  else if (difDias === 1) dia = 'Mañana';
  else if (difDias === -1) dia = 'Ayer';
  else if (difDias > 1 && difDias < 7) dia = new Intl.DateTimeFormat('es-MX', { weekday: 'long' }).format(d);
  else dia = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  dia = dia.charAt(0).toUpperCase() + dia.slice(1);
  if (!tieneHora) return dia;
  const hora = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(d);
  return dia + ' · ' + hora;
}

export function textoRecordatorio(item) {
  return item.titulo + ' — ' + formatFechaHumana(item.fechaISO, item.tieneHora);
}

// ---------- voz (TTS) ----------
export function hablar(texto, lang = 'es-MX') {
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = lang; u.rate = 1; u.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* noop */ }
}

// ---------- notificaciones / programación ----------
export async function pedirPermisoNotificaciones() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

let _timers = [];
const MAX_DELAY = 20 * 24 * 60 * 60 * 1000; // setTimeout práctico ~20 días

/**
 * Programa notificaciones locales para los recordatorios futuros.
 * Vuelve a llamarse al cargar la app y cada vez que cambian los datos.
 */
export function programarNotificaciones(items, opts = {}) {
  const leadMin = opts.leadMin || 0;
  const onFire = opts.onFire || (() => {});
  const lang = opts.lang || 'es-MX';
  _timers.forEach(clearTimeout);
  _timers = [];
  const now = Date.now();
  items.filter((it) => !it.hecho && !it.notificado).forEach((it) => {
    const t = new Date(it.fechaISO).getTime() - (it.alarmaMin || leadMin) * 60000;
    const delay = t - now;
    if (delay > 0 && delay < MAX_DELAY) {
      const id = setTimeout(() => {
        dispararNotificacion(it, lang);
        onFire(it);
      }, delay);
      _timers.push(id);
    }
  });
}

// ---------- sincronización con backend de WhatsApp ----------
/** Envía/actualiza el recordatorio en el backend para que lo mande por WhatsApp a su hora. */
export async function backendSync(baseUrl, apiKey, item, to) {
  if (!baseUrl) return null;
  const r = await fetch(baseUrl.replace(/\/+$/, '') + '/api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey || '' },
    body: JSON.stringify({
      id: item.id, titulo: item.titulo, fechaISO: item.fechaISO,
      alarmaMin: item.alarmaMin || 0, recurrencia: item.recurrencia || null,
      to: (to || '').replace(/[^\d]/g, ''),
    }),
  });
  if (!r.ok) throw new Error('Backend ' + r.status);
  return r.json().catch(() => ({}));
}

export async function backendDelete(baseUrl, apiKey, id) {
  if (!baseUrl) return null;
  return fetch(baseUrl.replace(/\/+$/, '') + '/api/reminders/' + encodeURIComponent(id), {
    method: 'DELETE', headers: { 'X-Api-Key': apiKey || '' },
  });
}

export function dispararNotificacion(item, lang = 'es-MX') {
  const cuerpo = formatFechaHumana(item.fechaISO, item.tieneHora);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('🔔 ' + item.titulo, {
        body: cuerpo, tag: item.id, requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* algunos navegadores requieren SW */ }
  }
  hablar('Recordatorio: ' + item.titulo, lang);
}
