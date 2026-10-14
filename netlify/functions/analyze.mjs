// POST /api/analyze
//   { type: "food", image: <base64>, mediaType: "image/jpeg" }  -> análisis de la foto de un plato
//   { type: "lookup", text: "arroz con tomate", grams: 200|null } -> busca un alimento escrito a mano
// Variables de entorno: GEMINI_API_KEY, APP_PASSWORD (obligatorias); GEMINI_MODEL, ALLOWED_ORIGIN (opcionales).
import { askGemini, checkAuth, preflight, reply } from "../lib/shared.mjs";

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

const ITEM_FORMAT = `Devuelve SOLO un objeto JSON con este formato:
{"items":[{"nombre":"","gramos":0,"carbs_100g":0,"proteina_100g":0,"grasa_100g":0,"fibra_100g":0,"absorcion":"rapida|mixta|lenta","confianza":"alta|media|baja"}],"notas":""}
- "carbs_100g": hidratos de carbono disponibles por 100 g. "proteina_100g", "grasa_100g" y "fibra_100g": gramos por 100 g.
- "absorcion": velocidad a la que sus hidratos pasan a la sangre: "rapida" (zumos, azúcar, pan blanco, bollería, fruta muy madura),
  "lenta" (legumbres, integrales, alimentos con mucha grasa o fibra) o "mixta" (el resto o sin hidratos).
- "notas": una frase corta en español con lo que más puede alterar la estimación (por ejemplo mucha grasa o salsas).
- No des consejos de insulina ni dosis.`;

const FOOD_SYSTEM = `Eres un dietista experto en nutrición para personas que cuentan hidratos.
Recibes la foto de un plato. Identifica TODOS los alimentos visibles (también proteínas, grasas, verduras y bebidas),
estima los gramos de ración tal y como se ve en el plato (cocinado, si lo está) y los valores por cada 100 g de ese alimento,
usando tablas de composición de alimentos (BEDCA, USDA) y productos habituales del mercado.
Si no hay comida en la imagen, devuelve {"items":[],"notas":"No se ve comida"}.
Máximo 10 alimentos; agrupa los muy pequeños (especias, aliños).
Marca "baja" la confianza cuando el tamaño de la ración, la salsa o los ingredientes ocultos sean difíciles de estimar.
${ITEM_FORMAT}`;

const LOOKUP_SYSTEM = `Eres un dietista experto en nutrición para personas que cuentan hidratos.
Recibes el nombre de un alimento, bebida, producto o plato (puede ser casero, de restaurante o de una marca habitual en España).
Búscalo en tus conocimientos de tablas de composición (BEDCA, USDA) y productos del mercado y devuelve sus valores.
Reglas:
- Si es un plato compuesto (paella, bocadillo de tortilla, macarrones con tomate), sepáralo en sus 2 a 5 componentes que más influyan en la glucosa
  (por ejemplo arroz, carne, salsa, pan) con sus gramos.
- Si el usuario indica una ración total en gramos, repártela entre los componentes para que sumen esa cantidad.
- Si NO indica ración, usa los gramos de una ración habitual para una persona adulta y ponlo en "gramos".
- Incluye también los componentes con poca cantidad de hidratos si tienen mucha grasa o proteína, porque pueden retrasar la subida de glucosa.
- Si no reconoces el alimento, devuelve {"items":[],"notas":"No he reconocido ese alimento"}.
${ITEM_FORMAT}`;

const n = (v, min, max) => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? null : Math.min(max, Math.max(min, x));
};

const cleanItems = (parsed, max) =>
  (Array.isArray(parsed.items) ? parsed.items : []).slice(0, max).map((i) => ({
    nombre: String(i.nombre || "Alimento").slice(0, 60),
    gramos: n(i.gramos, 0, 2000) ?? 0,
    carbs_100g: n(i.carbs_100g, 0, 100) ?? 0,
    proteina_100g: n(i.proteina_100g, 0, 100) ?? 0,
    grasa_100g: n(i.grasa_100g, 0, 100) ?? 0,
    fibra_100g: n(i.fibra_100g, 0, 100) ?? 0,
    absorcion: ["rapida", "mixta", "lenta"].includes(i.absorcion) ? i.absorcion : "mixta",
    confianza: ["alta", "media", "baja"].includes(i.confianza) ? i.confianza : "media",
  }));

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
  const { type, image, mediaType, text, grams } = body || {};
  if (!["food", "lookup"].includes(type)) return reply(400, { error: "Tipo no válido" });

  try {
    if (type === "lookup") {
      const name = String(text || "").trim().slice(0, 120);
      if (!name) return reply(400, { error: "Escribe un alimento" });
      const g = n(grams, 1, 3000);
      const parsed = await askGemini({
        system: LOOKUP_SYSTEM,
        text: `Alimento o plato: "${name}".` + (g ? ` Ración total indicada: ${g} g.` : " No se ha indicado ración."),
      });
      return reply(200, { items: cleanItems(parsed, 6), notas: String(parsed.notas || "").slice(0, 300) });
    }

    if (typeof image !== "string" || !MEDIA_TYPES.includes(mediaType)) return reply(400, { error: "Imagen no válida" });
    if (image.length > 5_500_000) return reply(413, { error: "La imagen es demasiado grande" });
    const parsed = await askGemini({
      system: FOOD_SYSTEM,
      parts: [
        { inline_data: { mime_type: mediaType, data: image } },
        { text: "Analiza este plato y devuelve el JSON." },
      ],
    });
    return reply(200, { items: cleanItems(parsed, 12), notas: String(parsed.notas || "").slice(0, 300) });
  } catch (err) {
    console.error(err);
    return reply(err.status || 500, { error: err.message || "No se pudo analizar" });
  }
};

export const config = { path: "/api/analyze" };