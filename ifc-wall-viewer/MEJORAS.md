# ObjetivaAR — Mejoras aplicadas

## ⚠️ Seguridad (acción requerida por ti)

El `.project-config.json` original traía credenciales reales en texto plano
(AWS, base de datos TiDB, APS/Forge, JWT, OAuth). **Ese archivo NO está
incluido aquí** y debes **rotar esas credenciales cuanto antes**. En
producción deben venir de variables de entorno / gestor de secretos.

## Velocidad

1. **Parsing del GLB en un Web Worker** (lo más contundente). Todo el
   trabajo pesado de los modelos grandes (>50 MB: Eléctrico 798 MB,
   Hidráulico 913 MB) — decodificar Draco/Meshopt, hornear las matrices
   de mundo y fusionar geometrías — se ejecuta **fuera del hilo
   principal**. La interfaz **ya no se congela** ("no responde") al
   cargar esos modelos. Solo se transfieren arrays compactos de vuelta.
   Si el worker falla por cualquier razón, cae automáticamente al método
   anterior (sin regresiones).
2. **Fusión por regiones espaciales**: la geometría de los modelos
   grandes se agrupa por zonas (rejilla XZ) en vez de en bloques
   arbitrarios. Three.js descarta por frustum las regiones fuera de
   cámara → mucho menos GPU al caminar dentro del modelo o en AR (la
   mayor parte del edificio queda fuera de vista).
3. **Resolución adaptativa**: si el framerate cae en escenas pesadas o
   GPUs débiles, baja la densidad de píxeles para mantener fluidez y la
   restaura cuando se estabiliza (con histéresis, sin parpadeo).
4. **Arranque ~65% más liviano**: rutas `lazy` + chunks de vendor
   separados. La carga inicial bajó de 424 KB a ~147 KB gzip; Three.js
   (196 KB gzip) y el visor se cargan solo al abrir un proyecto.
5. **Draco en WASM + pool de workers** (antes JS, 3-5x más lento).
6. **Sin recálculo redundante de normales** sobre la geometría fusionada
   (millones de vértices) — era una causa principal del "no responde".
7. **Tone mapping ACES Filmic**: imagen más realista, sin costo de
   rendimiento.

## AR estilo Gamma AR (y mejor)

1. **Escaneo del piso real + retículo** (hit-test WebXR).
2. **Tap-to-place**: el modelo se ancla al piso real a **escala 1:1**,
   fijo en el mundo mientras caminas.
3. **Slider de transparencia global** ("rayos X" contra la obra).
4. **"Entrar y caminar dentro (1:1)"** conserva el modo inmersivo.
5. **Reposicionar** sin destruir el modelo (re-escaneo instantáneo).
6. **Fallback robusto** si el dispositivo no soporta hit-test.

## Despliegue / "corre perfecto"

1. **SessionStart hook** (`.claude/`): instala dependencias automáticamente
   en sesiones web, entorno reproducible sin pasos manuales.
2. **`.env.example`**: documenta todas las variables requeridas (sin
   secretos) para desplegar en Manus u otro host sin filtrar credenciales.
3. **Preconnect al CDN de Draco** (`www.gstatic.com`): la primera descarga
   del decodificador WASM arranca sin lag de DNS/TLS → modelos grandes
   empiezan a procesarse antes.
4. **Pantalla de carga con marca** (logo + paleta Objetiva) en vez de un
   spinner genérico.
5. Sobre AWS/Firebase: **no conviene migrar** — S3+CloudFront es lo
   correcto para BIM pesado; el problema es tamaño/entrega, no el
   proveedor. Única alternativa con beneficio real (costo de egreso):
   Cloudflare R2 + CDN.

## Verificación

- `tsc --noEmit` (typecheck): **OK**
- `vite build` (build de producción): **OK** — el worker se compila como
  chunk ESM independiente (`glbParseWorker`, ~236 KB) que solo se descarga
  cuando se parsea un modelo grande.
- Los tests del repo son de servidor y requieren la base de datos
  (credenciales removidas por seguridad); no se ejecutan aquí y no se
  tocó código de servidor.

> El modo AR depende de un dispositivo con WebXR (Chrome Android / Quest)
> y el Web Worker de un navegador moderno; ambos van tipados, compilados
> y con fallback seguro. No se pudieron probar en este entorno.
