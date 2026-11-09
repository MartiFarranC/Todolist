// Edge Function "todo-push": envia els avisos als dispositius subscrits.
//
// - App d'Android: endpoint "fcm:<token>" → Firebase Cloud Messaging (API v1). Cal el secret
//   FCM_SERVICE_ACCOUNT (el JSON del compte de servei de Firebase, sencer). Missatges només de dades:
//   l'app construeix l'avís (canal, so, botons Fet / Més tard).
// - Navegadors (Web Push, la PWA antiga): es mantenen per compatibilitat.
//
// - GET  → torna la clau pública VAPID (la crea el primer cop i la desa a todo_private.config).
// - GET ?widget=<widget_key> → la tasca d'ara, per al widget de la pantalla d'inici.
// - POST → {secret, title, body, level, tag, task_id, url}. La crida la base de dades (pg_net)
//          amb push_secret. Xifra el missatge per a cada dispositiu (RFC 8291) i l'envia.
//          Els dispositius que ja no existeixen (404/410) s'esborren.
//
// Sense dependències: només Web Crypto. Desplegar amb verify_jwt desactivat (vegeu README).

const enc = new TextEncoder();

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function generateVapid(): Promise<{ publicKey: string; privateJwk: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(raw), privateJwk: JSON.stringify(jwk) };
}

// JWT de VAPID (RFC 8292), signat amb ES256
export async function vapidHeader(endpoint: string, publicKey: string, privateJwk: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// Xifratge aes128gcm (RFC 8188 + RFC 8291)
export async function encrypt(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

type Sub = { endpoint: string; p256dh: string; auth: string };
type State = { secret: string; vapid_public: string | null; vapid_private: string | null; subject: string; subscriptions: Sub[] };

export async function sendOne(sub: Sub, payload: object, vapid: { publicKey: string; privateJwk: string; subject: string },
                              urgency = 'normal', ttl = 12 * 3600): Promise<number> {
  const body = await encrypt(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateJwk, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}

// ---------- Firebase Cloud Messaging (app d'Android) ----------
type ServiceAccount = { project_id: string; client_email: string; private_key: string };
let fcmToken: { value: string; exp: number } | null = null;

function pemToPkcs8(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Testimoni OAuth2 a partir del compte de servei (JWT RS256), guardat ~50 min.
async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.exp > now + 60) return fcmToken.value;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64u(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64u(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`oauth ${res.status} ${await res.text()}`);
  const { access_token, expires_in } = await res.json();
  fcmToken = { value: access_token, exp: now + Math.min(Number(expires_in) || 3600, 3000) };
  return access_token;
}

// Torna l'estat HTTP; 404 vol dir que el testimoni ja no és vàlid (app desinstal·lada).
export async function sendFcm(token: string, payload: Record<string, unknown>, sa: ServiceAccount): Promise<number> {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) if (v != null) data[k] = String(v);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fcmAccessToken(sa)}`, 'Content-Type': 'application/json' },
    // Prioritat alta perquè arribi a l'hora encara que el mòbil estigui en repòs (sempre es mostra un avís).
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '43200s' } } }),
  });
  const text = await res.text();
  if (res.status === 400 && /UNREGISTERED|registration token is not a valid/i.test(text)) return 404;
  if (!res.ok) console.error('fcm', res.status, text);
  return res.status;
}

function serviceAccount(): ServiceAccount | null {
  const raw = globalThis.Deno?.env.get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { console.error('FCM_SERVICE_ACCOUNT no és JSON'); return null; }
}

// ---------- Servidor ----------
const SUPABASE_URL = globalThis.Deno?.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = globalThis.Deno?.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const getState = (): Promise<State> => rest('rpc/todo_push_state', { method: 'POST', body: '{}' });

async function ensureVapid(state: State) {
  if (!state.vapid_public || !state.vapid_private) {
    const v = await generateVapid();
    await rest('rpc/todo_push_set_vapid', { method: 'POST', body: JSON.stringify({ pub: v.publicKey, priv: v.privateJwk }) });
    return getState(); // per si una altra crida les ha creat alhora
  }
  return state;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    if (req.method === 'GET') {
      // Widget de la pantalla d'inici (KWGT no pot enviar capçaleres): ?widget=<widget_key>
      const widgetKey = new URL(req.url).searchParams.get('widget');
      if (widgetKey) {
        const now = await rest('rpc/todo_widget_now', { method: 'POST', body: JSON.stringify({ key: widgetKey }) })
          .catch(() => null);
        return now ? json(now) : json({ error: 'clau' }, 401);
      }
      const state = await ensureVapid(await getState());
      return json({ publicKey: state.vapid_public });
    }
    if (req.method !== 'POST') return json({ error: 'method' }, 405);

    const msg = await req.json();
    let state = await getState();
    if (!msg.secret || msg.secret !== state.secret) return json({ error: 'secret' }, 401);
    const webSubs = state.subscriptions.filter(s => !s.endpoint.startsWith('fcm:'));
    if (webSubs.length) state = await ensureVapid(state);
    const sa = serviceAccount();

    const level = ['normal', 'important', 'urgent', 'digest'].includes(msg.level) ? msg.level : 'normal';
    const payload = {
      title: String(msg.title ?? 'Ara').slice(0, 120),
      body: String(msg.body ?? '').slice(0, 400),
      level, tag: msg.tag ?? null, task_id: msg.task_id ?? null, url: msg.url ?? null,
    };
    const urgency = level === 'urgent' ? 'high' : level === 'important' ? 'high' : 'normal';
    const vapid = { publicKey: state.vapid_public!, privateJwk: state.vapid_private!, subject: state.subject };

    const results = await Promise.all(state.subscriptions.map(async sub => {
      try {
        let status: number;
        if (sub.endpoint.startsWith('fcm:')) {
          if (!sa) { console.error('falta el secret FCM_SERVICE_ACCOUNT'); return 0; }
          status = await sendFcm(sub.endpoint.slice(4), payload, sa);
        } else {
          status = await sendOne(sub, payload, vapid, urgency);
        }
        const enc = encodeURIComponent(sub.endpoint);
        if (status === 404 || status === 410) {
          await rest(`todo_push_subscriptions?endpoint=eq.${enc}`, { method: 'DELETE' });
        } else if (status < 300) {
          await rest(`todo_push_subscriptions?endpoint=eq.${enc}`, {
            method: 'PATCH', body: JSON.stringify({ last_ok_at: new Date().toISOString() }),
          });
        }
        return status;
      } catch (e) {
        console.error('push', e);
        return 0;
      }
    }));
    return json({ sent: results.filter(s => s >= 200 && s < 300).length, results });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
}

if (globalThis.Deno?.serve) Deno.serve(handle);
