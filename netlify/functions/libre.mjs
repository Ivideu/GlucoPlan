// GET /api/libre?days=7  -> { configured, points: [[ts, mgdl], ...], trend, lastTs, aviso }
// Lee la glucosa del sensor Libre a través de LibreLinkUp (API no oficial de Abbott).
// Variables de entorno: LIBRE_EMAIL, LIBRE_PASSWORD (cuenta de LibreLinkUp), APP_PASSWORD.
// Opcionales: LIBRE_REGION (por ejemplo "eu"), LIBRE_VERSION (por defecto 4.16.0).
import { createHash } from "node:crypto";
import { checkAuth, monthKey, preflight, reply, store } from "../lib/shared.mjs";

const EMAIL = (process.env.LIBRE_EMAIL || "").trim();
const PASSWORD = process.env.LIBRE_PASSWORD || "";
const START_VERSION = (process.env.LIBRE_VERSION || "4.16.0").trim();
const START_REGION = (process.env.LIBRE_REGION || "").trim();

const MIN = 6e4;
const SYNC_EVERY = 45e3; // no llamar a Abbott más de una vez cada 45 s
const RETRY_AFTER_ERROR = 3 * MIN; // tras un fallo, esperar antes de reintentar

const sha = (s) => createHash("sha256").update(s).digest("hex");
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const host = (region) => (region ? `https://api-${region}.libreview.io` : "https://api.libreview.io");

const baseHeaders = (version) => ({
  "content-type": "application/json",
  "cache-control": "no-cache",
  product: "llu.android",
  version,
});

async function call(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(3500) });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

// "10/13/2026 7:05:22 PM" (hora UTC) -> milisegundos
function parseTs(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)?$/i.exec(String(s || "").trim());
  if (!m) return null;
  let h = Number(m[4]);
  const ap = (m[7] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6]));
}

const toPoint = (g) => {
  const ts = parseTs(g?.FactoryTimestamp);
  const mg = Math.round(Number(g?.ValueInMgPerDl));
  if (!ts || !Number.isFinite(mg) || mg < 20 || mg > 600) return null;
  if (ts > Date.now() + 15 * MIN) return null; // reloj incorrecto
  return [ts, mg];
};

async function login() {
  let region = START_REGION, version = START_VERSION;
  for (let i = 0; i < 4; i++) {
    const { json } = await call(`${host(region)}/llu/auth/login`, {
      method: "POST",
      headers: baseHeaders(version),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const d = json.data || {};
    if (d.redirect && d.region) { region = d.region; continue; } // otra región del servidor
    if (d.minimumVersion && !d.authTicket) { version = d.minimumVersion; continue; } // versión mínima exigida
    if (json.status === 2) throw fail("Email o contraseña de LibreLinkUp incorrectos", 401);
    if (json.status === 4 || d.step) throw fail("LibreLinkUp pide aceptar sus condiciones: abre la app LibreLinkUp y acéptalas", 409);
    if (!d.authTicket?.token || !d.user?.id) throw fail(`Respuesta inesperada de LibreLinkUp (estado ${json.status ?? "?"})`);
    return { token: d.authTicket.token, expires: Number(d.authTicket.expires) || 0, accountId: sha(d.user.id), region, version };
  }
  throw fail("No se pudo iniciar sesión en LibreLinkUp");
}

const authHeaders = (s) => ({ ...baseHeaders(s.version), authorization: `Bearer ${s.token}`, "account-id": s.accountId });

async function findPatient(sess) {
  const { res, json } = await call(`${host(sess.region)}/llu/connections`, { headers: authHeaders(sess) });
  if (res.status === 401 || res.status === 403) throw fail("Sesión caducada", 401);
  const first = (json.data || [])[0];
  if (!first?.patientId) throw fail("LibreLinkUp no tiene ninguna conexión: invita a este email desde LibreLink (menú Compartir) y acepta la invitación");
  return first.patientId;
}

async function getGraph(sess) {
  const { res, json } = await call(`${host(sess.region)}/llu/connections/${sess.patientId}/graph`, { headers: authHeaders(sess) });
  if (res.status === 401 || res.status === 403) throw fail("Sesión caducada", 401);
  if (!res.ok || !json.data) throw fail(`LibreLinkUp no devolvió datos (${res.status})`);
  return json.data;
}

async function fetchUpstream(s) {
  let sess = await s.get("libre/session", { type: "json" }).catch(() => null);
  let data = null;
  if (sess?.token && sess.patientId && sess.expires > Date.now() / 1000 + 600) {
    try { data = await getGraph(sess); } catch (e) { if (e.status !== 401) throw e; sess = null; }
  } else sess = null;

  if (!data) {
    sess = await login();
    sess.patientId = await findPatient(sess);
    await s.setJSON("libre/session", sess);
    data = await getGraph(sess);
  }

  const points = (data.graphData || []).map(toPoint).filter(Boolean);
  const cur = data.connection?.glucoseMeasurement;
  const p = toPoint(cur);
  const current = p ? { ts: p[0], mg: p[1], trend: Number(cur.TrendArrow) || null } : null;
  return { points, current };
}

// Guarda solo los puntos de 15 min del gráfico (sin duplicar)
async function savePoints(s, points) {
  const byMonth = {};
  points.forEach((p) => { (byMonth[monthKey(p[0])] ||= []).push(p); });
  for (const [mk, add] of Object.entries(byMonth)) {
    const key = `sensor/${mk}`;
    const cur = (await s.get(key, { type: "json" }).catch(() => null)) || [];
    const map = new Map(cur.map((p) => [Math.round(p[0] / MIN), p]));
    add.forEach((p) => map.set(Math.round(p[0] / MIN), p));
    await s.setJSON(key, [...map.values()].sort((a, b) => a[0] - b[0]));
  }
}

async function loadPoints(s, days) {
  const now = new Date();
  const keys = [];
  for (let i = 0; i <= Math.ceil(days / 28); i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`sensor/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const lists = await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)));
  const from = Date.now() - days * 864e5;
  return lists.flatMap((l) => (Array.isArray(l) ? l : [])).filter((p) => p[0] >= from).sort((a, b) => a[0] - b[0]);
}

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const bad = checkAuth(req);
  if (bad) return bad;
  if (req.method !== "GET") return reply(405, { error: "Método no permitido" });
  if (!EMAIL || !PASSWORD) return reply(200, { configured: false });

  const days = Math.min(28, Math.max(1, parseInt(new URL(req.url).searchParams.get("days") || "7", 10) || 7));
  const s = store();
  const meta = (await s.get("libre/meta", { type: "json" }).catch(() => null)) || {};
  const now = Date.now();
  let aviso = "";

  const recentError = meta.errorAt && now - meta.errorAt < RETRY_AFTER_ERROR;
  const fresh = meta.lastSync && now - meta.lastSync < SYNC_EVERY;

  if (recentError) aviso = meta.error || "Error al leer LibreLinkUp";
  else if (!fresh) {
    try {
      const r = await fetchUpstream(s);
      await savePoints(s, r.points);
      if (r.current) meta.current = r.current;
      meta.lastSync = now;
      meta.errorAt = 0; meta.error = "";
      await s.setJSON("libre/meta", meta);
    } catch (e) {
      console.error("LibreLinkUp", e.message);
      meta.errorAt = now; meta.error = e.message;
      aviso = e.message;
      await s.setJSON("libre/meta", meta).catch(() => {});
    }
  }

  const points = await loadPoints(s, days);
  const c = meta.current;
  if (c && (!points.length || c.ts > points[points.length - 1][0])) points.push([c.ts, c.mg]);
  return reply(200, { configured: true, points, trend: c?.trend ?? null, lastTs: c?.ts ?? null, aviso });
};

export const config = { path: "/api/libre" };