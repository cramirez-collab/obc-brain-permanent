# ObjetivaAR — Documento Técnico de Arquitectura

**Autor:** Manus AI para Objetiva  
**Fecha:** 19 de febrero de 2026  
**Versión:** 1.0

---

## 1. Arquitectura General

### 1.1 Principios de Diseño

ObjetivaAR es una aplicación web profesional de revisión BIM diseñada bajo el paradigma **Mobile First** con paridad funcional absoluta entre dispositivos. No existe reducción de funciones entre móvil, tablet y PC: cada control, slider, botón y modo visual está disponible en las tres plataformas con interfaces adaptadas al factor de forma.

La arquitectura sigue un modelo **cliente pesado con servidor ligero**. El renderizado 3D ocurre íntegramente en el navegador del usuario mediante WebGL 2.0, mientras que el servidor gestiona autenticación, persistencia de datos, conversión de archivos y almacenamiento de modelos.

### 1.2 Stack Tecnológico

| Capa | Tecnología | Justificación |
|------|-----------|---------------|
| **Frontend** | React 19 + TypeScript | Ecosistema maduro, tipado estricto, componentes reutilizables. React 19 con Concurrent Features permite renderizado no-bloqueante durante operaciones 3D pesadas. |
| **Motor 3D** | Three.js r170+ | Motor WebGL más adoptado, soporte nativo de glTF/GLB, extensible con shaders custom, comunidad activa con soporte para EdgesGeometry, LOD, y post-processing. |
| **Estilos** | Tailwind CSS 4 | Utility-first, purga automática, responsive sin media queries manuales, consistencia visual entre dispositivos. |
| **Componentes UI** | shadcn/ui + Radix | Accesibles, composables, sin opinión visual, compatibles con Tailwind. |
| **Estado** | React Query (TanStack) + Zustand | React Query para estado servidor (cache, invalidación, optimistic updates). Zustand para estado local del visor 3D (capas, modos, cámara). |
| **API** | tRPC 11 | Tipado end-to-end sin generación de código, superjson para serialización de Date/BigInt, batching automático. |
| **Backend** | Node.js + Express | Runtime JavaScript unificado con el frontend, streaming de archivos grandes, middleware extensible. |
| **Base de datos** | TiDB (MySQL compatible) + Drizzle ORM | SQL relacional para datos estructurados (proyectos, usuarios, observaciones, RFIs), Drizzle para type-safety sin overhead de runtime. |
| **Almacenamiento** | S3 (archivos GLB/IFC) | Escalable, CDN-ready, presigned URLs para descarga directa al cliente sin pasar por el servidor. |
| **Conversión IFC** | IfcOpenShell (Python) + servidor de procesamiento | Librería open-source de referencia para parsing IFC, preserva 100% de la geometría sin simplificación. |
| **Autenticación** | OAuth 2.0 (Manus Auth) | SSO corporativo, tokens JWT, sesiones persistentes. |

### 1.3 Diagrama de Flujo de Datos

```
Usuario (Móvil/Tablet/PC)
    │
    ├── Upload IFC ──→ Servidor Node.js ──→ Cola de procesamiento
    │                                           │
    │                                    IfcOpenShell (Python)
    │                                           │
    │                                    GLB por especialidad
    │                                           │
    │                                    S3 Storage
    │                                           │
    ├── Visor 3D ←── GLB Streaming ←── S3 CDN
    │
    ├── tRPC API ←──→ TiDB (metadata, observaciones, RFIs)
    │
    └── Service Worker ←── Cache Storage (offline GLBs)
```

---

## 2. Flujo de Trabajo: IFC → GLB

### 2.1 Pipeline de Conversión

La conversión sigue un pipeline de 4 etapas diseñado para **preservar el 100% de la geometría** sin excepción:

**Etapa 1 — Parsing IFC.** IfcOpenShell lee el archivo IFC completo, extrayendo cada entidad geométrica: IfcWall, IfcColumn, IfcBeam, IfcSlab, IfcPipeSegment, IfcPipeFitting (codos, tees, reducciones), IfcFlowTerminal, IfcFlowSegment, IfcDistributionElement, IfcFastener (anclajes), IfcMechanicalFastener (herrajes), IfcBuildingElementProxy (subcomponentes), IfcFurnishingElement (mobiliario). No se aplica ningún filtro de exclusión.

**Etapa 2 — Clasificación por especialidad.** Cada entidad se clasifica según su IfcClass y PropertySet en una de las categorías: Arquitectura, Estructura, Hidráulica, Sanitaria, Eléctrica, HVAC, PCI, Telecomunicaciones, Gas, Mobiliario, u Otros. La clasificación usa una tabla de mapeo configurable que el administrador puede extender.

**Etapa 3 — Generación GLB.** Cada especialidad se exporta como un archivo GLB independiente usando la librería `trimesh` con backend `pygltflib`. La geometría se triangula con tolerancia máxima (sin decimación), se preservan las normales originales, y se asignan materiales base por categoría. Los metadatos IFC (nombre, tipo, nivel, PropertySets) se embeben como extras en cada nodo del glTF.

**Etapa 4 — Validación de integridad.** Un script de validación compara el conteo de entidades del IFC original contra los nodos del GLB generado. Si hay discrepancia > 0, el proceso se marca como fallido y se notifica al usuario. No se permite pérdida silenciosa de geometría.

### 2.2 Garantía de Integridad

| Mecanismo | Descripción |
|-----------|-------------|
| **Zero-filter policy** | El pipeline NO tiene filtros de exclusión. Toda entidad con geometría se exporta. |
| **Conteo de entidades** | Pre-conversión y post-conversión se comparan conteos por IfcClass. |
| **Hash de verificación** | SHA-256 del IFC original se almacena junto al GLB para trazabilidad. |
| **Log de conversión** | Cada entidad procesada se registra con su GUID, clase y especialidad asignada. |
| **Reporte al usuario** | Al finalizar, el usuario recibe un resumen: X entidades procesadas, Y archivos GLB generados, Z MB totales. |

### 2.3 Librerías de Conversión

| Librería | Rol | Versión |
|----------|-----|---------|
| **IfcOpenShell** | Parsing IFC2x3/IFC4/IFC4.3 | 0.8.x |
| **trimesh** | Triangulación y exportación GLB | 4.x |
| **pygltflib** | Manipulación glTF/GLB de bajo nivel | 2.x |
| **numpy** | Operaciones vectoriales sobre vértices | 1.26+ |

---

## 3. Visualización Completa de Especialidades

### 3.1 Organización por Capas

Cada especialidad se carga como un grupo independiente en el scene graph de Three.js. La estructura jerárquica es:

```
Scene
├── Grupo: Arquitectura (muros, tabiques, puertas, ventanas)
├── Grupo: Estructura (columnas, vigas, losas, cimentación)
├── Grupo: Hidráulica (tuberías agua fría/caliente, válvulas)
├── Grupo: Sanitaria (drenajes, registros, bajantes)
├── Grupo: Eléctrica (charolas, tubería conduit, tableros)
├── Grupo: HVAC (ductos, difusores, equipos)
├── Grupo: PCI (rociadores, tuberías contra incendio)
├── Grupo: Telecomunicaciones (cableado, racks)
├── Grupo: Gas (tuberías, reguladores)
├── Grupo: Mobiliario (muebles, equipamiento)
└── Grupo: Otros (elementos no clasificados)
```

### 3.2 Gestión de Visibilidad

Cada grupo tiene un toggle ON/OFF independiente en el panel lateral. La visibilidad se controla mediante `group.visible = true/false`, lo que excluye el grupo completo del pipeline de renderizado (zero GPU cost cuando está oculto). Adicionalmente, cada grupo tiene un slider de opacidad individual (0%–100%) que modifica el `material.opacity` y `material.transparent` de todos los meshes del grupo.

### 3.3 Código de Colores por Defecto

| Especialidad | Color | Hex |
|-------------|-------|-----|
| Arquitectura | Gris claro | #B0B0B0 |
| Estructura | Gris medio | #808080 |
| Hidráulica | Azul | #2196F3 |
| Sanitaria | Verde | #4CAF50 |
| Eléctrica | Naranja | #FF9800 |
| HVAC | Azul cielo | #03A9F4 |
| PCI | Rojo | #F44336 |
| Telecomunicaciones | Púrpura | #9C27B0 |
| Gas | Amarillo | #FFEB3B |
| Mobiliario | Beige | #D7CCC8 |

---

## 4. Funcionalidades Obligatorias

### 4.1 Control de Escala de Colores

Cada especialidad expone 3 controles en el panel lateral: **Hue shift** (±180° sobre el color base), **Saturación** (0–200%), y **Luminosidad** (0–200%). Los cambios se aplican en tiempo real mediante un shader uniforme HSL que transforma el color base del material sin reemplazarlo.

### 4.2 Modos Visuales

| Modo | Descripción técnica |
|------|-------------------|
| **Cristal claro** | `material.transparent = true`, `material.opacity = 0.15`, `material.side = DoubleSide`, `material.depthWrite = false`. Simula vidrio con refracción mínima. |
| **Oscuro no translúcido** | `material.transparent = false`, `material.opacity = 1.0`, color oscurecido al 30% de luminosidad. Sólido, opaco, sin transparencia. |
| **Translúcido** | `material.transparent = true`, `material.opacity = 0.5`, `material.depthWrite = true`, orden de renderizado back-to-front. Semitransparente con profundidad. |
| **Sólido** | `material.transparent = false`, `material.opacity = 1.0`, colores originales. Renderizado estándar sin efectos. |

Los modos se aplican globalmente o por especialidad seleccionada. Un selector tipo segmented control permite cambiar entre modos con un toque.

### 4.3 Aristas Siempre Activas

Las aristas se implementan mediante **EdgesGeometry** de Three.js con un ángulo umbral de 15°. Para cada mesh de arquitectura y estructura, se genera un `LineSegments` hijo con material `LineBasicMaterial` de color negro (#1a1a1a) y `linewidth: 1`. Este objeto de aristas tiene las siguientes propiedades:

- **Independencia de material**: las aristas son objetos separados del mesh padre. Cambios de opacidad, color o modo visual del mesh NO afectan las aristas.
- **Renderizado sobre transparencia**: las aristas usan `depthTest: true` pero `renderOrder: 999`, garantizando que se dibujen sobre cualquier superficie transparente.
- **Toggle global**: un botón "Aristas ON/OFF" controla la visibilidad de todos los objetos de aristas simultáneamente.
- **Aplica a**: muros (tablaroca, Waller, sólidos), columnas, vigas, losas, y toda la estructura.

### 4.4 Botón Ocultar Mobiliario

Un botón dedicado con icono de sofá (`Sofa` de lucide-react) oculta/muestra el grupo completo de Mobiliario con un solo toque. Esta acción:

- NO afecta estructura, arquitectura ni especialidades MEP.
- Se implementa como `mobilarioGroup.visible = !mobilarioGroup.visible`.
- El estado se refleja visualmente en el botón (activo/inactivo).
- Funciona independientemente de los toggles de capas.

### 4.5 Aplicación por Elemento Seleccionado

Mediante raycasting, el usuario puede tocar/hacer clic en cualquier elemento individual del modelo. Al seleccionarlo, aparece un panel contextual con:

- Nombre del elemento y especialidad.
- Propiedades IFC (nivel, tipo, material, dimensiones).
- Controles de opacidad, color y modo visual que aplican SOLO a ese elemento.
- Botón "Aislar" que oculta todo excepto el elemento seleccionado.
- Botón "Ocultar" que oculta solo ese elemento.

---

## 5. Navegación

### 5.1 Modo Primera Persona (Walk-Through)

La navegación en primera persona replica la experiencia de caminar físicamente por la obra. La cámara se posiciona a la altura configurada por el usuario (por defecto 1.65m, ajustable entre 1.0m y 2.5m mediante slider).

**Controles por dispositivo:**

| Dispositivo | Movimiento | Rotación |
|------------|-----------|---------|
| **Móvil/Tablet** | Joystick virtual (esquina inferior izquierda) | Arrastrar en zona derecha de pantalla + giroscopio opcional |
| **PC** | Teclado WASD + Q/E (subir/bajar) | Mouse look (click derecho + arrastrar) |

**Características:**

- Movimiento libre: adelante, atrás, izquierda, derecha, subir, bajar.
- Giro 360° sin restricciones.
- Detección de colisiones contra muros y estructura (raycasting horizontal 8 direcciones).
- Detección de piso (raycasting vertical hacia abajo) para seguir escaleras y rampas.
- Anti-mareo: suavizado de movimiento con interpolación lineal (lerp factor 0.15).
- Velocidad configurable mediante slider en panel de ajustes.

### 5.2 Indicador de Navegación

Se reemplaza el avatar tipo "monito" por un **indicador minimalista tipo huellas** inspirado en Autodesk. El icono es un SVG custom de dos huellas de zapato estilizadas, renderizado como botón circular con fondo teal (#00A89D) y huellas en blanco. Al activar el modo walk, el icono se anima con un pulso suave.

### 5.3 Modo Órbita

El modo órbita permite inspeccionar el modelo desde cualquier ángulo. Controles:

- **Móvil**: un dedo = rotar, dos dedos = pan, pinch = zoom (dolly).
- **PC**: click izquierdo = rotar, click medio = pan, scroll = zoom.
- Zoom sin límite perceptible (dolly + FOV dinámico).
- Doble toque/doble click = centrar en punto tocado.

---

## 6. Rendimiento y Modelos Grandes

### 6.1 Estrategia de Optimización (Sin Pérdida de Geometría)

La optimización se basa en **reducir el costo de renderizado sin modificar la geometría original**:

| Técnica | Descripción | Impacto |
|---------|-------------|---------|
| **Frustum Culling** | Three.js descarta automáticamente objetos fuera del campo de visión. | -40% draw calls típico |
| **LOD Dinámico** | Tres niveles de detalle por mesh: original (< 50m), simplificado 50% (50-200m), bounding box (> 200m). La geometría original NUNCA se elimina, solo se oculta temporalmente. | -60% triángulos en vistas lejanas |
| **Instancing** | Elementos repetidos (columnas, vigas estándar) se renderizan con InstancedMesh. Una sola geometría, N matrices de transformación. | -80% draw calls en estructura repetitiva |
| **Occlusion Culling** | Objetos completamente ocultos por otros se descartan del renderizado. Implementado via GPU occlusion queries. | -30% en interiores |
| **Texture Atlas** | Materiales similares se agrupan en un solo atlas para reducir cambios de estado GPU. | -50% state changes |
| **Logarithmic Depth Buffer** | Evita z-fighting en modelos grandes sin sacrificar precisión cercana. | Elimina artefactos visuales |

### 6.2 Gestión de Memoria

- **Carga por especialidad**: cada GLB se carga independientemente. El usuario puede descargar especialidades no necesarias para liberar memoria.
- **Dispose agresivo**: al ocultar una especialidad por más de 60 segundos, se ejecuta `geometry.dispose()` y `material.dispose()` para liberar GPU. Al reactivar, se recarga desde cache.
- **Web Workers**: el parsing de GLB ocurre en un Web Worker para no bloquear el hilo principal.
- **Presupuesto de memoria**: el sistema monitorea `performance.memory` (Chrome) y alerta al usuario si se acerca al límite del dispositivo.

### 6.3 Streaming y Carga Progresiva

Los archivos GLB se sirven desde S3 CDN con soporte de **Range Requests**. El cliente puede iniciar el renderizado antes de que la descarga complete usando el decoder progresivo de glTF. Las especialidades se cargan en orden de prioridad: Estructura → Arquitectura → MEP activas → resto.

Un **Service Worker** intercepta las peticiones de GLB y las almacena en Cache Storage para uso offline. El usuario puede pre-descargar todo el modelo para trabajo en campo sin conexión.

---

## 7. Interfaz Obligatoria

### 7.1 Panel Lateral de Especialidades

En desktop (≥1024px), el panel es un sidebar colapsable de 320px a la izquierda. En tablet/móvil (<1024px), se transforma en un **bottom sheet** con handle de arrastre. El panel contiene:

- Lista de especialidades con toggle ON/OFF y color indicator.
- Slider de opacidad por especialidad (0–100%).
- Botón "Ocultar Mobiliario" (icono sofá).
- Botón "Aristas Siempre Activas" (icono cuadrícula).
- Selector de modo visual (cristal / sólido / oscuro / translúcido).
- Selector de modo de navegación (órbita / primera persona).

### 7.2 Barra de Herramientas

Botones flotantes sobre el viewport 3D:

| Botón | Icono | Función |
|-------|-------|---------|
| Zoom + / - | ZoomIn/ZoomOut | Zoom incremental |
| Captura | Camera | Screenshot PNG |
| Medir | Ruler | Medición entre dos puntos |
| Recentrar | Crosshair | Centrar modelo en viewport |
| Huellas | Footprints SVG | Activar modo primera persona |
| Pisos | Building | Selector de nivel (S5–N21) |

### 7.3 Tabs del Panel

| Tab | Contenido |
|-----|----------|
| **Capas** | Lista de especialidades con toggles y sliders de opacidad |
| **Visual** | Controles HSL por categoría, modo visual, aristas, rayos X |
| **Medir** | Herramienta de medición con historial |
| **Coords** | Coordenadas del modelo, offset UTM, calibración GPS |
| **Corte** | Planos de corte X/Y/Z con sliders |
| **Info** | Propiedades del elemento seleccionado |
| **Ajustes** | Velocidad, sensibilidad, altura de cámara, calidad gráfica |

---

## 8. Arquitectura Técnica Completa

### 8.1 Estructura de Componentes

```
App
├── AuthProvider (OAuth, sesiones)
├── ThemeProvider (dark/light)
├── Home (dashboard multiproyecto)
│   ├── ProjectCard (tarjeta por proyecto)
│   └── NewProjectDialog (crear proyecto)
├── ProjectViewer (visor 3D principal)
│   ├── ThreeCanvas (renderer WebGL)
│   │   ├── SceneManager (scene graph, luces, cámara)
│   │   ├── LayerManager (grupos por especialidad)
│   │   ├── WalkController (primera persona)
│   │   ├── OrbitController (órbita)
│   │   ├── EdgeRenderer (aristas)
│   │   ├── MeasureTool (medición)
│   │   └── AnnotationManager (pins 3D)
│   ├── ControlPanel (panel lateral/bottom sheet)
│   │   ├── LayersTab
│   │   ├── VisualTab
│   │   ├── MeasureTab
│   │   ├── CoordsTab
│   │   ├── CutTab
│   │   ├── InfoTab
│   │   └── SettingsTab
│   └── Toolbar (botones flotantes)
├── Bitacora (observaciones + chat)
├── RFI (solicitudes de información + markup)
├── Report (exportación PDF)
└── UTMCalibration (georeferenciación)
```

### 8.2 Flujo de Datos

```
[Upload IFC] → [Server: Queue] → [Worker: IfcOpenShell] → [GLB por especialidad] → [S3]
                                                                                      ↓
[Cliente] ← [GLB Streaming] ← [S3 CDN] ← [Service Worker Cache]
    ↓
[Three.js Scene] → [WebGL Renderer] → [Canvas] → [Pantalla]
    ↑
[tRPC] ↔ [TiDB] (metadata, observaciones, RFIs, anotaciones)
```

### 8.3 Estrategia de Renderizado 3D

El renderizado usa **WebGLRenderer** de Three.js con las siguientes configuraciones:

- `logarithmicDepthBuffer: true` para modelos de gran escala.
- `antialias: true` en desktop, `false` en móvil (rendimiento).
- `pixelRatio: Math.min(window.devicePixelRatio, 2)` para limitar resolución en pantallas HiDPI.
- **Render on demand**: el loop de animación solo renderiza cuando hay cambios (cámara, visibilidad, animación). En reposo, 0 frames por segundo.
- **Post-processing**: outline pass para aristas (cuando el modo de aristas está activo), FXAA para antialiasing en móvil.

### 8.4 Gestión de Estados

| Estado | Tecnología | Alcance |
|--------|-----------|---------|
| Sesión/usuario | React Query + tRPC | Global, persistido en cookie |
| Datos servidor (proyectos, observaciones) | React Query cache | Global, invalidación automática |
| Estado del visor 3D (capas, modos, cámara) | Zustand store | Local al componente visor |
| Calibración UTM | localStorage | Persistido por proyecto |
| Cache offline | Service Worker + Cache Storage | Persistido en dispositivo |

### 8.5 Estrategia de Escalabilidad

| Dimensión | Estrategia |
|-----------|-----------|
| **Usuarios concurrentes** | Servidor stateless, escalado horizontal con load balancer. |
| **Modelos grandes** | Streaming desde S3 CDN, carga progresiva, LOD dinámico. |
| **Múltiples proyectos** | Cada proyecto es independiente en DB y S3. Sin límite de proyectos. |
| **Offline** | Service Worker + Cache Storage. Sincronización eventual al reconectar. |
| **Internacionalización** | Strings externalizados, soporte futuro para i18n. |

### 8.6 Riesgos Técnicos y Mitigación

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|-----------|
| **Modelo excede memoria del dispositivo** | Media | Alto | Monitoreo de memoria, alerta al usuario, descarga de especialidades no activas, LOD agresivo. |
| **Conversión IFC pierde geometría** | Baja | Crítico | Validación de conteo de entidades post-conversión, log detallado, rechazo automático si hay discrepancia. |
| **Rendimiento bajo en móviles gama baja** | Alta | Medio | Detección de GPU, ajuste automático de calidad (pixel ratio, antialias, sombras), modo "lite" opcional. |
| **Giroscopio impreciso** | Media | Bajo | Filtro complementario, deadzone, botón de recalibración. |
| **Pérdida de conexión en campo** | Alta | Medio | Service Worker offline-first, cola de sincronización para observaciones y RFIs. |
| **Z-fighting en superficies coplanares** | Media | Bajo | Logarithmic depth buffer, polygon offset en aristas. |
| **Compatibilidad de navegadores** | Baja | Medio | WebGL 2.0 como requisito mínimo (98% de navegadores actuales). Fallback informativo para navegadores sin soporte. |

---

## Referencias

- [1] Three.js Documentation — https://threejs.org/docs/
- [2] IfcOpenShell — https://ifcopenshell.org/
- [3] glTF 2.0 Specification — https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- [4] Web Workers API — https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- [5] Service Worker API — https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- [6] GAMMA AR — https://gamma-ar.com/ (benchmark de referencia)
- [7] Drizzle ORM — https://orm.drizzle.team/
- [8] tRPC — https://trpc.io/
