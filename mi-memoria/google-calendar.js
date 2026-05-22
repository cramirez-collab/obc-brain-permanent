/*
 * Mi Memoria — integración real con Google Calendar (lado navegador, sin backend)
 * Usa Google Identity Services (GIS) para obtener un token OAuth y crea el evento
 * directamente en el calendario del usuario vía Google Calendar REST API.
 *
 * Requisitos (una sola vez, en https://console.cloud.google.com):
 *   1. Crea un proyecto y habilita "Google Calendar API".
 *   2. Pantalla de consentimiento OAuth → tipo "Externo" → agrega tu correo como tester.
 *   3. Credenciales → "ID de cliente de OAuth" → tipo "Aplicación web".
 *      - Orígenes autorizados de JavaScript: tu dominio, p.ej.
 *        https://cramirez-collab.github.io   y   https://objetiva.app
 *   4. Copia el "Client ID" y pégalo en Ajustes → "Client ID de Google".
 *
 * Carga previa en el HTML:  <script src="https://accounts.google.com/gsi/client" async defer></script>
 */
import { rruleString } from './memoria-core.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let _clientId = '';
let _tokenClient = null;
let _accessToken = '';
let _expiry = 0;

export function initGoogle(clientId) { _clientId = (clientId || '').trim(); }
export function googleListo() { return typeof window !== 'undefined' && !!window.google?.accounts?.oauth2; }
export function googleConectado() { return !!_accessToken && Date.now() < _expiry; }

/** Lanza el popup de consentimiento y guarda el token de acceso. */
export function conectarGoogle({ silencioso = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!_clientId) return reject(new Error('Falta el Client ID de Google'));
    if (!googleListo()) return reject(new Error('Google Identity Services no cargó (revisa tu conexión)'));
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: _clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(resp);
        _accessToken = resp.access_token;
        _expiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        resolve(resp);
      },
    });
    _tokenClient.requestAccessToken({ prompt: silencioso ? '' : (_accessToken ? '' : 'consent') });
  });
}

export function desconectarGoogle() {
  if (_accessToken && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(_accessToken, () => {}); } catch {}
  }
  _accessToken = ''; _expiry = 0;
}

/** Crea el evento en Google Calendar. Devuelve el evento (con htmlLink). */
export async function crearEventoGoogle(item) {
  if (!googleConectado()) await conectarGoogle({ silencioso: true }).catch(() => conectarGoogle());
  const start = new Date(item.fechaISO);
  const end = new Date(start.getTime() + (item.duracionMin || 30) * 60000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City';
  const body = {
    summary: item.titulo,
    description: '[' + item.tipo + '] ' + (item.nota || '') + '\nCreado con Mi Memoria · objetiva.app',
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
  };
  if (item.recurrencia) body.recurrence = ['RRULE:' + rruleString(item.recurrencia)];
  const alarm = item.alarmaMin || (item.tieneHora ? 10 : 0);
  if (alarm > 0) body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: alarm }] };

  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + _accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { _accessToken = ''; throw new Error('Sesión de Google expirada, vuelve a conectar'); }
  if (!r.ok) throw new Error('Google Calendar API ' + r.status);
  return r.json();
}
