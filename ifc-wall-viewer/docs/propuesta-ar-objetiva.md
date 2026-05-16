# ObjetivaAR — Propuesta Técnica de Visualización Arquitectónica en Sitio

**Autor:** Objetiva Ingeniería  
**Fecha:** Febrero 2026  
**Versión:** 1.0

---

## 1. Visión General de la Experiencia

ObjetivaAR transforma la coordinación de obra al superponer el modelo BIM digital directamente sobre el entorno real de construcción. El usuario camina físicamente por la obra mientras visualiza estructura, arquitectura e instalaciones MEP con control visual independiente, permitiendo detectar conflictos, verificar avances y documentar hallazgos en tiempo real.

La experiencia se divide en dos modos complementarios que operan sobre el mismo motor de renderizado:

**Modo Escritorio/Tablet (Web 3D):** Visualización completa del modelo con navegación orbital y modo caminar (first-person). Controles visuales avanzados por categoría, edge detection, modo rayos X, herramienta de medición, anotaciones y captura de pantalla. Este es el modo actualmente implementado en ObjetivaAR.

**Modo AR en Campo (WebXR):** Superposición del modelo sobre la cámara del dispositivo mediante WebXR Device API. Georeferenciación por marcador físico o coordenadas GPS. El modelo se ancla al mundo real y el usuario camina libremente por la obra viendo las instalaciones superpuestas con transparencia configurable.

---

## 2. Arquitectura Técnica

### 2.1 Stack Tecnológico

| Componente | Tecnología | Justificación |
|---|---|---|
| Motor 3D | Three.js r170+ | Ligero, WebGL2/WebGPU, sin instalación nativa |
| AR Runtime | WebXR Device API | Estándar W3C, funciona en Chrome Android sin app |
| Post-processing | Three.js EffectComposer | Outline pass, FXAA, bloom selectivo |
| Shaders | GLSL custom + ShaderMaterial | Control HSL por categoría, fresnel, edge glow |
| Frontend | React 19 + TypeScript | Componentes reactivos para panel de control |
| Backend | tRPC + Drizzle ORM | Persistencia de anotaciones, vistas compartidas |
| Offline | Service Worker + Cache API | GLBs cacheados localmente para campo sin señal |

### 2.2 Pipeline de Renderizado

El pipeline implementa un sistema de multi-pass rendering optimizado para dispositivos móviles:

```
Pass 1: Depth Pre-pass (solo estructura)
  → Genera depth buffer para oclusión correcta

Pass 2: Opaque Pass (estructura sólida)
  → MeshStandardMaterial con uniforms HSL custom
  → Edge detection via normal discontinuity

Pass 3: Transparent Pass (arquitectura + instalaciones)
  → Sorted back-to-front
  → Fresnel rim lighting para legibilidad en transparencia
  → Depth write OFF, depth test ON

Pass 4: Post-processing
  → OutlinePass selectivo por categoría
  → FXAA antialiasing
  → Vignette sutil para enfoque central
```

### 2.3 Diagrama de Componentes

```
┌─────────────────────────────────────────────────┐
│                  ObjetivaAR                      │
├──────────┬──────────┬──────────┬────────────────┤
│ Visor 3D │ Panel    │ AR Mode  │ Anotaciones    │
│ Three.js │ Control  │ WebXR    │ DB + Pins 3D   │
├──────────┴──────────┴──────────┴────────────────┤
│              Shader Engine (GLSL)                │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ HSL     │ │ Outline  │ │ Fresnel          │  │
│  │ Uniform │ │ Pass     │ │ Transparency     │  │
│  └─────────┘ └──────────┘ └──────────────────┘  │
├─────────────────────────────────────────────────┤
│           Service Worker (Offline)               │
├─────────────────────────────────────────────────┤
│        tRPC Backend + S3 Storage + DB            │
└─────────────────────────────────────────────────┘
```

---

## 3. Control de Color por Categoría

### 3.1 Shader HSL Custom

Cada categoría (estructura, arquitectura, instalaciones) recibe un `ShaderMaterial` con uniforms independientes que permiten control en tiempo real sin re-crear materiales:

```glsl
// Fragment shader - HSL control per category
uniform float u_hueShift;      // -180 a +180 grados
uniform float u_saturation;    // 0.0 a 2.0 (1.0 = original)
uniform float u_opacity;       // 0.0 a 1.0
uniform vec3  u_tintColor;     // Color base override

vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;
    float s = 0.0, h = 0.0;
    if (maxC != minC) {
        float d = maxC - minC;
        s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
        if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
        else h = (c.r - c.g) / d + 4.0;
        h /= 6.0;
    }
    return vec3(h, s, l);
}

// En el main():
vec3 hsl = rgb2hsl(baseColor.rgb);
hsl.x = fract(hsl.x + u_hueShift / 360.0);  // Hue shift
hsl.y *= u_saturation;                        // Saturación
vec3 finalRGB = hsl2rgb(hsl);
gl_FragColor = vec4(finalRGB, baseColor.a * u_opacity);
```

### 3.2 Mapeo de Categorías

| Categoría | Elementos | Color Default | Opacidad Default |
|---|---|---|---|
| Estructura | Columnas, vigas, losas, cimentación | Gris concreto `#8C8C8C` | 100% |
| Arquitectura | Muros, tabiques, divisiones | Blanco cálido `#F5F0E8` | 40% |
| HVAC | Ductos, equipos mecánicos | Azul `#4A90D9` | 85% |
| Plomería | Tuberías agua, drenaje | Verde `#4CAF50` | 85% |
| Eléctrico | Charolas, conduit, tableros | Rojo `#E74C3C` | 85% |
| Mecánico | Equipos especiales | Naranja `#FF9800` | 85% |

---

## 4. Edge Detection y Outline Shader

### 4.1 Técnica: Normal-Based Edge Detection

Se utiliza un post-process pass que detecta discontinuidades en las normales de superficie y en la profundidad del depth buffer. Esto produce contornos limpios sin depender de la geometría del modelo:

```glsl
// Edge detection fragment shader
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform float u_edgeThickness;  // 1.0 - 4.0 px
uniform vec3  u_edgeColor;

float getEdge(vec2 uv) {
    float depth  = texture2D(tDepth, uv).r;
    vec3  normal = texture2D(tNormal, uv).rgb;

    float depthDiff = 0.0;
    float normalDiff = 0.0;

    for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
            vec2 offset = vec2(float(i), float(j)) * u_edgeThickness / resolution;
            depthDiff  += abs(depth - texture2D(tDepth, uv + offset).r);
            normalDiff += length(normal - texture2D(tNormal, uv + offset).rgb);
        }
    }

    return clamp(depthDiff * 50.0 + normalDiff * 2.0, 0.0, 1.0);
}
```

### 4.2 Configuración por Categoría

Cada categoría puede tener su propio color y grosor de contorno, lo que permite diferenciar visualmente estructura (contorno grueso negro) de arquitectura (contorno fino gris) de instalaciones (contorno medio en color de la especialidad).

| Categoría | Color Contorno | Grosor | Estilo |
|---|---|---|---|
| Estructura | Negro `#1B2A4A` | 3px | Sólido, prominente |
| Arquitectura | Gris `#999999` | 1px | Sutil, solo aristas principales |
| Instalaciones | Color de especialidad | 2px | Medio, diferenciador |

---

## 5. Transparencias sin Perder Profundidad Visual

### 5.1 Fresnel Rim Lighting

El problema clásico de la transparencia es que los objetos pierden legibilidad volumétrica. La solución es aplicar un efecto Fresnel que intensifica la opacidad en los bordes de la geometría, creando una sensación de "vidrio" que mantiene la lectura 3D:

```glsl
// Fresnel effect para transparencias arquitectónicas
float fresnelBias = 0.1;
float fresnelScale = 1.0;
float fresnelPower = 2.0;

vec3 viewDir = normalize(cameraPosition - vWorldPosition);
float fresnel = fresnelBias + fresnelScale * pow(1.0 - dot(viewDir, vNormal), fresnelPower);

// Opacidad final = base * fresnel
float finalAlpha = u_opacity * mix(0.3, 1.0, fresnel);
```

### 5.2 Orden de Renderizado

Para evitar artefactos de transparencia, el sistema implementa order-independent transparency (OIT) simplificado: los objetos opacos se renderizan primero con depth write, luego los transparentes se ordenan back-to-front por centroide y se renderizan con depth test ON pero depth write OFF.

---

## 6. Modo Rayos X

El modo rayos X es un preset que combina los controles anteriores en una configuración optimizada para inspección de instalaciones en campo:

| Parámetro | Arquitectura | Estructura | Instalaciones |
|---|---|---|---|
| Opacidad | 15% | 60% | 100% |
| Saturación | 0.2 (casi gris) | 0.4 | 1.5 (saturado) |
| Contorno | 0.5px gris claro | 2px navy | 3px color especialidad |
| Fresnel | Activo (borde brillante) | Desactivado | Desactivado |
| Efecto | Cristal fantasma | Semi-sólido | Sólido destacado |

El resultado visual: los muros se vuelven casi invisibles como cristal con bordes sutiles, la estructura aparece como un esqueleto semi-transparente que da contexto espacial, y las tuberías/ductos se ven completamente sólidas y saturadas, permitiendo seguir su recorrido sin obstrucción.

---

## 7. Funcionalidad Innovadora: "Comparación Temporal" (Construction Progress Overlay)

La funcionalidad diferenciadora de ObjetivaAR es la **Comparación Temporal**: el usuario puede capturar el estado actual de la obra (foto 360° o scan) y superponerlo como textura de fondo sobre el modelo BIM, creando un "diff visual" entre lo construido y lo diseñado.

**Implementación práctica en la versión web actual:**

El sistema permite tomar una captura del viewport 3D con las anotaciones y mediciones activas, generando un reporte visual automático que incluye: vista 3D con las capas activas, mediciones tomadas, anotaciones del equipo, y metadata (fecha, usuario, proyecto, nivel). Este reporte se guarda en la base de datos y se puede compartir mediante enlace directo.

**Evolución futura con WebXR:**

Cuando se active el modo AR, la comparación temporal permitirá ver en la pantalla del dispositivo la obra real de fondo con el modelo BIM superpuesto, y el usuario podrá "congelar" un frame de la cámara para comparar punto a punto lo construido vs. lo diseñado, marcando discrepancias directamente sobre la imagen con pins geolocalizados.

---

## 8. Implementación en ObjetivaAR (Web Actual)

Las funcionalidades descritas se implementan directamente en el visor web existente usando Three.js, sin necesidad de Unity o Unreal Engine. El enfoque web-first garantiza:

**Accesibilidad inmediata:** funciona en cualquier navegador moderno sin instalación. **Offline:** Service Worker cachea los GLBs para uso en campo sin señal. **Cross-platform:** mismo código en PC, tablet Android/iOS, y futuro AR. **Actualización instantánea:** cambios se despliegan sin pasar por app stores.

La transición a AR nativo (WebXR) se hará cuando los dispositivos AR de campo (tablets con LiDAR, gafas AR) alcancen madurez suficiente para construcción. El motor de renderizado y los shaders son los mismos; solo cambia el sistema de tracking y la fuente de video de fondo.

---

## 9. Roadmap de Implementación

| Fase | Funcionalidad | Estado |
|---|---|---|
| 1 | Controles HSL por categoría (color, opacidad, tono, saturación) | En desarrollo |
| 2 | Edge detection con OutlinePass por categoría | En desarrollo |
| 3 | Modo rayos X (preset de visualización) | En desarrollo |
| 4 | Anotaciones en campo (pins 3D + texto + DB) | Pendiente |
| 5 | Compartir vista (enlace con cámara serializada) | Pendiente |
| 6 | WebXR AR mode (superposición cámara real) | Futuro |
| 7 | Comparación temporal (diff visual obra vs. modelo) | Futuro |

---

*ObjetivaAR — Coordinación de obra inteligente.*
