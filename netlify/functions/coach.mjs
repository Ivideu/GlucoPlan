// POST /api/coach  { settings: { icr, isf, target } }
// Analiza los últimos 28 días del historial. NO cambia ningún ajuste: solo propone hipótesis para revisar con el endocrino.
import { askGemini, checkAuth, loadEntries, preflight, reply } from "../lib/shared.mjs";

const TZ = "Europe/Madrid";
const dayOf = (ts) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: TZ });
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

function computeStats(entries) {
  const since = Date.now() - 28 * 864e5;
  const E = entries.filter((e) => e.ts >= since);
  const readings = E.filter((e) => e.type === "reading");
  const meals = E.filter((e) => e.type === "meal");
  const charts = E.filter((e) => e.type === "chart");

  const gymDays = new Set(E.filter((e) => e.gym).map((e) => dayOf(e.ts)));
  const carbDays = new Set(E.filter((e) => e.highCarb).map((e) => dayOf(e.ts)));
  const onGym = readings.filter((r) => gymDays.has(dayOf(r.ts)));
  const offGym = readings.filter((r) => !gymDays.has(dayOf(r.ts)));
  const onCarb = readings.filter((r) => carbDays.has(dayOf(r.ts)));
  const offCarb = readings.filter((r) => !carbDays.has(dayOf(r.ts)));

  const byContext = {};
  for (const r of readings) (byContext[r.context] ||= []).push(r.mgdl);
  const contexts = Object.fromEntries(Object.entries(byContext).map(([k, v]) => [k, { n: v.length, media: avg(v) }]));

  // Comidas con una lectura "2 h después" entre 75 y 210 minutos tras la comida.
  const post = [];
  for (const m of meals) {
    const r = readings.find((x) => x.context === "post2h" && x.ts - m.ts >= 75 * 6e4 && x.ts - m.ts <= 210 * 6e4);
    if (r) post.push({ carbs: m.carbs, dosis: m.dose, antes: m.bg, despues: r.mgdl, gym: gymDays.has(dayOf(m.ts)) });
  }
  const deltas = post.filter((p) => p.antes != null).map((p) => p.despues - p.antes);

  const lows = (a) => a.filter((r) => r.mgdl < 70).length;
  const stats = {
    dias_analizados: 28,
    lecturas: readings.length,
    comidas: meals.length,
    graficas: charts.length,
    media_lecturas: avg(readings.map((r) => r.mgdl)),
    bajas_menos_70: lows(readings),
    altas_mas_180: readings.filter((r) => r.mgdl > 180).length,
    por_contexto: contexts,
    dias_gym: gymDays.size,
    con_gym: { lecturas: onGym.length, media: avg(onGym.map((r) => r.mgdl)), bajas: lows(onGym) },
    sin_gym: { lecturas: offGym.length, media: avg(offGym.map((r) => r.mgdl)), bajas: lows(offGym) },
    dias_mas_hidratos: carbDays.size,
    con_mas_hidratos: { lecturas: onCarb.length, media: avg(onCarb.map((r) => r.mgdl)) },
    sin_mas_hidratos: { lecturas: offCarb.length, media: avg(offCarb.map((r) => r.mgdl)) },
    tras_comida: {
      n: post.length,
      media_despues: avg(post.map((p) => p.despues)),
      subida_media: avg(deltas),
      ejemplos: post.slice(0, 8),
    },
    graficas_resumen: charts.slice(0, 6).map((c) => ({ fecha: dayOf(c.ts), ...c.summary })),
  };

  const senales = [];
  if (readings.length < 10 && charts.length < 2) {
    senales.push("Todavía hay pocos datos: apunta lecturas (sobre todo 2 h después de comer) y sube una gráfica por semana.");
  }
  if (stats.bajas_menos_70 >= 2) {
    senales.push(`Hay ${stats.bajas_menos_70} lecturas por debajo de 70 mg/dL en 28 días. Antes de tocar nada, coméntalo con tu endocrino.`);
  }
  if (post.length >= 4 && stats.tras_comida.media_despues > 180) {
    senales.push(`A las 2 h de comer sueles estar en ${stats.tras_comida.media_despues} mg/dL de media (${post.length} comidas).`);
  }
  if (stats.con_gym.bajas > 0 && stats.con_gym.bajas > stats.sin_gym.bajas) {
    senales.push("Las bajadas se concentran en días de gimnasio.");
  }
  return { stats, senales };
}

const COACH_SYSTEM = `Eres un asistente de análisis de datos para una persona adulta con diabetes tipo 1 (insulina rápida Fiasp y basal Toujeo).
Recibes estadísticas de los últimos 28 días y sus ajustes actuales. Tu trabajo es describir patrones y proponer hipótesis que la persona pueda comentar con su endocrino.
Reglas estrictas:
- No eres médico y no tomas decisiones de dosis. Nunca des una dosis concreta para una comida.
- Nunca recomiendes cambiar la dosis de la insulina basal (Toujeo).
- Si propones revisar el ratio insulina/hidratos o el factor de sensibilidad, hazlo solo como hipótesis para consultar, con cambios pequeños (como máximo un 10 %), y solo si hay al menos 5 comidas con lectura posterior que lo apoyen. Marca siempre requiere_endocrino=true.
- Si hay 2 o más lecturas por debajo de 70 mg/dL, la prioridad es la seguridad: indícalo en "alerta" y no sugieras aumentar la dosis.
- Si hay pocos datos, dilo y explica qué datos faltan en lugar de inventar patrones.
- Compara días con gimnasio frente a días sin gimnasio y días con más hidratos frente al resto solo si hay datos en ambos grupos.
- Escribe en español, claro y breve, sin alarmismo.
Devuelve SOLO un objeto JSON con este formato:
{"resumen":"","alerta":"","patrones":[{"titulo":"","detalle":""}],"sugerencias":[{"texto":"","prioridad":"alta|media|baja","requiere_endocrino":true}],"preguntas_endocrino":[""]}
Usa "" en "alerta" si no hay ninguna.`;

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return reply(405, { error: "Método no permitido" });
  const bad = checkAuth(req);
  if (bad) return bad;

  const body = await req.json().catch(() => ({}));
  const settings = {
    ratio_insulina_hidratos: String(body.settings?.icr ?? "").slice(0, 10),
    factor_sensibilidad: String(body.settings?.isf ?? "").slice(0, 10),
    glucemia_objetivo: String(body.settings?.target ?? "").slice(0, 10),
  };

  let entries;
  try {
    entries = await loadEntries(2);
  } catch (err) {
    console.error(err);
    return reply(500, { error: "No se pudo leer el historial" });
  }

  const { stats, senales } = computeStats(entries);

  try {
    const ai = await askGemini({
      system: COACH_SYSTEM,
      parts: [{ text: JSON.stringify({ ajustes_actuales: settings, estadisticas: stats, senales_detectadas: senales }) }],
    });
    return reply(200, {
      stats,
      senales,
      resumen: String(ai.resumen || "").slice(0, 600),
      alerta: String(ai.alerta || "").slice(0, 400),
      patrones: (Array.isArray(ai.patrones) ? ai.patrones : []).slice(0, 6).map((p) => ({ titulo: String(p.titulo || "").slice(0, 100), detalle: String(p.detalle || "").slice(0, 400) })),
      sugerencias: (Array.isArray(ai.sugerencias) ? ai.sugerencias : []).slice(0, 6).map((s) => ({
        texto: String(s.texto || "").slice(0, 400),
        prioridad: ["alta", "media", "baja"].includes(s.prioridad) ? s.prioridad : "media",
        requiere_endocrino: s.requiere_endocrino !== false,
      })),
      preguntas_endocrino: (Array.isArray(ai.preguntas_endocrino) ? ai.preguntas_endocrino : []).slice(0, 5).map((q) => String(q).slice(0, 200)),
    });
  } catch (err) {
    console.error(err);
    // Si la IA falla, devolvemos igualmente las estadísticas y las señales calculadas.
    return reply(200, { stats, senales, resumen: "", alerta: "", patrones: [], sugerencias: [], preguntas_endocrino: [], aviso_ia: err.message });
  }
};

export const config = { path: "/api/coach" };
