# GlucoPlan

Web personal para el día a día con diabetes tipo 1: foto del plato con cálculo de dosis de Fiasp, registro de glucosa con gráficas, registro de Toujeo con hora, día de gym sí/no y coach de datos. Todo se sincroniza entre móvil y ordenador.

Funciona con servicios gratuitos: GitHub, Netlify (plan Free, con Netlify Blobs como base de datos) y la API gratuita de Gemini de Google AI Studio.

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
        ├── data.mjs                Guarda y lee historial, Toujeo y ajustes (Netlify Blobs)
        └── coach.mjs               Estadísticas de 28 días, patrones y preguntas para el endocrino
```

Solo cambian `index.html`, `netlify/functions/data.mjs` y `netlify/functions/coach.mjs`. Sustituye esos tres archivos en GitHub y Netlify redesplegará solo.

## Pestañas

- **Hoy:** última glucosa en un anillo, anotar lectura, gráfica de 24 h, Toujeo con hora y botón de gym.
- **Comida:** foto del plato, alimentos y dosis de Fiasp.
- **Glucosa:** gráfica de 24 h, 7 o 28 días, subida de capturas del sensor y registro.
- **Coach:** análisis de 28 días.
- **Ajustes:** ratio, factor de sensibilidad, objetivo, ajuste de gym y Toujeo habitual.

## Toujeo

Pulsa "Registrar Toujeo", indica las unidades y la hora real (hay atajos "Ahora", "Hace 1 h", "Ayer a esta hora"). Se guarda en la base de datos con su hora y se ve en todos tus dispositivos. La tarjeta muestra cuánto hace que te la pusiste y cuándo toca la siguiente.

## Gym

El botón "Hoy he ido al gym" marca el día. Con él activo:

- La dosis de comida no se reduce por defecto, porque la musculación suele subirte la glucosa. En Ajustes puedes poner un ajuste fijo (positivo o negativo) si tu endocrino te lo indica; se aplica solo los días de gym.
- Aparece un aviso para medir a las 2 h y de nuevo 3 a 6 h después por posibles bajadas tardías.
- El coach sabe que en la mayoría de tus sesiones la glucosa sube, y compara tus lecturas "antes del gym" y "después del gym".

## Sincronización entre dispositivos

Entra en cada dispositivo con la misma clave `APP_PASSWORD`. Historial, lecturas, comidas, gym, Toujeo y ajustes se leen de la misma base de datos. La web se actualiza sola cada 2 minutos y al volver a abrirla.

## Puesta en marcha

1. Sube el código a GitHub respetando las carpetas.
2. Consigue la clave gratuita de Gemini en https://aistudio.google.com/apikey.
3. Crea el sitio en Netlify (Add new site > Import an existing project > GitHub). Deja el comando de build vacío.
4. Variables de entorno: `GEMINI_API_KEY`, `APP_PASSWORD` y, opcional, `GEMINI_MODEL`.
5. Vuelve a desplegar y entra con tu clave.
6. Rellena Ajustes y usa "Añadir a pantalla de inicio" en el móvil.

## Rutina diaria

- **Mañana:** marca gym si has ido, mide antes y después, y registra la Toujeo con su hora.
- **Antes de comer:** foto del plato, revisa los gramos y guarda la comida.
- **Dos horas después:** anota la glucosa con "2 horas después de comer".
- **Cada 2 o 3 semanas:** Coach > "Analizar mis datos" y lleva las preguntas a tu endocrino.

## Qué hace y qué no hace el coach

No cambia ajustes, no da dosis y no toca la insulina basal. Cualquier cambio de ratio o factor debe pasar por tu endocrino.

## Aviso

GlucoPlan es una herramienta de apoyo. No sustituye la pauta de tu endocrino: revisa siempre los gramos y la glucemia antes de pincharte.
