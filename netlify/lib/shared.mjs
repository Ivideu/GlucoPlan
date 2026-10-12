// Utilidades compartidas por las funciones de Netlify.
import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const STORE_NAME = "glucoplan";

export function cors() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, x-app-key",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

export function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors() },
  });
}

export function preflight(req) {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: cors() }) : null;
}

// Protege toda la API con la clave APP_PASSWORD (enviada en la cabecera x-app-key).
export function checkAuth(req) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return reply(500, { error: "Falta la variable APP_PASSWORD en Netlify" });
  const got = Buffer.from(req.headers.get("x-app-key") || "");
  const want = Buffer.from(pass);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return reply(401, { error: "Clave incorrecta" });
  }
  return null;
}

// Llamada a Gemini (plan gratuito de Google AI Studio). Devuelve el JSON ya interpretado.
export async function askGemini({ system, parts, maxTokens = 4096 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Object.assign(new Error("Falta GEMINI_API_KEY en Netlify"), { status: 500 });
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
    }),
  });

  if (res.status === 429) {
    throw Object.assign(new Error("Has alcanzado el límite gratuito de Gemini. Espera un minuto e inténtalo de nuevo."), { status: 429 });
  }
  if (!res.ok) {
    console.error("Gemini error", res.status, await res.text());
    throw Object.assign(new Error("Gemini no respondió (" + res.status + ")"), { status: 502 });
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    throw Object.assign(new Error("No se pudo interpretar la respuesta de la IA"), { status: 502 });
  }
}

export const store = () => getStore(STORE_NAME);

export const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);

export function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

// Los registros se guardan en un documento JSON por mes: entries/2026-10
export async function loadEntries(months = 2) {
  const s = store();
  const docs = await Promise.all(lastMonths(months).map((m) => s.get(`entries/${m}`, { type: "json" })));
  return docs.flat().filter(Boolean).sort((a, b) => b.ts - a.ts);
}
