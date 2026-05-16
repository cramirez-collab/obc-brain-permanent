# ObjetivaAR — Mejoras aplicadas

## ⚠️ Seguridad (acción requerida por ti)

El `.project-config.json` original traía credenciales reales en texto plano
(AWS, base de datos TiDB, APS/Forge, JWT, OAuth). **Ese archivo NO está
incluido aquí** y debes **rotar esas credenciales cuanto antes**:

- Llaves AWS (access key / secret / session token)
- Contraseña de la base de datos TiDB
- APS_CLIENT_SECRET (Autodesk Forge)
- JWT_SECRET

En producción, esas variables deben venir de variables de entorno / un gestor
de secretos, nunca de un archivo versionado.

## Velocidad

1. **Arranque ~65% más liviano.** El bundle pasó de un único JS de
   424 KB gzip a una carga inicial de ~147 KB gzip. Three.js (196 KB gzip)
   y el visor 3D ahora se cargan **solo al abrir un proyecto** (rutas
   `lazy` + chunks de vendor separados y cacheables).
2. **Decodificación Draco en WASM + pool de workers** (antes usaba el
   decodificador JS, 3-5x más lento). Esto ataca directamente el
   congelamiento al cargar los modelos de 800–900 MB.
3. **Se eliminó el recálculo redundante de normales** sobre la geometría
   fusionada (millones de vértices) — era la causa principal del
   "no responde" con Eléctrico/Hidráulico. Las normales del GLB original
   ya son válidas tras el merge.
4. **Tone mapping ACES Filmic** para una imagen más realista y con mejor
   contraste, sin costo de rendimiento.

## AR estilo Gamma AR (y mejor)

El modo AR antes solo te metía "dentro" del modelo con un offset fijo.
Ahora:

1. **Escaneo del piso real + retículo** (hit-test WebXR): aparece un anillo
   sobre el suelo detectado.
2. **Tap-to-place**: tocas la pantalla (o "Colocar aquí") y el modelo se
   ancla al piso real a **escala 1:1**, fijo en el mundo mientras caminas.
3. **Slider de transparencia global** ("rayos X" contra la obra real) —
   herramienta clave de campo.
4. **"Entrar y caminar dentro (1:1)"**: conserva el modo inmersivo como
   opción, ahora desde el modelo ya colocado.
5. **Reposicionar** sin destruir el modelo (re-escaneo instantáneo).
6. **Fallback robusto**: si el dispositivo no soporta hit-test, entra
   directo al modo inmersivo (no se rompe nada).

## Verificación

- `tsc --noEmit` (typecheck): **OK**
- `vite build` (build de producción): **OK**
- Los tests del repo son de servidor y requieren la base de datos
  (credenciales removidas por seguridad); no se ejecutan aquí y no se
  tocó código de servidor.

> Nota: el modo AR depende de un dispositivo con WebXR (Chrome Android /
> navegador Quest) y no pudo probarse en este entorno; el código está
> tipado, compilado y con fallback seguro.
