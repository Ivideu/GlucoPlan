# GlucoPlan

Web personal para el día a día con diabetes tipo 1: foto del plato con cálculo de dosis de Fiasp, registro de glucosa con gráficas, coach de datos, tabla de gimnasio (3 días a las 6:00), menú de 3 comidas y lista de la compra.

Todo funciona con servicios gratuitos: GitHub, Netlify (plan Free, con Netlify Blobs como base de datos) y la API gratuita de Gemini de Google AI Studio.

## Estructura

```
glucoplan/
├── index.html                      Toda la web (HTML, CSS y JS)
├── package.json                    Dependencia de Netlify Blobs
├── netlify.toml                    Configuración de Netlify
├── .gitignore
└── netlify/
    ├── lib/shared.mjs              Clave de acceso, llamada a Gemini y acceso a la base de datos
    └── functions/
        ├── analyze.mjs             Lee la foto del plato y las capturas de gráficas de glucosa
        ├── data.mjs                Guarda y lee el historial y los ajustes (Netlify Blobs)
        └── coach.mjs               Calcula estadísticas de 28 días y propone patrones y preguntas
```

## Puesta en marcha paso a paso

1. **Sube el código a GitHub.** Crea un repositorio y sube todos estos archivos respetando las carpetas (incluidos `package.json` y `netlify.toml`).
2. **Consigue la clave gratuita de Gemini.** Entra en https://aistudio.google.com/apikey con tu cuenta de Google, pulsa "Crear clave de API" y cópiala. No hace falta tarjeta.
3. **Crea el sitio en Netlify.** En https://app.netlify.com: Add new site > Import an existing project > GitHub > elige el repositorio. Deja el comando de build vacío y despliega.
4. **Añade las variables de entorno.** En Netlify: Site configuration > Environment variables:
   - `GEMINI_API_KEY`: la clave del paso 2.
   - `APP_PASSWORD`: una clave larga que inventes tú. Protege tu historial y evita que otros gasten tu cuota de IA.
   - Opcional: `GEMINI_MODEL` (por defecto `gemini-3.5-flash`). Si la IA tarda demasiado y Netlify corta la petición, prueba con `gemini-3.1-flash-lite`.
   - Opcional: `ALLOWED_ORIGIN` si alojas la web en GitHub Pages (por ejemplo `https://tuusuario.github.io`).
5. **Vuelve a desplegar.** Deploys > Trigger deploy > Deploy site, para que las variables se apliquen. No necesitas activar Blobs: se activa solo con la primera escritura.
6. **Abre tu web y entra** con la clave `APP_PASSWORD`.
7. **Rellena Ajustes.** Pon tu ratio insulina/hidratos, tu glucemia objetivo y el factor de sensibilidad (viene puesto en 30). Se sincronizan entre dispositivos.
8. **Instala la web en el móvil.** Abre la URL de Netlify y usa "Añadir a pantalla de inicio".

## Rutina diaria

- **Antes de comer:** foto del plato, revisa los gramos, mira la dosis y pulsa "Guardar esta comida".
- **Dos horas después:** pestaña Glucosa y anota la lectura con el momento "2 horas después de comer". Es el dato que más enseña al coach.
- **Días de gimnasio o de más hidratos:** márcalo en Glucosa para que las lecturas y comidas del día lo lleven.
- **Una vez por semana:** sube una captura de la gráfica de tu app del sensor, confirma los datos y guarda.
- **Cada 2 o 3 semanas:** pestaña Coach > "Analizar mis datos". Lleva las sugerencias y preguntas a tu endocrino.

## Qué hace y qué no hace el coach

Analiza tus últimos 28 días: compara días con y sin gimnasio, días con más hidratos, la subida media tras comer y las lecturas por debajo de 70. Con eso detecta patrones y prepara preguntas.

No cambia tus ajustes, no da dosis y no toca la insulina basal. Cualquier ajuste del ratio o del factor de sensibilidad debe pasar por tu endocrino. Con pocos datos, el coach lo dirá en lugar de inventar patrones.

## Límites del plan gratuito

- **Gemini gratuito:** unas 15 peticiones por minuto y unas 1.500 al día, más que de sobra para uso personal. Los límites exactos los ves en https://aistudio.google.com/rate-limit.
- **Privacidad:** en el plan gratuito, Google puede usar lo que envías para mejorar sus productos y personas revisoras pueden leerlo. Recorta tu nombre y otros datos personales de las capturas de gráficas. Si no quieres compartir gráficas, anota las lecturas a mano: el coach funciona igual.
- **Netlify Free:** 300 créditos al mes, límite fijo. Cada despliegue de producción gasta créditos, así que evita hacer decenas de despliegues al mes. Si se agotan, el sitio se pausa hasta el mes siguiente, sin cargos.
- **Modelos de Gemini:** Google retira modelos antiguos con el tiempo. Si un día falla la IA, cambia `GEMINI_MODEL` por el modelo Flash vigente en https://ai.google.dev/gemini-api/docs/models.

## Datos y seguridad

- El historial y los ajustes se guardan en Netlify Blobs de tu cuenta, protegidos por `APP_PASSWORD`.
- Progreso del gimnasio, lista de la compra y registro de Toujeo se guardan solo en cada dispositivo.
- Las fotos se envían a tu función de Netlify y de ahí a Gemini para analizarlas. No se guardan.

## Aviso

GlucoPlan es una herramienta de apoyo. No sustituye la pauta de tu endocrino ni tu criterio: revisa siempre los gramos y la glucemia antes de pincharte.
