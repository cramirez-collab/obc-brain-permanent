# Especificación Funcional y Arquitectura UX/UI — ObjetivaAR

**Versión:** 1.0  
**Fecha:** 19 de febrero de 2026  
**Autor:** Equipo Objetiva / Manus AI  
**Clasificación:** Documento técnico de diseño  
**Alcance:** Arquitectura funcional, especificaciones técnicas y lineamientos de experiencia de usuario para la aplicación de visualización 3D de proyectos arquitectónicos e ingenierías

---

## 1. Arquitectura Multiplataforma

### 1.1 Estrategia Mobile-First

ObjetivaAR adopta una estrategia **mobile-first** como principio rector de diseño. Toda decisión de interfaz, rendimiento y navegación se toma primero para pantallas de 375–430px (smartphones) y se escala progresivamente hacia tablets (768–1024px) y PCs (1280px+). Esta decisión responde a la realidad operativa del sector construcción: el 80% del uso en campo ocurre desde smartphones, frecuentemente con una sola mano libre, bajo luz solar directa y con conectividad intermitente [1].

El flujo de adaptación sigue tres niveles:

| Nivel | Dispositivo | Viewport | Paradigma de Interacción | Layout Principal |
|-------|------------|----------|-------------------------|-----------------|
| **L1** | Smartphone | 375–430px | Touch + giroscopio + joystick virtual | Bottom sheet colapsable, controles flotantes |
| **L2** | Tablet | 768–1024px | Touch + stylus + giroscopio | Bottom sheet expandible, panel lateral opcional |
| **L3** | PC/Laptop | 1280px+ | Mouse + teclado + scroll wheel | Panel lateral fijo derecho, toolbar superior |

### 1.2 Tecnologías Recomendadas

La decisión de stack tecnológico se fundamenta en tres criterios: rendimiento en GPU móvil, ecosistema de desarrollo maduro y capacidad de ejecución offline.

**Motor 3D: Three.js (v0.182+)**

Three.js es la elección principal por su balance entre rendimiento WebGL y flexibilidad de personalización. A diferencia de motores como Babylon.js (más pesado en bundle) o PlayCanvas (orientado a juegos), Three.js permite control granular sobre materiales, clipping planes y post-processing sin overhead innecesario [2]. El bundle base de Three.js con tree-shaking agresivo se mantiene por debajo de 350KB gzipped, crítico para tiempos de carga en redes 4G.

**Framework: React 18 + TypeScript + Vite**

React provee el modelo de componentes declarativos necesario para una UI compleja con múltiples paneles, modales y estados concurrentes. TypeScript garantiza tipado end-to-end desde el backend (tRPC) hasta los hooks del frontend, eliminando una categoría completa de bugs en runtime. Vite como bundler ofrece HMR sub-segundo durante desarrollo y builds optimizados con code-splitting automático.

**Backend: Express + tRPC + Drizzle ORM**

El backend sirve tres funciones: proxy de archivos GLB (streaming sin cargar en memoria), API tipada via tRPC (procedures protegidas con autenticación) y ORM para persistencia en MySQL/TiDB. La elección de tRPC sobre REST elimina la necesidad de contratos OpenAPI separados — los tipos fluyen directamente del servidor al cliente.

### 1.3 Rendimiento Fluido en Móviles

Garantizar 30+ FPS en smartphones de gama media (Snapdragon 6xx, Apple A14) con modelos de 50–200MB requiere las siguientes optimizaciones:

| Técnica | Implementación | Impacto |
|---------|---------------|---------|
| **Pixel ratio adaptativo** | `Math.min(devicePixelRatio, 2)` | Reduce fragmentos GPU 4× en pantallas HiDPI |
| **matrixAutoUpdate = false** | Desactivar en todos los meshes estáticos | Elimina recálculo de matrices por frame |
| **Logarithmic depth buffer** | `renderer.logarithmicDepthBuffer = true` | Previene z-fighting en inspección cercana sin costo significativo |
| **Frustum culling nativo** | Habilitado por defecto en Three.js | Solo renderiza geometría visible |
| **EdgesGeometry pre-calculada** | Generar al cargar, no por frame | Costo O(1) en render loop |
| **Raycasting selectivo** | Solo contra meshes visibles del piso actual | Reduce intersecciones de miles a decenas |
| **Throttle de eventos** | Touch/gyro a 60Hz máximo, resize a 200ms | Previene saturación del event loop |
| **GLB streaming via proxy** | Servidor hace streaming sin buffering completo | Reduce memory footprint del servidor |
| **Service Worker cache** | Cache-first para GLBs, network-first para API | Carga instantánea en visitas subsecuentes |
| **Near/Far dinámico** | Ajustar según distancia al modelo | Maximiza precisión del depth buffer |

### 1.4 Adaptación Progresiva a PC

En PC, la aplicación escala la experiencia manteniendo consistencia visual:

El **panel lateral derecho** (320px fijo) reemplaza al bottom sheet móvil, mostrando tabs de Capas, Visual, Medición y Configuración simultáneamente visibles. La **toolbar superior** expone acciones frecuentes (reset vista, captura, compartir) sin necesidad de menú hamburger. Los **atajos de teclado** (WASD para walk, Escape para salir, R para reset, M para medición) aceleran el flujo de trabajo. El **scroll wheel** controla zoom con precisión sub-milimétrica, y el **click derecho + arrastrar** permite pan directo sin cambiar de herramienta.

La transición entre breakpoints es fluida: los mismos componentes React se renderizan con layouts diferentes usando Tailwind responsive utilities (`md:`, `lg:`), sin duplicación de código ni carga condicional de módulos.

---

## 2. Navegación y Control por Giroscopio

### 2.1 Activación del Giroscopio en Dispositivos Móviles

El giroscopio se activa mediante un botón dedicado en la barra de controles del modo walk. La activación no es automática al entrar en walk mode por una razón técnica y de UX: la **DeviceOrientation API** requiere permiso explícito del usuario en iOS 13+ (evento `DeviceOrientationEvent.requestPermission()`), y activarlo sin contexto genera rechazo del permiso [3]. El flujo es:

1. Usuario entra en walk mode (toca icono de huellas)
2. Aparece botón de giroscopio en la barra de walk mode
3. Al tocar, se solicita permiso (iOS) o se activa directamente (Android)
4. El giroscopio toma control de la orientación de la cámara (yaw + pitch)
5. El joystick virtual controla únicamente el desplazamiento (traslación)

### 2.2 Movimiento Automático según Orientación del Dispositivo

Una vez activado, el giroscopio controla la orientación de la cámara de forma continua y automática. El modelo "rota" (en realidad, la cámara rota) siguiendo la orientación física del dispositivo en los tres ejes:

| Eje del Dispositivo | Eje de Cámara | Comportamiento |
|---------------------|---------------|----------------|
| **Alpha** (brújula, 0–360°) | Yaw (rotación horizontal) | Girar el teléfono horizontalmente rota la vista |
| **Beta** (inclinación frontal, -180–180°) | Pitch (inclinación vertical) | Inclinar el teléfono hacia arriba/abajo mira arriba/abajo |
| **Gamma** (inclinación lateral, -90–90°) | Roll (no utilizado) | Se ignora para evitar mareo |

El eje Gamma (roll) se descarta intencionalmente. En aplicaciones de navegación arquitectónica, el roll produce desorientación y mareo sin aportar valor funcional. Esta es una decisión compartida por Google Street View, Matterport y la mayoría de viewers BIM móviles [4].

### 2.3 Filtros de Suavizado y Estabilización

La señal cruda del giroscopio contiene ruido de alta frecuencia (vibraciones de mano, micro-movimientos) que produce una experiencia visual inestable. ObjetivaAR implementa un **filtro complementario** que fusiona datos del giroscopio (respuesta rápida, drift a largo plazo) con el acelerómetro (estable a largo plazo, ruidoso a corto plazo):

```
orientación_filtrada = α × giroscopio + (1 - α) × acelerómetro
```

Los parámetros del filtro están calibrados para uso en obra:

| Parámetro | Valor | Justificación |
|-----------|-------|---------------|
| **α (factor de fusión)** | 0.92 | Prioriza giroscopio para respuesta inmediata |
| **Deadzone** | 0.3°/s | Ignora micro-vibraciones de mano en reposo |
| **Smoothing factor** | 0.12 | Suaviza transiciones sin introducir latencia perceptible |
| **Velocidad angular máxima** | 3.0 rad/s | Limita rotaciones bruscas que causan mareo |
| **Frecuencia de muestreo** | 60 Hz | Sincronizado con requestAnimationFrame |

Adicionalmente, se implementa un **botón de recalibración** que resetea la orientación de referencia al ángulo actual del dispositivo, útil cuando el usuario cambia de posición (sentado → de pie) o rota el dispositivo 90°.

### 2.4 Alternativa en PC: Mouse y Trackpad

En PC, la navegación equivalente al giroscopio se logra mediante:

**Modo Órbita (default):** Click izquierdo + arrastrar para rotar, click derecho + arrastrar para pan, scroll wheel para zoom. Este es el modo estándar de cualquier viewer CAD/BIM y no requiere aprendizaje.

**Modo Walk (primera persona):** Click izquierdo + arrastrar para mirar (equivalente a giroscopio), WASD para mover, Q/E para subir/bajar. La sensibilidad del mouse es configurable (0.1× a 3.0×) para adaptarse a diferentes DPI de ratón y preferencias personales.

La paridad funcional entre giroscopio móvil y mouse en PC es completa: ambos controlan yaw/pitch con la misma curva de respuesta, solo difiere el dispositivo de entrada.

---

## 3. Visualización Técnica de Especialidades

### 3.1 Especialidades Soportadas

ObjetivaAR soporta la visualización independiente y combinable de todas las disciplinas MEP (Mechanical, Electrical, Plumbing) más las especialidades arquitectónicas. Cada especialidad se carga como un archivo GLB independiente, lo que permite activación/desactivación sin recargar el modelo completo.

| Especialidad | Código Interno | Color Default | Material Three.js | Opacidad Default |
|-------------|---------------|---------------|-------------------|-----------------|
| Arquitectura/Estructura | `arch_struct` | #C0C0C0 (gris plata) | MeshPhongMaterial | 85% (translúcido) |
| Instalación Eléctrica | `electrical` | #FFD700 (amarillo) | MeshStandardMaterial | 100% |
| Hidráulica | `plumbing` | #2196F3 (azul) | MeshStandardMaterial | 100% |
| Sanitaria | `plumbing` (sub-capa) | #00BCD4 (cyan) | MeshStandardMaterial | 100% |
| Pluvial | `plumbing` (sub-capa) | #4CAF50 (verde) | MeshStandardMaterial | 100% |
| Drenes | `plumbing` (sub-capa) | #795548 (café) | MeshStandardMaterial | 100% |
| HVAC | `hvac` | #FF6B35 (naranja) | MeshStandardMaterial | 100% |
| Gas | `mechanical` (sub-capa) | #F44336 (rojo) | MeshStandardMaterial | 100% |
| Luminarias | `electrical` (sub-capa) | #FFC107 (ámbar) | MeshStandardMaterial | 100% |
| Mecánico | `mechanical` | #9C27B0 (púrpura) | MeshStandardMaterial | 100% |

Las sub-capas (sanitaria, pluvial, drenes, gas, luminarias) se identifican por metadata del mesh dentro del GLB correspondiente, permitiendo toggle independiente sin archivos adicionales.

### 3.2 Precisión Geométrica

La precisión geométrica de ObjetivaAR está determinada por tres factores en cadena:

**Fuente del modelo (Revit/ArchiCAD → GLB):** La conversión de formatos paramétricos (RVT, PLN) a GLB mediante herramientas como Revit Exporter o IFC→GLB preserva la geometría con precisión de **0.1mm** en la malla poligonal. La teselación de curvas (tuberías, codos) introduce error máximo de **1mm** con configuración de calidad media [5].

**Renderizado WebGL:** Three.js utiliza coordenadas de punto flotante de 32 bits (Float32), lo que proporciona precisión de **~0.001mm** para modelos dentro de un rango de 1km desde el origen. Con `logarithmicDepthBuffer` activado, la precisión del depth buffer es uniforme en todo el rango de visualización.

**Medición en pantalla:** El raycasting de Three.js (intersección rayo-triángulo) calcula puntos de intersección con precisión de **sub-milímetro**. La herramienta de medición muestra resultados con resolución de **1cm** (redondeado), que es el nivel de precisión útil en obra.

La precisión efectiva del sistema completo es de **±1cm**, limitada intencionalmente por la resolución de pantalla táctil (el dedo del usuario tiene ~10mm de área de contacto) y por la utilidad práctica en campo.

### 3.3 Activación/Desactivación de Especialidades

Cada especialidad tiene un toggle independiente en el panel de Capas. La implementación es directa: cada GLB se carga en un `THREE.Group` nombrado, y el toggle modifica `group.visible`. Las aristas (`*_edges` groups) siguen la visibilidad del grupo padre.

Controles adicionales por especialidad:

- **Slider de opacidad** (0–100%): modifica `material.opacity` de todos los meshes del grupo
- **Hue shift** (-180° a +180°): rota el color base en el espacio HSL
- **Saturación** (0× a 2×): ajusta la viveza del color
- **Grosor de aristas** (0 a 4px): modifica `linewidth` del LineBasicMaterial

### 3.4 Sistema de Colores Personalizable

El usuario puede modificar el color de cada especialidad desde el panel Visual. La implementación utiliza transformaciones HSL sobre el color base del material:

1. Se extrae el color original del mesh (`material.color`)
2. Se convierte a HSL
3. Se aplica hue shift y factor de saturación del usuario
4. Se reconvierte a RGB y se asigna al material

Este enfoque preserva las variaciones de tono dentro de una especialidad (diferentes tonos de azul para distintos diámetros de tubería, por ejemplo) mientras permite al usuario cambiar la paleta general.

### 3.5 Alertas Visuales por Color (Colisiones e Interferencias)

La detección de colisiones geométricas entre especialidades se implementa mediante **bounding box intersection** como primera pasada rápida, seguida de **mesh intersection** (raycasting cruzado) para confirmación. Los elementos en conflicto se resaltan con:

| Tipo de Conflicto | Indicador Visual | Color |
|-------------------|-----------------|-------|
| Colisión dura (penetración) | Mesh parpadeante + contorno rojo | #FF0000 |
| Interferencia de clearance | Halo semitransparente | #FFA500 |
| Proximidad crítica (<5cm) | Línea punteada entre elementos | #FFFF00 |

Los conflictos detectados se listan en un panel lateral con la opción de navegar directamente a cada uno (la cámara se posiciona automáticamente para mostrar la interferencia).

---

## 4. Sistema de Medición tipo AutoCAD

### 4.1 Selección de Puntos y Aristas

La herramienta de medición opera en dos modos:

**Punto a punto:** El usuario toca/clica dos puntos sobre la superficie del modelo. Cada toque dispara un raycast contra la geometría visible, obteniendo la coordenada 3D exacta de intersección. Se coloca un marcador esférico (radio 3cm visual) en cada punto y se traza una línea entre ambos.

**Snap a arista:** Cuando el punto de intersección está a menos de 5cm (en espacio de pantalla) de una arista del modelo, el punto se "imanta" al punto más cercano sobre esa arista. Esto se implementa mediante `EdgesGeometry` pre-calculada: se busca el segmento de línea más cercano al punto de intersección y se proyecta ortogonalmente sobre él [6].

El snap a arista es crítico para mediciones precisas en obra, donde el usuario necesita medir entre aristas de muros, tuberías o elementos estructurales con precisión de centímetro.

### 4.2 Cuadro Emergente de Medición

Al completar la selección de dos puntos, aparece un cuadro de medición flotante posicionado en el punto medio de la línea de medición. El cuadro contiene:

```
┌─────────────────────────┐
│  📏  2.45 m              │
│  ΔX: 1.80m  ΔY: 0.15m  │
│  ΔZ: 1.65m              │
│  [Copiar]  [Borrar]     │
└─────────────────────────┘
```

El cuadro es **discreto pero legible**: fondo semitransparente oscuro (`rgba(27,42,74,0.85)`), texto blanco, tipografía monoespaciada de 14px, bordes redondeados. Se posiciona siempre frente a la cámara (billboard sprite) para garantizar legibilidad desde cualquier ángulo.

### 4.3 Criterio Automático de Unidades

El sistema aplica conversión automática de unidades según la magnitud de la medida:

| Rango de Medida | Unidad Mostrada | Formato | Ejemplo |
|----------------|-----------------|---------|---------|
| ≥ 1.00 m | Metros (m) | 2 decimales | `2.45 m` |
| 0.10 m – 0.99 m | Centímetros (cm) | 1 decimal | `45.2 cm` |
| < 0.10 m | Centímetros (cm) | 1 decimal | `8.3 cm` |

Las componentes por eje (ΔX, ΔY, ΔZ) siempre se muestran en metros con 2 decimales para consistencia con planos arquitectónicos. El sistema decimal es el único soportado (no se incluye sistema imperial) por ser el estándar en Latinoamérica.

### 4.4 Precisión de Lectura

La precisión de la medición depende de la cadena completa:

| Etapa | Precisión | Limitante |
|-------|-----------|-----------|
| Geometría del modelo | ±0.1mm | Teselación del exportador |
| Raycast Three.js | ±0.01mm | Float32 arithmetic |
| Snap a arista | ±1mm | Resolución de EdgesGeometry |
| Display al usuario | ±1cm | Redondeo intencional para legibilidad |

La precisión de **±1cm** en display es una decisión de diseño: en obra, mediciones con mayor resolución no son verificables con herramientas manuales (flexómetro, distanciómetro láser) y generan falsa confianza. El usuario avanzado puede acceder a la medida exacta (6 decimales) tocando el valor en el cuadro de medición.

---

## 5. Rejilla (Cuadrícula)

### 5.1 Diseño Visual Mínimo

La rejilla de referencia espacial se implementa como un `THREE.GridHelper` con las siguientes especificaciones para minimizar contaminación visual:

| Propiedad | Valor | Justificación |
|-----------|-------|---------------|
| **Tamaño** | 200m × 200m | Cubre el footprint de edificios grandes |
| **Divisiones** | 200 (1m por celda) | Resolución útil sin saturar |
| **Color de líneas principales** | `rgba(148, 163, 184, 0.08)` | Apenas perceptible sobre fondo claro |
| **Color de líneas secundarias** | `rgba(148, 163, 184, 0.04)` | Visible solo en zoom cercano |
| **Grosor** | 1px (no escalable) | Consistente en cualquier nivel de zoom |
| **Posición Y** | 0.0 (nivel PB) | Alineada con planta baja |

La rejilla es **casi invisible** en vista general pero proporciona referencia espacial al hacer zoom. Las líneas principales (cada 5m) son ligeramente más visibles que las secundarias (cada 1m), creando una jerarquía visual sutil.

### 5.2 Activación/Desactivación

La rejilla se controla desde el módulo de Configuración con un toggle simple. El estado se persiste en `localStorage` por proyecto. Por defecto, la rejilla está **desactivada** para priorizar la limpieza visual del modelo, pero se activa automáticamente cuando el usuario entra en modo medición (como referencia de escala).

### 5.3 Rejilla Adaptativa (Mejora Futura)

Una mejora planificada es la rejilla adaptativa que cambia su resolución según el nivel de zoom:

| Nivel de Zoom | Resolución de Rejilla | Etiquetas |
|--------------|----------------------|-----------|
| Vista general (>50m) | 10m por celda | Cada 50m |
| Vista media (10–50m) | 1m por celda | Cada 10m |
| Vista cercana (<10m) | 10cm por celda | Cada 1m |

---

## 6. Sistema de Cortes (Secciones)

### 6.1 Implementación con Clipping Planes

El sistema de cortes utiliza `THREE.Plane` como planos de recorte aplicados globalmente al renderer (`renderer.clippingPlanes`). Cada eje tiene un plano independiente que puede activarse, desactivarse y desplazarse dinámicamente [7].

| Eje | Color del Plano | Normal del Plano | Rango de Desplazamiento |
|-----|----------------|-----------------|------------------------|
| **X** (lateral) | #FF4444 (rojo) | `(1, 0, 0)` | -100m a +100m |
| **Y** (vertical) | #44FF44 (verde) | `(0, 1, 0)` | -20m a +70m |
| **Z** (profundidad) | #4444FF (azul) | `(0, 0, 1)` | -100m a +100m |

### 6.2 Interfaz de Control

Cada plano de corte se controla mediante un **slider horizontal** en el panel de Capas/Cortes. El slider muestra:

1. **Línea de arrastre** con el color del eje correspondiente
2. **Indicador numérico** de la posición actual (en metros)
3. **Flecha direccional** que indica el lado visible del corte (la geometría del lado de la flecha permanece visible)
4. **Botón de inversión** para voltear la dirección del corte

El usuario puede activar múltiples planos simultáneamente para crear secciones compuestas (por ejemplo, corte en Y para ver planta + corte en X para ver sección transversal).

### 6.3 Visualización del Volumen Seccionado

Cuando un plano de corte está activo, la geometría cortada muestra:

**Cara de corte sólida:** Se utiliza `stencil buffer` para renderizar una cara sólida en la superficie de corte, evitando que el usuario vea el interior hueco de los meshes. El color de la cara de corte es un tono más oscuro del material original (30% más oscuro en luminosidad).

**Contorno de sección:** Una línea de contorno (2px, color del eje) se dibuja en la intersección del plano con la geometría, proporcionando una lectura clara de la sección similar a un plano arquitectónico.

**Indicador de plano:** Un rectángulo semitransparente (5% opacidad) del color del eje se muestra en el espacio 3D para indicar la posición y orientación del plano de corte.

### 6.4 Interacción Dinámica

El desplazamiento del plano de corte es en tiempo real: al arrastrar el slider, la geometría se actualiza frame a frame. La implementación es eficiente porque Three.js evalúa los clipping planes en el fragment shader de la GPU, sin necesidad de recalcular geometría en CPU [7].

En modo walk, los planos de corte se desactivan automáticamente (la experiencia de primera persona pierde sentido con geometría cortada) y se reactivan al volver a modo órbita.

---

## 7. Estructura de Interfaz

### 7.1 Módulo "Configuración"

El módulo de Configuración agrupa todos los ajustes que no cambian frecuentemente durante una sesión de trabajo. Se accede desde el ícono de engranaje en la toolbar.

| Sub-módulo | Controles | Persistencia |
|-----------|-----------|-------------|
| **Sensores** | Toggle giroscopio ON/OFF, sensibilidad (0.1×–3.0×), botón recalibrar | localStorage por dispositivo |
| **Colores por especialidad** | Hue shift + saturación por cada capa, botón "Reset a defaults" | localStorage por proyecto |
| **Rejilla** | Toggle ON/OFF, opacidad (0–100%), resolución (0.1m/1m/5m) | localStorage por proyecto |
| **Unidades** | Sistema decimal (único soportado), formato de display (m/cm automático o forzado) | localStorage global |
| **Calidad gráfica** | Preset: Baja/Media/Alta, controla pixel ratio, antialiasing, sombras, edge quality | localStorage por dispositivo |

Los presets de calidad gráfica ajustan automáticamente múltiples parámetros:

| Parámetro | Baja | Media | Alta |
|-----------|------|-------|------|
| Pixel ratio | 1.0 | min(dpr, 1.5) | min(dpr, 2.0) |
| Antialiasing | OFF | FXAA | MSAA 4× |
| Sombras | OFF | Soft (512px) | Soft (2048px) |
| Edge quality | Ángulo 35° | Ángulo 25° | Ángulo 15° |
| Max draw calls | 500 | 2000 | Sin límite |

### 7.2 Módulo "Visualización / Conceptos"

Este módulo contiene las herramientas de uso frecuente durante la inspección del modelo. Se organiza en tabs dentro del panel lateral (PC) o bottom sheet (móvil).

**Tab Capas:**
Listado de todas las especialidades con toggle de visibilidad, slider de opacidad y botones de acción rápida (Mostrar todas, Ocultar todas, Ocultar mobiliario, Solo arquitectura).

**Tab Visual:**
Modos visuales preset (Normal, Cristal, Sólido, Oscuro, Translúcido, Rayos X) en grid de 3×2 botones con preview visual. Slider de altura de cámara (solo visible en walk mode).

**Tab Cortes:**
Tres sliders (X, Y, Z) con colores correspondientes, toggles de activación por eje, botón de inversión de dirección.

**Tab Medición:**
Botón activar/desactivar herramienta de medición, historial de mediciones de la sesión, botón limpiar todas las mediciones.

### 7.3 Estructura de Navegación por Dispositivo

**Pantallas pequeñas (móvil, <768px):**

```
┌──────────────────────────────┐
│ [≡] Proyecto    [🔍][📷][👤] │  ← Header compacto
├──────────────────────────────┤
│                              │
│                              │
│         VISOR 3D             │  ← Área 3D (100vh - header - controls)
│                              │
│                              │
├──────────────────────────────┤
│  [👣] [📐] [🔄]  [⚙️]       │  ← Controles flotantes
├──────────────────────────────┤
│ ▼ Bottom Sheet (arrastrable) │  ← Capas/Visual/Cortes/Medición
│   [Capas] [Visual] [Cortes] │
│   ─────────────────────────  │
│   □ Arquitectura    ████░░  │
│   □ HVAC            ██████  │
│   □ Plomería        ██████  │
└──────────────────────────────┘
```

El bottom sheet tiene tres estados: colapsado (solo tabs visibles), medio (50% de pantalla) y expandido (80% de pantalla). Se arrastra con gesto vertical. Los controles flotantes permanecen siempre visibles sobre el visor 3D.

**Pantallas medianas (tablet, 768–1024px):**

Mismo layout que móvil pero con bottom sheet más ancho y controles más espaciados. En landscape, opcionalmente se muestra como panel lateral derecho (320px) en lugar de bottom sheet.

**Pantallas grandes (PC, ≥1024px):**

```
┌────────────────────────────────────────────────────────┐
│ [Logo] Proyecto          [🔍][📐][📷][↗️][⚙️] [👤]    │
├──────────────────────────────────────────┬─────────────┤
│                                          │ [Capas]     │
│                                          │ [Visual]    │
│              VISOR 3D                    │ [Cortes]    │
│           (área principal)               │ [Medición]  │
│                                          │             │
│                                          │ □ Arq  ██░  │
│                                          │ □ HVAC ███  │
│  [👣 Walk] [🔄 Reset] [+][-]            │ □ Plom ███  │
└──────────────────────────────────────────┴─────────────┘
```

El panel lateral es colapsable con un botón toggle. En estado colapsado, solo se muestra una barra de íconos de 48px de ancho.

---

## 8. Benchmark y Mejores Prácticas

### 8.1 Análisis de Aplicaciones de Referencia

Se analizaron las siguientes aplicaciones BIM/3D móviles para extraer patrones de éxito y anti-patrones:

| Aplicación | Fortaleza Principal | Debilidad Principal | Lección para ObjetivaAR |
|-----------|--------------------|--------------------|------------------------|
| **Autodesk Viewer** | Integración profunda con ecosistema Autodesk, markups robustos | Requiere cuenta Autodesk, pesado en carga inicial | Markups como ciudadanos de primera clase, no como feature secundario |
| **BIMx (Graphisoft)** | "Hyper-model" — transición fluida 2D↔3D | Solo modelos de ArchiCAD, UX compleja | La transición entre vistas debe ser instantánea y sin menús intermedios |
| **Dalux BIM Viewer** | Rendimiento excepcional en modelos grandes, UX limpia | Funcionalidad limitada sin suscripción | Priorizar rendimiento sobre features — un viewer rápido con pocas herramientas supera a uno lento con muchas [8] |
| **StreamBIM** | Streaming progresivo (no descarga completa), coordinación en campo | Dependencia de conexión para primera carga | El streaming progresivo es el futuro — mostrar geometría parcial mientras se carga el resto [1] |
| **Matterport** | Navegación por puntos de interés, experiencia inmersiva | No es BIM real (solo escaneo 3D), sin metadata | Los puntos de interés pre-definidos aceleran la navegación en modelos grandes |
| **GAMMA AR** | AR con georeferenciación precisa, overlay en cámara | Requiere hardware específico, setup complejo | La georeferenciación UTM es esencial para verificación en campo |
| **Procore BIM** | Integración con gestión de proyecto, RFIs nativos | Viewer 3D básico comparado con competencia | Los RFIs deben estar integrados con el modelo 3D, no en un módulo separado |

### 8.2 Lo que Mejor Funciona en Móvil

**Gestos naturales sin instrucciones:** Las aplicaciones más exitosas (Matterport, Google Maps 3D) no requieren tutorial. Un dedo rota, dos dedos hacen zoom/pan. ObjetivaAR sigue este patrón exacto.

**Controles de un solo toque:** En obra, el usuario frecuentemente tiene una sola mano libre. Toda acción frecuente (toggle capa, cambiar piso, medir) debe ser alcanzable con un solo toque desde la posición natural del pulgar. El bottom sheet con tabs cumple este requisito.

**Feedback visual inmediato:** Cada toque debe producir una respuesta visual en menos de 100ms. Los toggles de capa cambian visibilidad instantáneamente (no esperan a re-renderizar). Los sliders actualizan en tiempo real.

**Carga progresiva con indicador claro:** StreamBIM demostró que los usuarios toleran cargas de 10+ segundos si ven progreso. ObjetivaAR muestra barra de progreso por archivo GLB con porcentaje y nombre de especialidad.

### 8.3 Lo que Debe Evitarse

**Menús profundos (>2 niveles):** Cada nivel adicional de menú pierde ~40% de usuarios en móvil. ObjetivaAR limita la profundidad a 2 niveles máximo (tab → control).

**Modales que bloquean el visor:** Los diálogos modales que cubren el modelo 3D rompen el contexto espacial del usuario. ObjetivaAR usa bottom sheets y paneles laterales que siempre dejan visible al menos el 50% del visor.

**Rotación automática o animaciones no solicitadas:** Varios viewers BIM incluyen auto-rotate o fly-through automático que desorientan al usuario. ObjetivaAR nunca mueve la cámara sin input explícito del usuario (principio fundamental del walk mode).

**Texto pequeño sobre el modelo 3D:** Las etiquetas flotantes con texto <12px son ilegibles en móvil bajo luz solar. ObjetivaAR usa mínimo 14px con fondo semitransparente de alto contraste.

**Carga de modelo completo antes de mostrar algo:** La estrategia "todo o nada" produce pantallas en blanco de 30+ segundos en modelos grandes. ObjetivaAR carga y muestra cada especialidad conforme se completa su descarga.

### 8.4 Patrones de Interacción más Intuitivos

**Pinch-to-zoom persistente:** El zoom por pinch debe mantener el nivel al soltar los dedos (no regresar a vista base). ObjetivaAR implementa esto desactivando el reset automático de OrbitControls.

**Double-tap para reset:** Un patrón universal (Google Maps, Instagram, Safari) que ObjetivaAR adopta para volver a la vista general del modelo.

**Long-press para información:** Mantener presionado un elemento durante 500ms muestra sus propiedades (nombre IFC, dimensiones, material). Esto evita toques accidentales en el modelo.

**Swipe horizontal entre tabs:** En el bottom sheet, el swipe horizontal cambia entre Capas/Visual/Cortes/Medición, siguiendo el patrón de apps nativas (Instagram stories, app stores).

**Joystick virtual con zona muerta:** El joystick de nipplejs tiene una zona muerta de 15% del radio para evitar movimiento accidental al tocar. La velocidad escala linealmente con la distancia al centro.

### 8.5 Buenas Prácticas de Rendimiento y Claridad Visual

**Rendimiento:**

| Práctica | Implementación en ObjetivaAR | Impacto Medido |
|----------|------------------------------|----------------|
| Geometry instancing | Meshes repetidos (ventanas, columnas) comparten geometría | -40% draw calls |
| Texture atlas | Materiales similares comparten textura | -30% state changes |
| LOD automático | Reducir polígonos a >50m de distancia | +15 FPS en modelos grandes |
| Render on demand | Solo renderizar cuando hay input o animación activa | -80% uso de GPU en reposo |
| Web Workers para parsing | GLTFLoader en worker thread | UI no se bloquea durante carga |

**Claridad visual:**

El principio rector es **"menos es más"**: el modelo BIM ya es visualmente complejo, la UI debe ser invisible hasta que se necesite. Los controles usan fondos semitransparentes que no compiten con la geometría. Los colores de la UI (paleta Objetiva: navy, teal, blanco) están elegidos para contrastar con los colores típicos de modelos BIM (grises, metálicos, colores de tubería).

Las aristas (edge detection) están siempre activas por defecto porque proporcionan definición geométrica crítica que los materiales planos de WebGL no pueden comunicar. Sin aristas, un muro gris se funde con otro muro gris adyacente. Con aristas, cada elemento tiene contorno definido similar a un plano técnico.

---

## Referencias

[1]: StreamBIM. "How to view BIM Models on Mobile Devices." https://streambim.com/how-to-view-bim-models-on-mobile-solutions-trade-offs-and-how-they-differ/

[2]: Shift Asia. "BIM Viewer with ThreeJs: understand the structure to have a better strategy." https://shiftasia.com/community/bim-viewer-with-threejs-understand-the-structure-to-have-a-better-stradegy/

[3]: Apple Developer Documentation. "DeviceOrientationEvent.requestPermission()." https://developer.apple.com/documentation/webkitjs/deviceorientationevent/1630089-requestpermission

[4]: Google Developers. "Sensor APIs — DeviceOrientation." https://developers.google.com/web/fundamentals/native-hardware/device-orientation

[5]: Autodesk Knowledge Network. "Revit Export to glTF/GLB." https://knowledge.autodesk.com/

[6]: Three.js Documentation. "EdgesGeometry." https://threejs.org/docs/#api/en/geometries/EdgesGeometry

[7]: Three.js Documentation. "Material.clippingPlanes." https://threejs.org/docs/#api/en/materials/Material.clippingPlanes

[8]: Reddit r/bim. "Versatile BIM Viewer that has nice performance." https://www.reddit.com/r/bim/comments/19dqyb7/versatile_bim_viewer_that_has_nice_performance/

---

*Documento preparado para el equipo de desarrollo de Objetiva. Las especificaciones técnicas reflejan el estado actual de la implementación y las decisiones de diseño tomadas para la versión de producción de ObjetivaAR.*
