// POST /api/analyze  { type: "food" | "glucose", image: <base64>, mediaType: "image/jpeg" }
// Variables de entorno: GEMINI_API_KEY, APP_PASSWORD (obligatorias); GEMINI_MODEL, ALLOWED_ORIGIN (opcionales).
import { checkAuth, preflight, reply } from "../lib/shared.mjs";

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

const FOOD_SYSTEM = `Eres un dietista experto en nutrición para personas con diabetes tipo 1 que cuentan hidratos.
Recibes la foto de un plato. Identifica cada alimento visible, estima los gramos de ración tal y como se ve en el plato
(cocinado, si lo está) y los gramos de hidratos de carbono disponibles por cada 100 g de ese alimento, usando valores
de tablas de composición de alimentos (BEDCA, USDA) y de productos habituales del mercado alimentario.
Reglas:
- Devuelve SOLO un objeto JSON con este formato:
  {"items":[{"nombre":"","gramos":0,"carbs_100g":0,"confianza":"alta|media|baja"}],"notas":""}
- Si no hay comida en la imagen, devuelve {"items":[],"notas":"No se ve comida"}.
- Separa los alimentos que aporten hidratos de forma relevante (arroz, pan, patata, fruta, salsas azucaradas, rebozados).
- Marca "baja" la confianza cuando el tamaño de la ración, la salsa o los ingredientes ocultos sean difíciles de estimar.
- En "notas", una frase corta en español con lo que más puede alterar la estimación.
- No des consejos de insulina ni dosis.`;

const GLUCOSE_SYSTEM = `Lees capturas de gráficas e informes de glucosa de sensores continuos (FreeStyle Libre, LibreView, Dexcom, etc.).
Extrae solo lo que se vea con claridad. Si un dato no aparece, usa null: no inventes valores.
Si la imagen está en mmol/L, convierte a mg/dL multiplicando por 18.
Devuelve SOLO un objeto JSON con este formato:
{"periodo":"","media_mgdl":null,"tir_pct":null,"bajo_pct":null,"alto_pct":null,"hipos":null,"min_mgdl":null,"max_mgdl":null,"patrones":[""],"notas":""}
- "periodo": el rango de fechas o el tipo de gráfica que se ve (por ejemplo "últimas 24 h" o "14 días").
- "tir_pct": porcentaje de tiempo en rango; "bajo_pct" y "alto_pct": porcentaje por debajo y por encima del rango.
- "hipos": número de eventos de glucosa baja si aparece.
- "patrones": hasta 3 observaciones breves y objetivas sobre lo que se ve (por ejemplo "subida tras la comida del mediodía").
- No des consejos de insulina ni dosis.`;

const n = (v, min, max) => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? null : Math.min(max, Math.max(min, x));
};

// ---- Llamada a Gemini con reintentos y modelo de respaldo ----
// Modelo principal: GEMINI_MODEL (si existe) y después estos de respaldo.
// Comprueba en la documentación de Google que los nombres siguen vigentes.
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEADLINE_MS = 9000; // Netlify corta las funciones a los ~10 s por defecto
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askGemini({ system, parts }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Falta GEMINI_API_KEY en Netlify"), { status: 500 });

  const models = [...new Set([process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });

  const t0 = Date.now();
  let lastStatus = 0;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = DEADLINE_MS - (Date.now() - t0);
      if (left < 1500) break;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(left, 6500));
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body,
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
          const clean = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
          try {
            return JSON.parse(clean);
          } catch {
            lastStatus = 502; // respuesta que no es JSON: se trata como fallo temporal
          }
        } else {
          lastStatus = res.status;
          if (!RETRYABLE.has(res.status)) {
            throw Object.assign(new Error(`Gemini devolvió un error (${res.status})`), { status: 502 });
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (err.status) throw err;
        lastStatus = lastStatus || 504; // tiempo agotado o fallo de red
      }
      await sleep(500 * (attempt + 1));
    }
  }
  throw Object.assign(
    new Error(`Gemini está saturado ahora mismo (${lastStatus || 503}). Inténtalo de nuevo en un minuto`),
    { status: 503 }
  );
}

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return reply(405, { error: "Método no permitido" });
  const bad = checkAuth(req);
  if (bad) return bad;

  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "Petición no válida" });
  }
  const { type, image, mediaType } = body || {};
  if (!["food", "glucose"].includes(type)) return reply(400, { error: "Tipo no válido" });
  if (typeof image !== "string" || !MEDIA_TYPES.includes(mediaType)) return reply(400, { error: "Imagen no válida" });
  if (image.length > 5_500_000) return reply(413, { error: "La imagen es demasiado grande" });

  try {
    const parsed = await askGemini({
      system: type === "food" ? FOOD_SYSTEM : GLUCOSE_SYSTEM,
      parts: [
        { inline_data: { mime_type: mediaType, data: image } },
        { text: type === "food" ? "Analiza este plato y devuelve el JSON." : "Extrae los datos de esta gráfica y devuelve el JSON." },
      ],
    });

    if (type === "food") {
      const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 15).map((i) => ({
        nombre: String(i.nombre || "Alimento").slice(0, 60),
        gramos: n(i.gramos, 0, 2000) ?? 0,
        carbs_100g: n(i.carbs_100g, 0, 100) ?? 0,
        confianza: ["alta", "media", "baja"].includes(i.confianza) ? i.confianza : "media",
      }));
      return reply(200, { items, notas: String(parsed.notas || "").slice(0, 300) });
    }

    return reply(200, {
      periodo: String(parsed.periodo || "").slice(0, 60),
      media_mgdl: n(parsed.media_mgdl, 20, 600),
      tir_pct: n(parsed.tir_pct, 0, 100),
      bajo_pct: n(parsed.bajo_pct, 0, 100),
      alto_pct: n(parsed.alto_pct, 0, 100),
      hipos: n(parsed.hipos, 0, 200),
      min_mgdl: n(parsed.min_mgdl, 20, 600),
      max_mgdl: n(parsed.max_mgdl, 20, 600),
      patrones: (Array.isArray(parsed.patrones) ? parsed.patrones : []).slice(0, 3).map((p) => String(p).slice(0, 160)),
      notas: String(parsed.notas || "").slice(0, 300),
    });
  } catch (err) {
    console.error(err);
    return reply(err.status || 500, { error: err.message || "No se pudo analizar la imagen" });
  }
};

export const config = { path: "/api/analyze" };