// POST /api/coach  { settings: { icr, isf, target } }  -> estadísticas + análisis de los últimos 28 días
// Las estadísticas se calculan aquí con tus datos (no las inventa la IA); Gemini solo redacta patrones y preguntas.
import { askGemini, checkAuth, loadEntries, preflight, reply } from "../lib/shared.mjs";

const DAY = 864e5;
const TZ = "Europe/Madrid";

const SYSTEM = `Eres un asistente de análisis de datos para una persona adulta con diabetes tipo 1 (Fiasp y Toujeo, con gimnasio).
Recibes estadísticas ya calculadas y una lista de eventos recientes. Tu trabajo es describir patrones y preparar preguntas para su endocrino.
Reglas:
- Devuelve SOLO un objeto JSON con este formato:
  {"resumen":"","patrones":[{"titulo":"","detalle":""}],"sugerencias":[{"texto":"","prioridad":"alta|media|baja","requiere_endocrino":true}],"preguntas_endocrino":[""]}
- Escribe en español, claro y breve. "resumen": 2 o 3 frases. Máximo 4 patrones, 4 sugerencias y 5 preguntas.
- NUNCA indiques una dosis concreta ni digas que cambie su ratio, factor de sensibilidad o Toujeo. Cualquier ajuste de insulina debe llevar requiere_endocrino=true y proponerse como tema a comentar.
- Basa todo en los datos recibidos. Si hay pocos datos, dilo y sugiere qué anotar (lecturas a las 2 h, antes y después del gym, correcciones con glucemia).
- Las lecturas con "insulina" son glucemias a las que la persona se puso Fiasp en ese momento.
- Si hay glucosas bajas (< 70), prioriza ese patrón.`;

const n1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const clip = (v, len) => String(v ?? "").slice(0, len);

// Minutos desde medianoche en hora de Madrid
function minutesOfDay(ts) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
const dayKey = (ts) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(ts));
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;

export function computeStats(all, now = Date.now()) {
  const E = all.filter((e) => e.ts >= now - 28 * DAY && e.ts <= now + 6e5).sort((a, b) => a.ts - b.ts);
  const readings = E.filter((e) => e.type === "reading");
  const meals = E.filter((e) => e.type === "meal");
  const basals = E.filter((e) => e.type === "basal");
  const gymDays = new Set(E.filter((e) => e.gym).map((e) => dayKey(e.ts)));
  const vals = readings.map((r) => r.mgdl);

  // Cambio de glucosa tras comer: glucemia de la comida -> lectura "2 h después"
  const changes = [];
  meals.forEach((m) => {
    if (!(m.carbs > 0) || !(m.bg > 0)) return;
    const post = readings.find((r) => r.context === "post2h" && r.ts - m.ts >= 75 * 6e4 && r.ts - m.ts <= 210 * 6e4);
    if (post) changes.push(post.mgdl - m.bg);
  });

  // Gym: lectura "antes" y la siguiente "después" el mismo día
  const gymDeltas = [];
  readings.filter((r) => r.context === "pre_gym").forEach((pre) => {
    const post = readings.find((r) => r.context === "post_gym" && r.ts > pre.ts && r.ts - pre.ts <= 6 * 36e5);
    if (post) gymDeltas.push(post.mgdl - pre.mgdl);
  });

  // Toujeo: media circular de la hora y variación
  let toujeo = null;
  if (basals.length) {
    const mins = basals.map((b) => minutesOfDay(b.ts));
    const ang = mins.map((m) => (m / 1440) * 2 * Math.PI);
    const cs = mean(ang.map(Math.cos)), sn = mean(ang.map(Math.sin));
    const mid = ((Math.atan2(sn, cs) / (2 * Math.PI)) * 1440 + 1440) % 1440;
    const dev = mins.map((m) => { let d = m - mid; if (d > 720) d -= 1440; if (d < -720) d += 1440; return d; });
    const sd = Math.sqrt(mean(dev.map((d) => d * d)));
    toujeo = { registros: basals.length, dosis_media: n1(mean(basals.map((b) => b.units))), hora_media: hhmm(mid), variacion_horaria_min: Math.round(sd) };
  } else toujeo = { registros: 0 };

  const dosisTotales = [
    ...meals.map((m) => m.dose),
    ...readings.filter((r) => r.dose > 0).map((r) => r.dose),
  ].filter((d) => d > 0);

  return {
    lecturas: readings.length,
    comidas: meals.length,
    media_lecturas: vals.length ? Math.round(mean(vals)) : null,
    bajas_menos_70: vals.filter((v) => v < 70).length,
    altas_mas_250: vals.filter((v) => v > 250).length,
    en_rango_pct: vals.length ? Math.round((vals.filter((v) => v >= 70 && v <= 180).length / vals.length) * 100) : null,
    dias_gym: gymDays.size,
    tomas_fiasp: dosisTotales.length,
    tras_comida: { n: changes.length, subida_media: changes.length ? Math.round(mean(changes)) : null },
    gym_antes_despues: { n: gymDeltas.length, suben: gymDeltas.filter((d) => d > 0).length, cambio_medio: gymDeltas.length ? Math.round(mean(gymDeltas)) : null },
    toujeo,
    _E: E,
  };
}

function signals(s, E, now) {
  const out = [];
  const last7 = E.filter((e) => e.type === "reading" && e.ts >= now - 7 * DAY);
  const low7 = last7.filter((r) => r.mgdl < 70);
  if (low7.length) out.push(`${low7.length} lectura${low7.length > 1 ? "s" : ""} por debajo de 70 en los últimos 7 días.`);
  if (last7.some((r) => r.mgdl < 54)) out.push("Hay alguna lectura por debajo de 54 mg/dL en la última semana.");
  if (s.altas_mas_250) out.push(`${s.altas_mas_250} lectura${s.altas_mas_250 > 1 ? "s" : ""} por encima de 250 en 28 días.`);
  if (s.comidas >= 3 && s.tras_comida.n === 0) out.push("Hay comidas guardadas, pero ninguna con glucemia previa y lectura de 2 horas después: sin ellas no se puede evaluar tu ratio.");
  if (s.toujeo.registros > 1 && s.toujeo.variacion_horaria_min > 90) out.push(`La hora de tu Toujeo varía unos ${s.toujeo.variacion_horaria_min} min entre días.`);
  if (s.lecturas < 10) out.push("Hay pocas lecturas en 28 días: el análisis será poco fiable.");
  return out;
}

// Eventos compactos para la IA
function compactEvents(E) {
  return E.slice(-70).map((e) => {
    const t = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date(e.ts));
    if (e.type === "reading") return { t, tipo: "lectura", mgdl: e.mgdl, momento: e.context, insulina: e.dose > 0 ? e.dose : undefined, gym: e.gym || undefined };
    if (e.type === "meal") return { t, tipo: e.kind || "comida", hidratos: e.carbs, glucemia: e.bg ?? undefined, insulina: e.dose, sugerida: e.suggested ?? undefined, gym: e.gym || undefined };
    if (e.type === "basal") return { t, tipo: "toujeo", u: e.units };
    if (e.type === "day") return { t, tipo: "gym" };
    return null;
  }).filter(Boolean);
}

const PRIOS = ["alta", "media", "baja"];

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return reply(405, { error: "Método no permitido" });
  const bad = checkAuth(req);
  if (bad) return bad;

  try {
    const body = await req.json().catch(() => ({}));
    const now = Date.now();
    const all = await loadEntries(2);
    const full = computeStats(all, now);
    const { _E: E, ...stats } = full;
    const senales = signals(stats, E, now);

    const lows7 = E.filter((e) => e.type === "reading" && e.mgdl < 70 && e.ts >= now - 7 * DAY).length;
    const out = {
      stats,
      senales,
      alerta: lows7 >= 2 ? `Has tenido ${lows7} lecturas bajas (< 70) esta semana. Comenta este patrón con tu endocrino.` : "",
      resumen: "",
      patrones: [],
      sugerencias: [],
      preguntas_endocrino: [],
    };

    if (!E.length) {
      out.resumen = "Todavía no hay datos de los últimos 28 días. Anota lecturas, comidas y correcciones para que el análisis tenga de qué partir.";
      return reply(200, out);
    }

    try {
      const s = body?.settings || {};
      const ai = await askGemini({
        system: SYSTEM,
        text: JSON.stringify({
          ajustes_actuales: { ratio_g_por_U: clip(s.icr, 10), sensibilidad_mgdl_por_U: clip(s.isf, 10), objetivo_mgdl: clip(s.target, 10) },
          estadisticas: stats,
          senales,
          eventos_recientes: compactEvents(E),
        }),
      });
      out.resumen = clip(ai.resumen, 600);
      out.patrones = (Array.isArray(ai.patrones) ? ai.patrones : []).slice(0, 4).map((p) => ({ titulo: clip(p?.titulo, 100), detalle: clip(p?.detalle, 400) }));
      out.sugerencias = (Array.isArray(ai.sugerencias) ? ai.sugerencias : []).slice(0, 4).map((x) => ({
        texto: clip(x?.texto, 300),
        prioridad: PRIOS.includes(x?.prioridad) ? x.prioridad : "media",
        requiere_endocrino: x?.requiere_endocrino !== false,
      }));
      out.preguntas_endocrino = (Array.isArray(ai.preguntas_endocrino) ? ai.preguntas_endocrino : []).slice(0, 5).map((q) => clip(q, 250));
    } catch (err) {
      console.error("Coach IA", err);
      out.aviso_ia = clip(err.message || "error desconocido", 200);
    }
    return reply(200, out);
  } catch (err) {
    console.error(err);
    return reply(500, { error: "No se pudo preparar el análisis" });
  }
};

export const config = { path: "/api/coach" };
