// Utilidades compartidas por las funciones de Netlify.
// Variables de entorno: APP_PASSWORD, GEMINI_API_KEY (obligatorias); GEMINI_MODEL, ALLOWED_ORIGIN (opcionales).
import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

// ---------- Respuestas y CORS ----------
function corsHeaders() {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Content-Type, x-app-key";
    h["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  return h;
}

export const reply = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders() });

// Responde a las peticiones OPTIONS; si no es OPTIONS devuelve null.
export const preflight = (req) =>
  req.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders() }) : null;

// ---------- Acceso con clave ----------
// Devuelve una respuesta de error si la clave no es correcta; si lo es, devuelve null.
export function checkAuth(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return reply(500, { error: "Falta APP_PASSWORD en Netlify" });
  const given = req.headers.get("x-app-key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? null : reply(401, { error: "Clave incorrecta" });
}

// ---------- Base de datos (Netlify Blobs) ----------
export const store = () => getStore({ name: "glucoplan", consistency: "strong" });

// Clave de mes en formato AAAA-MM (UTC).
export const monthKey = (ts) => {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Registros de los últimos N meses, del más reciente al más antiguo.
export async function loadEntries(months = 2) {
  const s = store();
  const now = new Date();
  const keys = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`entries/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const lists = await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)));
  return lists
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .sort((a, b) => b.ts - a.ts);
}

// ---------- Gemini ----------
// Modelos que funcionan con tu clave, en orden: primero el más rápido
// (Netlify corta las funciones a los ~10 s). Si falla uno, se prueba el siguiente.
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash"];
const NEXT_MODEL_ON = new Set([404, 429, 500, 502, 503, 504]); // no existe o está saturado
const DEADLINE_MS = 8500; // devolvemos un error limpio antes de que Netlify corte

// askGemini({ system, parts })  o  askGemini({ system, text })  ->  objeto JSON
export async function askGemini({ system, parts, text }) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw Object.assign(new Error("Falta GEMINI_API_KEY en Netlify"), { status: 500 });

  const userParts = parts || [{ text: String(text ?? "") }];

  // GEMINI_MODEL solo se usa si parece un nombre de modelo y no es de la serie 2.5 (retirada).
  const envModel = (process.env.GEMINI_MODEL || "").trim();
  const valid = /^gemini-[a-z0-9.\-]{2,60}$/i.test(envModel) && !envModel.startsWith("gemini-2.5");
  const models = [...new Set([valid ? envModel : "", ...FALLBACK_MODELS].filter(Boolean))];

  const buildBody = (model) => {
    const generationConfig = { responseMimeType: "application/json", maxOutputTokens: 2048 };
    // Flash-Lite ya piensa lo mínimo por defecto y no admite temperature personalizada.
    if (!/flash-lite/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
    return JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: userParts }],
      generationConfig,
    });
  };

  const deadline = Date.now() + DEADLINE_MS;
  let lastStatus = 0;
  let lastMsg = "";

  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 1500) break;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: buildBody(model),
          signal: AbortSignal.timeout(left),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          lastStatus = 502;
          lastMsg = "La respuesta no se entendió bien";
          continue; // probar el siguiente modelo
        }
      }

      const detail = await res.text().catch(() => "");
      console.error("Gemini error", model, res.status, detail.slice(0, 500));
      lastStatus = res.status;
      try { lastMsg = JSON.parse(detail)?.error?.message || ""; } catch { lastMsg = ""; }
      if (!NEXT_MODEL_ON.has(res.status)) {
        throw Object.assign(
          new Error(`Gemini devolvió un error (${res.status}) con ${model}: ${lastMsg}`.slice(0, 300)),
          { status: 502 }
        );
      }
    } catch (err) {
      if (err.status) throw err;
      console.error("Gemini timeout/red", model, err?.name, err?.message);
      lastStatus = lastStatus || 504;
    }
  }

  throw Object.assign(
    new Error(
      lastStatus === 429
        ? "Se ha alcanzado el límite gratuito de Gemini. Espera un minuto e inténtalo de nuevo"
        : `Gemini no responde ahora mismo (${lastStatus || 503}). Prueba otra vez en un minuto`
    ),
    { status: 503 }
  );
}