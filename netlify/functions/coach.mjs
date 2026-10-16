// POST /api/coach  { settings: { icr, isf, target } }  -> evaluación de los últimos 28 días según el protocolo de tu endocrino
// Todo lo numérico se calcula aquí con tus datos (registros y sensor Libre); Gemini solo redacta la interpretación.
import { askGemini, checkAuth, loadEntries, preflight, reply, store } from "../lib/shared.mjs";

const DAY = 864e5;
const TZ = "Europe/Madrid";

const SYSTEM = `Eres el coach de datos de una persona adulta con diabetes tipo 1 (Fiasp como insulina rápida, Toujeo como basal, hace gimnasio).
Tu papel es analizar sus datos con la mirada de un endocrinólogo muy experto, siguiendo el PROTOCOLO que su endocrino le entregó.

PROTOCOLO DE SU ENDOCRINO (marco principal):
- Objetivos: glucosa en rango 70-180 mg/dL; GMI < 7 %; variabilidad (CV) <= 36 %; glucosa 2 h después de comer < 180 mg/dL.
- GMI (%) = 3,31 + 0,02392 x glucosa media (mg/dL).
- Hipoglucemia (< 70): regla del 15. Si está consciente: 15 g de hidratos de absorción rápida, esperar 15 min, repetir la medición y repetir si sigue < 70; cuando sube, 15 g de absorción lenta. Si está inconsciente: glucagón.
- 1 ración (R) = 10 g de hidratos. La ratio se expresa en UI/ración (UI/r) o en g/UI, y g/UI = 10 / (UI/r). La ratio puede ser distinta en desayuno, comida y cena.
- Evaluar la ratio de una comida: misma cantidad de hidratos y misma dosis varios días (mínimo 3), con glucosa previa en objetivo, mirando la glucosa a las 2 h. Hiperglucemia posprandial: hay que SUBIR la ratio UI/r (bajar g/UI). Hipoglucemia posprandial: hay que BAJAR UI/r (subir g/UI). El tamaño del cambio depende de la dosis, de los hidratos habituales y de la glucosa posterior. Se puede revisar una comida por semana.
- Reglas orientativas (una sola ratio para todo el día): g/UI = 500 / DTI; Davidson: g/UI = 6,17 x peso / DTI. DTI = dosis total diaria (basal + rápida).
- Factor de sensibilidad (FSI, mg/dL que baja 1 UI de rápida) = 1800 / DTI para análogos rápidos. Corrección = (glucemia actual - glucemia objetivo) / FSI, con o sin ingesta. Puede variar por estrés o actividad física. Si hay hiperglucemia antes de comer: dosis = hidratos / ratio + corrección.

QUÉ RECIBES: estadísticas ya calculadas (no las recalcules ni las inventes), señales, eventos recientes y "preparacion", que dice si hay datos suficientes.
Si estadisticas.sensor existe, la persona lleva un sensor continuo FreeStyle Libre 2: las medias, el GMI, el CV y los tiempos en rango son fiables y puedes usar estadisticas.sensor.perfil_3h para hablar de patrones por franja horaria.
Devuelve SOLO un objeto JSON con este formato:
{"resumen":"","patrones":[{"titulo":"","detalle":""}],"sugerencias":[{"texto":"","prioridad":"alta|media|baja","requiere_endocrino":true}],"preguntas_endocrino":[""]}

REGLAS:
- Español, claro y concreto. Cita siempre los datos (número de registros, medianas, porcentajes).
- Si preparacion.nivel es "completo": haz la evaluación completa en este orden: (1) control global frente a los objetivos, (2) cada comida (desayuno, comida, cena) según su ratio y la glucosa a las 2 h, (3) correcciones y sensibilidad, (4) glucosa en ayunas y de madrugada frente al Toujeo, (5) gimnasio, (6) hipoglucemias y variabilidad, (7) prioridades. resumen: 4 a 6 frases.
- Si es "preliminar": di claramente que es una evaluación preliminar, comenta solo lo que los datos sostienen y no saques conclusiones sobre lo que falta. resumen: 2 a 3 frases.
- Para ajustes de ratio indica solo la DIRECCIÓN según la regla de su endocrino (subir o bajar UI/r) y que la cantidad la decide su endocrino. NUNCA des una dosis concreta, un valor nuevo de ratio, de factor de sensibilidad ni de Toujeo. Todo lo que implique insulina lleva requiere_endocrino=true.
- Si una comida solo tiene datos de pocas veces (menos de 3), no concluyas sobre su ratio.
- Las lecturas con "insulina" son glucemias a las que se puso Fiasp en ese momento.
- Si NO existe estadisticas.sensor, las medias, GMI y CV calculados con lecturas sueltas son aproximados: dilo si los usas.
- Si hay glucosas bajas (< 70), es la prioridad número uno y recuerda la regla del 15.
- Máximo 5 patrones, 5 sugerencias y 6 preguntas.`;

const n1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clip = (v, len) => String(v ?? "").slice(0, len);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const isPost = (c) => typeof c === "string" && c.startsWith("post2h");

function minutesOfDay(ts) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ts));
  return (Number(parts.find((p) => p.type === "hour").value) % 24) * 60 + Number(parts.find((p) => p.type === "minute").value);
}
const dayKey = (ts) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(ts));
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const SLOTS = [["desayuno", "05:00 a 11:59"], ["comida", "12:00 a 16:59"], ["cena", "17:00 a 21:59"]];
const slotOf = (ts) => { const h = Math.floor(minutesOfDay(ts) / 60); return h >= 5 && h < 12 ? "desayuno" : h >= 12 && h < 17 ? "comida" : h >= 17 && h < 22 ? "cena" : null; };
const gmiOf = (media) => (media > 0 ? n1(3.31 + 0.02392 * media) : null);

// Lectura más cercana a un momento, dentro de una tolerancia en minutos
const nearestTo = (arr, ts, tolMin) => {
  let best = null, bd = tolMin * 6e4 + 1;
  for (const r of arr) { const d = Math.abs(r.ts - ts); if (d < bd) { bd = d; best = r; } }
  return best;
};
// Episodios de glucosa baja (lecturas < 70 separadas más de 45 min). rs debe estar ordenado por fecha.
const lowEpisodes = (rs) => {
  let n = 0, lastLow = -Infinity;
  rs.forEach((r) => { if (r.mgdl < 70) { if (r.ts - lastLow > 45 * 6e4) n++; lastLow = r.ts; } });
  return n;
};

// Histórico del sensor guardado por /api/libre (puntos [ts, mg/dL] cada 15 min)
async function loadSensor(days = 28) {
  const s = store();
  const now = new Date();
  const keys = [0, 1].map((i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `sensor/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const lists = await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)));
  const from = Date.now() - days * DAY;
  return lists
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .filter((p) => p[0] >= from)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, mgdl]) => ({ id: "s" + ts, type: "reading", ts, mgdl, context: "sensor", sensor: true }));
}

export function computeStats(all, now = Date.now(), settings = {}, sensorPts = []) {
  const icr = parseFloat(settings.icr), isf = parseFloat(settings.isf), target = parseFloat(settings.target);
  const E = all.filter((e) => e.ts >= now - 28 * DAY && e.ts <= now + 6e5).sort((a, b) => a.ts - b.ts);
  const manual = E.filter((e) => e.type === "reading");
  const meals = E.filter((e) => e.type === "meal" && (e.kind || "comida") === "comida");
  const basals = E.filter((e) => e.type === "basal");
  const charts = E.filter((e) => e.type === "chart");
  const sens = sensorPts.filter((p) => p.ts >= now - 28 * DAY && p.ts <= now + 6e5);
  const readings = [...manual, ...sens].sort((a, b) => a.ts - b.ts);
  const usaSensor = sens.length >= 96; // al menos un día de datos
  const gymDays = new Set(E.filter((e) => e.gym).map((e) => dayKey(e.ts)));
  const vals = readings.map((r) => r.mgdl);
  const bol = E.filter((e) => e.type === "meal" || (e.type === "reading" && e.dose > 0))
    .map((e) => (e.type === "reading" ? { ...e, kind: e.kind || "correccion", carbs: 0, bg: e.mgdl } : e));

  // Lectura a las 2 h de una comida: la que anotaste tú o, si no hay, la del sensor
  const post2hFor = (m) => {
    const man = manual.find((r) => isPost(r.context) && r.ts - m.ts >= 75 * 6e4 && r.ts - m.ts <= 210 * 6e4);
    if (man) return man;
    const t = m.ts + 120 * 6e4;
    return t <= now ? nearestTo(sens, t, 15) : null;
  };

  // ----- Cambio tras comer (glucemia de la comida -> lectura a las 2 h)
  const changes = [];
  meals.forEach((m) => {
    if (!(m.carbs > 0) || !(m.bg > 0)) return;
    const post = post2hFor(m);
    if (post) changes.push(post.mgdl - m.bg);
  });

  // ----- Gym (sesiones con lectura antes y después, de registros antiguos)
  const gymDeltas = [];
  manual.filter((r) => r.context === "pre_gym").forEach((pre) => {
    const post = manual.find((r) => r.context === "post_gym" && r.ts > pre.ts && r.ts - pre.ts <= 6 * 36e5);
    if (post) gymDeltas.push(post.mgdl - pre.mgdl);
  });

  // ----- Gym: días de gym frente a días sin gym
  const perDay = new Map();
  readings.forEach((r) => { const d = dayKey(r.ts); perDay.set(d, (perDay.get(d) || 0) + 1); });
  const gymDaysWithData = [...gymDays].filter((d) => (perDay.get(d) || 0) >= 10).length;
  const gymR = readings.filter((r) => gymDays.has(dayKey(r.ts)));
  const noGymR = readings.filter((r) => !gymDays.has(dayKey(r.ts)));
  const tirOf = (a) => Math.round((a.filter((r) => r.mgdl >= 70 && r.mgdl <= 180).length / a.length) * 100);
  const gym_dias = gymR.length >= 20 && noGymR.length >= 20
    ? { dias_gym: gymDays.size, media_gym: Math.round(mean(gymR.map((r) => r.mgdl))), media_sin: Math.round(mean(noGymR.map((r) => r.mgdl))),
        tir_gym: tirOf(gymR), tir_sin: tirOf(noGymR), bajas_gym: lowEpisodes(gymR), bajas_sin: lowEpisodes(noGymR) }
    : null;

  // ----- Toujeo
  let toujeo = { registros: 0 };
  if (basals.length) {
    const mins = basals.map((b) => minutesOfDay(b.ts));
    const ang = mins.map((m) => (m / 1440) * 2 * Math.PI);
    const mid = ((Math.atan2(mean(ang.map(Math.sin)), mean(ang.map(Math.cos))) / (2 * Math.PI)) * 1440 + 1440) % 1440;
    const dev = mins.map((m) => { let d = m - mid; if (d > 720) d -= 1440; if (d < -720) d += 1440; return d; });
    toujeo = { registros: basals.length, dosis_media: n1(mean(basals.map((b) => b.units))), hora_media: hhmm(mid), variacion_horaria_min: Math.round(Math.sqrt(mean(dev.map((d) => d * d)))) };
  }

  // ----- Ayunas y madrugada (para valorar la basal)
  const grupo = (pred) => {
    const v = readings.filter(pred).map((r) => r.mgdl);
    return { n: v.length, mediana: v.length ? Math.round(median(v)) : null, pct_alta: pct(v.filter((x) => x > 130).length, v.length), pct_baja: pct(v.filter((x) => x < 70).length, v.length) };
  };
  const ayunas = grupo((r) => r.context === "ayunas");
  const noche = grupo((r) => r.context === "noche" || minutesOfDay(r.ts) < 360); // de 0:00 a 5:59 y lecturas antiguas "noche"

  // ----- Control global frente a los objetivos
  const media = vals.length ? mean(vals) : null;
  const sd = vals.length > 1 ? Math.sqrt(mean(vals.map((v) => (v - media) ** 2))) : null;
  const cv = media && sd != null ? Math.round((sd / media) * 100) : null;
  const tir = pct(vals.filter((v) => v >= 70 && v <= 180).length, vals.length);
  const tbr = pct(vals.filter((v) => v < 70).length, vals.length);
  const tar = pct(vals.filter((v) => v > 180).length, vals.length);
  const post2hVals = meals.filter((m) => (m.kind || "comida") === "comida" && m.carbs >= 10).map(post2hFor).filter(Boolean).map((r) => r.mgdl);
  const post2hOk = pct(post2hVals.filter((v) => v < 180).length, post2hVals.length);
  const chart = [...charts].reverse().find((c) => c.summary && c.summary.media_mgdl != null);

  const fila = (indicador, valor, objetivo, estado, nota = "") => ({ indicador, valor, objetivo, estado, nota });
  const nota = usaSensor ? "Calculado con tu sensor continuo." : "Aproximado: son lecturas sueltas, no un sensor continuo.";
  const filas = [
    fila("Tiempo en rango 70-180", tir != null ? `${tir} %` : "sin datos", "lo más alto posible", tir == null ? "sin_datos" : tir >= 70 ? "ok" : "revisar", nota),
    fila("Glucosa 2 h después de comer", post2hOk != null ? `${post2hOk} % por debajo de 180 (${post2hVals.length} comidas)` : "sin datos", "< 180 mg/dL", post2hOk == null ? "sin_datos" : post2hOk >= 70 ? "ok" : "revisar"),
    fila("GMI", media ? `${gmiOf(media)} %` : "sin datos", "< 7 %", !media ? "sin_datos" : gmiOf(media) < 7 ? "ok" : "revisar", nota),
    fila("Variabilidad (CV)", cv != null ? `${cv} %` : "sin datos", "<= 36 %", cv == null ? "sin_datos" : cv <= 36 ? "ok" : "revisar", usaSensor ? nota : "Aproximado: el CV fiable sale de un sensor continuo."),
  ];
  if (usaSensor) {
    filas.push(fila("Tiempo por debajo de 70", `${tbr} %`, "< 4 %", tbr < 4 ? "ok" : "revisar", nota));
    filas.push(fila("Tiempo por encima de 180", `${tar} %`, "< 25 %", tar < 25 ? "ok" : "revisar", nota));
  }
  if (chart && !usaSensor) {
    const s = chart.summary;
    filas.push(fila(`GMI de tu gráfica (${s.periodo || "sensor"})`, `${gmiOf(s.media_mgdl)} %`, "< 7 %", gmiOf(s.media_mgdl) < 7 ? "ok" : "revisar", "Calculado con la media de la gráfica del sensor."));
  }
  const eps = lowEpisodes(readings);
  filas.push(fila("Episodios de glucosa baja (< 70) en 28 días", `${eps}`, "0", eps ? "revisar" : vals.length ? "ok" : "sin_datos", "Si hay una baja: regla del 15."));

  // ----- Ratio por comida (desayuno, comida, cena)
  const S = Object.fromEntries(SLOTS.map(([k]) => [k, { comidas: 0, descartadas: 0, sin_control: 0, validas: [] }]));
  bol.forEach((m, i) => {
    if ((m.kind || "comida") !== "comida" || !(m.carbs >= 10)) return;
    const s = slotOf(m.ts); if (!s) return;
    S[s].comidas++;
    let pre = m.bg > 0 ? m.bg : null;
    if (pre == null) { const r = [...readings].reverse().find((x) => x.ts <= m.ts && m.ts - x.ts <= 45 * 6e4); if (r) pre = r.mgdl; }
    if (!(pre >= 70 && pre <= 180)) { S[s].descartadas++; return; }
    const post = post2hFor(m);
    const next = bol[i + 1];
    if (!post || (next && next.ts < post.ts)) { S[s].sin_control++; return; }
    const corr = isf > 0 && target > 0 && pre > target ? (pre - target) / isf : 0;
    S[s].validas.push({ ui_r: Math.max(0, m.dose - corr) / (m.carbs / 10), post: post.mgdl });
  });
  const franjas = SLOTS.map(([k, horas]) => {
    const f = S[k], n = f.validas.length;
    const posts = f.validas.map((v) => v.post);
    const uiR = n ? median(f.validas.map((v) => v.ui_r)) : null;
    const alta = pct(posts.filter((v) => v > 180).length, n), baja = pct(posts.filter((v) => v < 70).length, n);
    let estado = "pocos_datos", lectura = `Hacen falta al menos 3 comidas con glucosa previa entre 70 y 180 y lectura a las 2 h (tienes ${n}).`;
    if (n >= 3) {
      if (baja >= 34) { estado = "baja"; lectura = "Glucosa baja a las 2 h: según la regla de tu endocrino, habría que bajar UI/r (subir g/UI). Coméntalo con él."; }
      else if (alta >= 50) { estado = "alta"; lectura = "Hiperglucemia posprandial: según la regla de tu endocrino, habría que subir UI/r (bajar g/UI). Coméntalo con él."; }
      else { estado = "objetivo"; lectura = "A las 2 h la glucosa está en objetivo: la ratio de esta comida encaja con tus datos."; }
      if (baja > 0 && estado !== "baja") lectura += " Ojo: alguna lectura a las 2 h fue baja.";
    }
    return { franja: k, horas, comidas: f.comidas, validas: n, descartadas_glucemia_previa: f.descartadas, sin_control_2h: f.sin_control,
      ui_r: uiR != null ? n1(uiR) : null, g_ui: uiR > 0 ? n1(10 / uiR) : null,
      post_mediana: n ? Math.round(median(posts)) : null, post_alta_pct: alta, post_baja_pct: baja, estado, lectura };
  });

  // ----- Correcciones y sensibilidad
  const corrs = [];
  bol.forEach((m, i) => {
    if (m.kind !== "correccion" || !(m.dose > 0) || !(m.bg > 0)) return;
    let r = manual.find((x) => x.ts - m.ts >= 150 * 6e4 && x.ts - m.ts <= 300 * 6e4);
    if (!r && m.ts + 210 * 6e4 <= now) r = nearestTo(sens, m.ts + 210 * 6e4, 30);
    const next = bol[i + 1];
    if (!r || (next && next.ts < r.ts)) return;
    if (m.bg - r.mgdl > 0) corrs.push((m.bg - r.mgdl) / m.dose);
  });
  const rapidas = bol.filter((m) => m.dose > 0);
  const diasRapida = new Set(rapidas.map((m) => dayKey(m.ts)));
  const fiaspDia = diasRapida.size ? rapidas.reduce((a, m) => a + m.dose, 0) / diasRapida.size : null;
  const dti = fiaspDia != null && toujeo.dosis_media != null ? fiaspDia + toujeo.dosis_media : null;
  const sensibilidad = {
    correcciones_validas: corrs.length,
    observada_mgdl_por_UI: corrs.length ? Math.round(median(corrs)) : null,
    configurada_mgdl_por_UI: isf > 0 ? isf : null,
    dti_estimada: dti != null ? n1(dti) : null,
    dias_con_fiasp_registrada: diasRapida.size,
    dti_fiable: diasRapida.size >= 7 && basals.length >= 3,
    fsi_regla_1800: dti ? Math.round(1800 / dti) : null,
    g_por_UI_regla_500: dti ? n1(500 / dti) : null,
    ratio_configurada_g_por_UI: icr > 0 ? icr : null,
    ratio_configurada_UI_por_racion: icr > 0 ? n1(10 / icr) : null,
    nota: "La DTI estimada solo es fiable si anotas TODAS tus dosis de Fiasp y de Toujeo. Es un contraste con las reglas 1800 y 500, no una pauta.",
  };

  // ----- Resumen del sensor (para el análisis y para el perfil por horas)
  let sensorInfo = null;
  if (usaSensor) {
    const sv = sens.map((p) => p.mgdl), sm = mean(sv);
    const ssd = Math.sqrt(mean(sv.map((v) => (v - sm) ** 2)));
    const span = Math.max(0.1, Math.min(28, (now - sens[0].ts) / DAY));
    const perfil = [];
    for (let b = 0; b < 8; b++) {
      const v = sens.filter((p) => Math.floor(minutesOfDay(p.ts) / 180) === b).map((p) => p.mgdl);
      perfil.push({ franja: `${String(b * 3).padStart(2, "0")}-${String(b * 3 + 3).padStart(2, "0")} h`, mediana: v.length ? Math.round(median(v)) : null });
    }
    sensorInfo = {
      dias: n1(span), cobertura_pct: Math.min(100, Math.round((sens.length / (span * 96)) * 100)),
      media: Math.round(sm), cv_pct: Math.round((ssd / sm) * 100),
      tir_pct: pct(sv.filter((v) => v >= 70 && v <= 180).length, sv.length),
      bajo_70_pct: pct(sv.filter((v) => v < 70).length, sv.length),
      alto_180_pct: pct(sv.filter((v) => v > 180).length, sv.length),
      perfil_3h: perfil,
    };
  }

  // ----- ¿Hay datos suficientes?
  const diasConLectura = new Set(readings.map((r) => dayKey(r.ts))).size;
  const item = (texto, tengo, necesito, esencial = false) => ({ texto, tengo, necesito, ok: tengo >= necesito, esencial });
  const items = [
    item("Lecturas de glucosa", readings.length, 40, true),
    item("Días distintos con lecturas", diasConLectura, 14, true),
    ...franjas.map((f) => item(`Comidas válidas de ${f.franja} (glucosa previa 70-180 y lectura a las 2 h)`, f.validas, 3)),
    item("Correcciones con control a las 3 o 4 h", corrs.length, 3),
    item("Días de gym con lecturas", gymDaysWithData, 3),
    item("Registros de Toujeo", basals.length, 7),
    item("Lecturas en ayunas (antes de desayunar)", ayunas.n, 5),
  ];
  const listo = items.filter((i) => i.esencial).every((i) => i.ok) && franjas.some((f) => f.validas >= 3);
  const preparacion = { nivel: listo ? "completo" : "preliminar", porcentaje: Math.round((items.filter((i) => i.ok).length / items.length) * 100), items };

  return {
    lecturas: readings.length, lecturas_sensor: sens.length, comidas: meals.length,
    media_lecturas: media != null ? Math.round(media) : null,
    bajas_menos_70: vals.filter((v) => v < 70).length,
    bajas_menos_54: vals.filter((v) => v < 54).length,
    episodios_bajos: eps,
    altas_mas_250: vals.filter((v) => v > 250).length,
    en_rango_pct: tir, dias_gym: gymDays.size,
    tras_comida: { n: changes.length, subida_media: changes.length ? Math.round(mean(changes)) : null },
    gym_antes_despues: { n: gymDeltas.length, suben: gymDeltas.filter((d) => d > 0).length, cambio_medio: gymDeltas.length ? Math.round(mean(gymDeltas)) : null },
    gym_dias, sensor: sensorInfo,
    toujeo, ayunas, madrugada: noche,
    objetivos: { filas }, ratios: { franjas }, sensibilidad, preparacion,
    _E: E, _R: readings,
  };
}

function signals(s, R, now) {
  const out = [];
  const last7 = R.filter((r) => r.ts >= now - 7 * DAY);
  const ep7 = lowEpisodes(last7);
  if (ep7) out.push(`${ep7} episodio${ep7 > 1 ? "s" : ""} de glucosa baja (< 70) en los últimos 7 días.`);
  if (last7.some((r) => r.mgdl < 54)) out.push("Hay alguna lectura por debajo de 54 mg/dL en la última semana.");
  if (s.altas_mas_250) out.push(`${s.altas_mas_250} lectura${s.altas_mas_250 > 1 ? "s" : ""} por encima de 250 en 28 días.`);
  const sinPrevia = s.ratios.franjas.reduce((a, f) => a + f.descartadas_glucemia_previa, 0);
  if (sinPrevia >= 3) out.push(`${sinPrevia} comidas no sirven para evaluar la ratio porque no tienen glucosa previa entre 70 y 180.`);
  if (s.ayunas.n >= 3 && s.ayunas.mediana > 130) out.push(`Tu glucosa antes de desayunar tiene una mediana de ${s.ayunas.mediana} mg/dL.`);
  if (s.madrugada.pct_baja > 0) out.push("Hay lecturas bajas de noche o madrugada: valóralo con tu endocrino por si afecta a la basal.");
  if (s.toujeo.registros > 1 && s.toujeo.variacion_horaria_min > 90) out.push(`La hora de tu Toujeo varía unos ${s.toujeo.variacion_horaria_min} min entre días.`);
  if (s.lecturas < 10) out.push("Hay pocas lecturas en 28 días: el análisis será poco fiable.");
  return out;
}

function compactEvents(E) {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
  return E.slice(-70).map((e) => {
    const t = f.format(new Date(e.ts));
    if (e.type === "reading") return { t, tipo: "lectura", mgdl: e.mgdl, momento: e.context, insulina: e.dose > 0 ? e.dose : undefined, gym: e.gym || undefined };
    if (e.type === "meal") return { t, tipo: e.kind || "comida", hidratos: e.carbs, glucemia: e.bg ?? undefined, insulina: e.dose, sugerida: e.suggested ?? undefined, absorcion: e.absorb || undefined, gym: e.gym || undefined };
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
    const settings = body?.settings || {};
    const now = Date.now();
    const [all, sensorPts] = await Promise.all([loadEntries(2), loadSensor(28).catch(() => [])]);
    const full = computeStats(all, now, settings, sensorPts);
    const { _E: E, _R: R, objetivos, ratios, sensibilidad, preparacion, ...stats } = full;
    const senales = signals(full, R, now);

    const ep7 = lowEpisodes(R.filter((r) => r.ts >= now - 7 * DAY));
    const out = {
      stats, objetivos, ratios, sensibilidad, preparacion, senales,
      alerta: ep7 >= 2 ? `Has tenido ${ep7} episodios de glucosa baja (< 70) esta semana. Si te pasa: regla del 15 (15 g de hidratos rápidos, esperar 15 min y repetir). Comenta el patrón con tu endocrino.` : "",
      resumen: "", patrones: [], sugerencias: [], preguntas_endocrino: [],
    };

    if (!R.length && !E.length) {
      out.resumen = "Todavía no hay datos de los últimos 28 días. Anota lecturas, comidas y correcciones, o conecta el sensor, para que el análisis tenga de qué partir.";
      return reply(200, out);
    }

    try {
      const ai = await askGemini({
        system: SYSTEM,
        text: JSON.stringify({
          ajustes_actuales: { ratio_g_por_UI: clip(settings.icr, 10), sensibilidad_mgdl_por_UI: clip(settings.isf, 10), objetivo_mgdl: clip(settings.target, 10) },
          preparacion, estadisticas: stats, objetivos: objetivos.filas, ratios_por_comida: ratios.franjas, sensibilidad, senales,
          eventos_recientes: compactEvents(E),
        }),
      });
      out.resumen = clip(ai.resumen, 1100);
      out.patrones = (Array.isArray(ai.patrones) ? ai.patrones : []).slice(0, 5).map((p) => ({ titulo: clip(p?.titulo, 100), detalle: clip(p?.detalle, 450) }));
      out.sugerencias = (Array.isArray(ai.sugerencias) ? ai.sugerencias : []).slice(0, 5).map((x) => ({
        texto: clip(x?.texto, 320),
        prioridad: PRIOS.includes(x?.prioridad) ? x.prioridad : "media",
        requiere_endocrino: x?.requiere_endocrino !== false,
      }));
      out.preguntas_endocrino = (Array.isArray(ai.preguntas_endocrino) ? ai.preguntas_endocrino : []).slice(0, 6).map((q) => clip(q, 250));
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