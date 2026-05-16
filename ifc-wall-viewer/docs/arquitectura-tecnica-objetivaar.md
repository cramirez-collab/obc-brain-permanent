# Arquitectura Técnica — ObjetivaAR

**Versión:** 2.0  
**Fecha:** 19 de febrero de 2026  
**Autor:** Equipo Objetiva / Manus AI  
**Estado:** Producción

---

## 1. Visión General del Sistema

ObjetivaAR es un visor BIM 3D orientado a obra que permite a arquitectos, ingenieros, supervisores y residentes de obra visualizar modelos arquitectónicos en formato GLB directamente desde el navegador. La aplicación combina renderizado 3D en tiempo real con herramientas de gestión de campo (bitácora de observaciones, RFIs con markup fotográfico, reportes PDF y calibración UTM/GPS) en una interfaz responsive optimizada para dispositivos móviles en condiciones de obra.

El sistema está diseñado bajo los principios de **offline-first** (Service Worker para cache de GLBs), **mobile-first** (controles táctiles, joystick virtual, giroscopio) y **production-ready** (autenticación OAuth, base de datos relacional, notificaciones push).

---

## 2. Stack Tecnológico

| Capa | Tecnología | Versión | Propósito |
|------|-----------|---------|-----------|
| **Frontend** | React | 18.x | UI declarativa con hooks |
| **Lenguaje** | TypeScript | 5.9 | Tipado estático end-to-end |
| **Bundler** | Vite | 7.x | HMR rápido, build optimizado |
| **3D Engine** | Three.js | 0.182 | Renderizado WebGL del modelo BIM |
| **Controles 3D** | OrbitControls / Custom FPS | — | Navegación órbita y primera persona |
| **Joystick** | nipplejs | — | Control táctil virtual para walk mode |
| **Estilos** | Tailwind CSS | 4.x | Utility-first responsive design |
| **Componentes UI** | shadcn/ui + Radix | — | Primitivas accesibles |
| **Backend** | Express | 4.x | Servidor HTTP + API |
| **RPC** | tRPC | 11.x | Tipado end-to-end sin REST boilerplate |
| **ORM** | Drizzle | 0.44 | Schema-first, migraciones SQL |
| **Base de datos** | MySQL / TiDB | — | Persistencia relacional |
| **Autenticación** | Manus OAuth | — | SSO con cookie de sesión |
| **Almacenamiento** | S3 (AWS SDK) | — | Archivos GLB, imágenes, adjuntos |
| **Notificaciones** | Manus Notification API | — | Push al owner del proyecto |
| **Offline** | Service Worker | — | Cache de GLBs para uso sin conexión |

---

## 3. Arquitectura de Componentes

### 3.1 Diagrama de Alto Nivel

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENTE (Browser)                     │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Router   │  │  Auth Context │  │  tRPC Client     │  │
│  │  (wouter) │  │  (useAuth)    │  │  (httpBatchLink) │  │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│       │               │                    │            │
│  ┌────▼───────────────▼────────────────────▼─────────┐  │
│  │                    PÁGINAS                         │  │
│  │  Home │ ProjectViewer │ Bitacora │ RFI │ UTM │ …  │  │
│  └───────────────────────────────────────────────────┘  │
│       │                                                 │
│  ┌────▼─────────────────────────────────────────────┐   │
│  │              THREE.JS SCENE GRAPH                │   │
│  │  Scene → Camera → Renderer → OrbitControls       │   │
│  │  Groups: arch_struct, hvac, plumbing, elec, mech │   │
│  │  EdgeGroups: *_edges (LineSegments)               │   │
│  │  Annotations: Sprites con texto                   │   │
│  │  Measurement: Line + Spheres + Label              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              SERVICE WORKER (sw.js)              │   │
│  │  Cache Strategy: Cache-first para GLBs           │   │
│  │  Network-first para API calls                    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          │ HTTPS (tRPC + proxy)
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    SERVIDOR (Express)                    │
│                                                         │
│  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │  tRPC Router  │  │  OAuth      │  │  GLB Proxy     │  │
│  │  (routers.ts) │  │  Callback   │  │  (streaming)   │  │
│  └──────┬───────┘  └─────┬──────┘  └───────┬────────┘  │
│         │                │                  │           │
│  ┌──────▼────────────────▼──────────────────▼────────┐  │
│  │              CAPA DE DATOS                        │  │
│  │  Drizzle ORM → MySQL/TiDB                         │  │
│  │  S3 SDK → Almacenamiento de archivos              │  │
│  │  Notification API → Push al owner                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Componentes Frontend Principales

| Componente | Archivo | Responsabilidad | Líneas aprox. |
|-----------|---------|----------------|---------------|
| **ProjectViewer** | `pages/ProjectViewer.tsx` | Visor 3D completo: escena Three.js, walk mode, controles visuales, capas, medición, anotaciones, giroscopio, pinch-to-zoom, modos visuales | ~3000 |
| **Home** | `pages/Home.tsx` | Dashboard de proyectos, CRUD, grid responsive | ~300 |
| **Bitacora** | `pages/Bitacora.tsx` | Log de observaciones con chat, filtros, layout dos columnas | ~500 |
| **RFI** | `pages/RFI.tsx` | Módulo RFI con markup fotográfico (canvas editor), chat, workflow de estados | ~800 |
| **UTM** | `pages/UTM.tsx` | Calibración UTM/GPS, conversión lat/lng→UTM, guardado en localStorage | ~300 |
| **Reporte** | `pages/Reporte.tsx` | Generación de reporte PDF con resumen, observaciones, RFIs | ~250 |

### 3.3 Estructura del Scene Graph (Three.js)

```
Scene
├── AmbientLight (intensidad 0.6)
├── DirectionalLight (intensidad 0.8, posición elevada)
├── HemisphereLight (cielo/suelo)
├── Group "arch_struct"          ← Arquitectura/Estructura
│   ├── Mesh (MeshPhongMaterial, transparente)
│   ├── Mesh ...
│   └── ...
├── Group "arch_struct_edges"    ← Aristas de arquitectura
│   ├── LineSegments (LineBasicMaterial)
│   └── ...
├── Group "hvac"                 ← HVAC (MeshStandardMaterial)
├── Group "hvac_edges"
├── Group "plumbing"             ← Plomería
├── Group "plumbing_edges"
├── Group "electrical"           ← Eléctrico
├── Group "electrical_edges"
├── Group "mechanical"           ← Mecánico
├── Group "mechanical_edges"
├── Sprite[] (Anotaciones)
├── Line (Medición activa)
├── Mesh[] (Esferas de medición)
└── Sprite (Label de distancia)
```

---

## 4. Flujo de Datos

### 4.1 Carga de Modelo GLB

```
1. Usuario selecciona proyecto en Home
2. ProjectViewer monta → consulta project.getById via tRPC
3. Para cada archivo GLB del proyecto:
   a. Service Worker intercepta fetch a /api/proxy-glb?url=...
   b. Si existe en cache → responde desde cache (offline-first)
   c. Si no → proxy del servidor hace streaming desde S3/CDN
   d. GLTFLoader parsea el GLB
   e. Se crean Groups con Meshes (MeshPhongMaterial o MeshStandardMaterial)
   f. Se generan EdgeGroups con LineSegments (EdgesGeometry, ángulo 25°)
   g. Se aplican visual settings iniciales (aristas activas por defecto)
4. Primera carga → fitAll() centra la cámara en el bounding box
```

### 4.2 Walk Mode (Primera Persona)

```
1. Usuario toca botón de huellas (Footprints icon)
2. enterWalkMode():
   a. Guarda posición/orientación actual de OrbitControls
   b. Calcula centro del modelo en PB (planta baja)
   c. Posiciona cámara a walkHeight (configurable, default 1.65m)
   d. Activa controles first-person (teclado WASD/QE + mouse/touch)
   e. Muestra joystick virtual (nipplejs) en móvil
3. Animation loop (solo cuando usuario controla):
   a. Lee input de joystick/teclado → calcula dirección
   b. Collision check (raycasting horizontal contra muros)
   c. Si no hay colisión → mueve targetPos con wall-sliding
   d. Floor detection (raycasting vertical hacia abajo)
   e. Smooth lerp de posición actual hacia targetPos
   f. Actualiza yaw/pitch desde mouse/touch/giroscopio
   g. Dibuja minimap 2D
4. CRÍTICO: La cámara NUNCA se mueve automáticamente
```

### 4.3 Modos Visuales

| Modo | Arquitectura | MEP/Tuberías | Aristas | Fondo |
|------|-------------|-------------|---------|-------|
| **Normal** | Opacidad original | Opacidad original | Grosor 1.0, gris | Default |
| **Cristal** | 20% opacidad, sat. baja | 85% opacidad | Grosor 2.0, azul acero | Default |
| **Sólido** | 100% opacidad, sat. alta | 100% opacidad | Grosor 1.5, negro | Default |
| **Oscuro** | 90% opacidad, sat. media | 95% opacidad | Grosor 2.5, neón teal | Oscuro |
| **Translúcido** | 12% opacidad | 70% opacidad | Grosor 1.5, por capa | Default |
| **Rayos X** | 15% opacidad, sat. baja | 100%, sat. alta | Grosor 3.0, color capa | Default |

### 4.4 Gestión de Observaciones y RFIs

```
┌──────────┐     tRPC mutation      ┌──────────┐     Drizzle      ┌──────────┐
│  Cliente  │ ──────────────────────▶│ Servidor │ ───────────────▶│   MySQL  │
│  (React)  │                        │ (Express)│                  │  /TiDB   │
│           │◀──────────────────────│          │◀───────────────│          │
│           │     tRPC query         │          │     SQL rows     │          │
└──────────┘                        └──────────┘                  └──────────┘
      │                                   │
      │ Canvas markup (base64)            │ notifyOwner()
      │ → storagePut() → S3               │ → Manus Notification API
      ▼                                   ▼
  Imagen con                         Push notification
  anotaciones                        al owner del proyecto
```

---

## 5. Modelo de Datos

### 5.1 Esquema de Base de Datos (Drizzle)

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   users      │     │    projects       │     │  observations    │
├─────────────┤     ├──────────────────┤     ├─────────────────┤
│ id (PK)      │◀───│ ownerId (FK)      │     │ id (PK)          │
│ openId       │     │ id (PK)           │◀───│ projectId (FK)   │
│ name         │     │ name              │     │ title            │
│ avatarUrl    │     │ description       │     │ description      │
│ role         │     │ files (JSON)      │     │ category         │
│ createdAt    │     │ createdAt         │     │ priority         │
│ updatedAt    │     │ updatedAt         │     │ status           │
└─────────────┘     └──────────────────┘     │ location         │
                                              │ photos (JSON)    │
                                              │ createdBy (FK)   │
                                              │ createdAt        │
                                              └────────┬────────┘
                                                       │
                    ┌──────────────────┐     ┌─────────▼────────┐
                    │      rfis         │     │  chat_messages    │
                    ├──────────────────┤     ├──────────────────┤
                    │ id (PK)           │     │ id (PK)           │
                    │ projectId (FK)    │     │ observationId(FK) │
                    │ number            │     │ rfiId (FK)        │
                    │ subject           │     │ userId (FK)       │
                    │ description       │     │ content           │
                    │ status            │     │ createdAt         │
                    │ priority          │     └──────────────────┘
                    │ assignedTo        │
                    │ dueDate           │     ┌──────────────────┐
                    │ createdBy (FK)    │     │ rfi_attachments   │
                    │ createdAt         │     ├──────────────────┤
                    └──────────────────┘     │ id (PK)           │
                                              │ rfiId (FK)        │
                                              │ url               │
                                              │ type              │
                                              │ createdAt         │
                                              └──────────────────┘
```

### 5.2 Campo `files` del Proyecto (JSON)

Cada proyecto almacena un array JSON con la configuración de archivos GLB:

```typescript
interface ProjectFile {
  specialty: string;    // "arch_struct" | "hvac" | "plumbing" | "electrical" | "mechanical"
  label: string;        // "Arquitectura/Estructura" | "HVAC" | ...
  url: string;          // URL del GLB en CDN/S3
  color: string;        // Color hex para materiales (#C0C0C0, #FF6B35, ...)
  opacity: number;      // Opacidad base (0-100)
  transparent: number;  // 0 | 1
  showEdges: number;    // 0 | 1 (legacy, ahora siempre activas)
}
```

---

## 6. Controles de Interacción

### 6.1 Modo Órbita (Default)

| Dispositivo | Acción | Resultado |
|------------|--------|-----------|
| Desktop | Click izquierdo + arrastrar | Rotar vista |
| Desktop | Click derecho + arrastrar | Pan (desplazar) |
| Desktop | Scroll rueda | Zoom (dolly) |
| Móvil | 1 dedo arrastrar | Rotar vista |
| Móvil | 2 dedos arrastrar | Pan |
| Móvil | Pinch (2 dedos) | Zoom (dolly nativo OrbitControls) |
| Móvil | Doble tap | Reset vista |

### 6.2 Modo Walk (Primera Persona)

| Dispositivo | Acción | Resultado |
|------------|--------|-----------|
| Desktop | W/A/S/D | Mover adelante/izq/atrás/der |
| Desktop | Q/E | Subir/Bajar |
| Desktop | Mouse arrastrar | Mirar (yaw/pitch) |
| Móvil | Joystick virtual (izquierda) | Mover en plano XZ |
| Móvil | Touch derecha | Mirar (yaw/pitch) |
| Móvil | Botones ↑↓ | Subir/Bajar |
| Ambos | Giroscopio (si habilitado) | Orientación hands-free |

### 6.3 Giroscopio (DeviceOrientation API)

El sistema utiliza un **filtro complementario** para fusionar datos del giroscopio y acelerómetro, reduciendo drift y ruido:

- **Alpha filtrado** = 0.92 × gyro + 0.08 × accel (yaw)
- **Beta filtrado** = 0.92 × gyro + 0.08 × accel (pitch)
- **Deadzone**: rotaciones menores a 0.3°/s se ignoran
- **Smoothing**: factor 0.12 para suavizar salida
- **Anti-mareo**: velocidad angular máxima 3.0 rad/s

---

## 7. Renderizado y Materiales

### 7.1 Materiales por Especialidad

| Especialidad | Material | Propiedades Clave |
|-------------|----------|-------------------|
| Arquitectura/Estructura | `MeshPhongMaterial` | Transparente, shininess 100, depthWrite off |
| HVAC | `MeshStandardMaterial` | Metalness 0.3, roughness 0.4, smooth normals |
| Plomería | `MeshStandardMaterial` | Metalness 0.3, roughness 0.4, smooth normals |
| Eléctrico | `MeshStandardMaterial` | Metalness 0.3, roughness 0.4, smooth normals |
| Mecánico | `MeshStandardMaterial` | Metalness 0.3, roughness 0.4, smooth normals |

### 7.2 Aristas (Edge Detection)

Todas las capas generan aristas al cargar mediante `EdgesGeometry` con ángulo de detección de **25 grados**. Las aristas se renderizan como `LineSegments` con `LineBasicMaterial` y se almacenan en grupos separados (`*_edges`) para control independiente de visibilidad y grosor.

### 7.3 Optimizaciones de Rendimiento

- **Pixel ratio reducido** en móvil (máximo `devicePixelRatio` o 2)
- **Antialias condicional** (desactivado en GPU móvil de baja gama)
- **Logarithmic depth buffer** para inspección cercana de tuberías sin z-fighting
- **matrixAutoUpdate = false** en todos los meshes (matrices estáticas)
- **Frustum culling** nativo de Three.js
- **Near/Far dinámico** según distancia al modelo

---

## 8. Sistema de Coordenadas y Posicionamiento

### 8.1 UTM (Universal Transverse Mercator)

La calibración UTM permite alinear el modelo 3D con coordenadas reales de obra:

1. El usuario captura su posición GPS actual (Geolocation API)
2. Se convierte lat/lng a coordenadas UTM (zona, hemisferio, easting, northing)
3. Se establece un punto de referencia en el modelo 3D (x, y, z)
4. El offset se guarda en `localStorage` por proyecto
5. En el visor, las coordenadas del cursor se muestran en UTM real

### 8.2 Sistema de Pisos

El edificio se modela con **27 niveles** y entrepiso de **3 metros**:

| Rango | Niveles | Altura Y |
|-------|---------|----------|
| Sótanos | S5 → S1 | -15.0m → -3.0m |
| Planta Baja | PB | 0.0m |
| Niveles | N1 → N21 | 3.0m → 63.0m |

El selector de nivel permite teletransportarse directamente a cualquier piso en modo walk.

---

## 9. Offline y Service Worker

### 9.1 Estrategia de Cache

```javascript
// sw.js - Estrategia por tipo de recurso
// GLBs: Cache-first (archivos grandes, raramente cambian)
// API calls: Network-first (datos frescos cuando hay conexión)
// Assets estáticos: Cache-first con revalidación
```

### 9.2 Flujo Offline

1. Primera visita: Service Worker se registra y cachea shell de la app
2. Al cargar GLBs: se almacenan en Cache Storage (pueden ser 50-200MB por modelo)
3. Sin conexión: GLBs se sirven desde cache, UI funciona con datos locales
4. Al reconectar: se sincronizan observaciones/RFIs pendientes

---

## 10. Seguridad y Autenticación

### 10.1 Flujo OAuth

```
Usuario → Login Portal (Manus OAuth) → Callback /api/oauth/callback
  → Cookie de sesión (JWT firmado con JWT_SECRET)
  → ctx.user disponible en todas las procedures protegidas
```

### 10.2 Protección de Rutas

| Tipo | Procedure | Acceso |
|------|----------|--------|
| Público | `publicProcedure` | Cualquier visitante |
| Protegido | `protectedProcedure` | Usuario autenticado (ctx.user) |
| Admin | `adminProcedure` | role === "admin" |

### 10.3 Proxy de GLBs

Los archivos GLB se sirven a través de un proxy del servidor (`/api/proxy-glb`) que:
- Valida la URL de origen (whitelist de dominios CDN)
- Hace streaming sin cargar todo en memoria
- Permite al Service Worker cachear la respuesta

---

## 11. Notificaciones

El sistema envía notificaciones push al owner del proyecto en los siguientes eventos:

| Evento | Título | Contenido |
|--------|--------|-----------|
| Nueva observación | "Nueva observación en {proyecto}" | Título + categoría + prioridad |
| Nuevo mensaje en observación | "Nuevo mensaje en observación" | Contenido del mensaje |
| Nuevo RFI creado | "Nuevo RFI #{número}" | Asunto + prioridad |
| Nuevo mensaje en RFI | "Nuevo mensaje en RFI #{número}" | Contenido del mensaje |
| Cambio de estado RFI | "RFI #{número} actualizado" | Nuevo estado |

---

## 12. Branding y Diseño

### 12.1 Paleta de Colores

| Token | Valor | Uso |
|-------|-------|-----|
| `navy` | `#1B2A4A` | Texto principal, headers, fondos oscuros |
| `teal` | `#00A89D` | Acento principal, botones activos, badges |
| `tealLight` | `#00C4B7` | Hover states |
| `tealDark` | `#008F85` | Active states |
| `bg` | `#F7F9FC` | Fondo general |
| `cardBg` | `#FFFFFF` | Tarjetas y paneles |
| `border` | `#E2E8F0` | Bordes sutiles |
| `textPrimary` | `#1B2A4A` | Texto principal |
| `textSecondary` | `#64748B` | Texto secundario |
| `textMuted` | `#94A3B8` | Labels, hints |

### 12.2 Responsive Breakpoints

| Breakpoint | Ancho | Layout |
|-----------|-------|--------|
| Móvil | < 768px | Bottom sheet, joystick, botones grandes |
| Tablet | 768px - 1023px | Bottom sheet expandible, controles medianos |
| Desktop | ≥ 1024px | Panel lateral derecho, teclado + mouse |

---

## 13. Estructura de Archivos del Proyecto

```
ifc-wall-viewer/
├── client/
│   ├── public/
│   │   └── sw.js                    ← Service Worker
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.tsx             ← Dashboard de proyectos
│   │   │   ├── ProjectViewer.tsx    ← Visor 3D principal (~3000 líneas)
│   │   │   ├── Bitacora.tsx         ← Bitácora de observaciones
│   │   │   ├── RFI.tsx              ← Módulo RFI con markup
│   │   │   ├── UTM.tsx              ← Calibración UTM/GPS
│   │   │   ├── Reporte.tsx          ← Generación de reportes PDF
│   │   │   └── NotFound.tsx
│   │   ├── components/
│   │   │   └── ui/                  ← shadcn/ui components
│   │   ├── contexts/
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   └── trpc.ts             ← Cliente tRPC
│   │   ├── App.tsx                  ← Router principal
│   │   ├── main.tsx                 ← Entry point + providers
│   │   └── index.css                ← Estilos globales + Tailwind
│   └── index.html
├── server/
│   ├── _core/                       ← Framework (no editar)
│   │   ├── index.ts                 ← Entry point del servidor
│   │   ├── context.ts               ← Contexto tRPC (auth)
│   │   ├── oauth.ts                 ← OAuth callback
│   │   ├── env.ts                   ← Variables de entorno
│   │   ├── llm.ts                   ← Helper LLM
│   │   ├── notification.ts          ← notifyOwner()
│   │   └── ...
│   ├── db.ts                        ← Query helpers (Drizzle)
│   ├── routers.ts                   ← Procedures tRPC
│   └── storage.ts                   ← Helpers S3
├── drizzle/
│   ├── schema.ts                    ← Esquema de tablas
│   ├── relations.ts                 ← Relaciones Drizzle
│   └── migrations/                  ← Migraciones SQL
├── shared/
│   ├── const.ts                     ← Constantes compartidas
│   └── types.ts                     ← Tipos compartidos
├── docs/
│   ├── arquitectura-tecnica-objetivaar.md  ← Este documento
│   └── propuesta-ar-objetiva.md     ← Propuesta AR conceptual
├── package.json
├── vite.config.ts
├── drizzle.config.ts
├── vitest.config.ts
└── tsconfig.json
```

---

## 14. Estrategia de Despliegue

### 14.1 Build Pipeline

```
1. pnpm build
   ├── vite build → dist/public/ (SPA estática)
   └── esbuild → dist/index.js (servidor Node.js)
2. pnpm db:push (drizzle-kit generate + migrate)
3. Deploy a Manus Hosting (botón Publish en UI)
```

### 14.2 Variables de Entorno Requeridas

| Variable | Tipo | Descripción |
|----------|------|-------------|
| `DATABASE_URL` | Sistema | Conexión MySQL/TiDB |
| `JWT_SECRET` | Sistema | Firma de cookies de sesión |
| `VITE_APP_ID` | Sistema | ID de aplicación OAuth |
| `OAUTH_SERVER_URL` | Sistema | Backend OAuth |
| `VITE_OAUTH_PORTAL_URL` | Sistema | Portal de login |
| `BUILT_IN_FORGE_API_URL` | Sistema | APIs internas Manus |
| `BUILT_IN_FORGE_API_KEY` | Sistema | Token para APIs internas |

### 14.3 Hosting

La aplicación se despliega en **Manus Hosting** con soporte para:
- Dominio personalizado (`*.manus.space` o dominio propio)
- SSL automático
- CDN para assets estáticos
- Base de datos gestionada (TiDB)
- S3 para almacenamiento de archivos

---

## 15. Funcionalidades Futuras (Roadmap)

| Prioridad | Funcionalidad | Descripción |
|-----------|--------------|-------------|
| Alta | Roles y permisos | Sistema de roles (admin, supervisor, residente, observador) con permisos granulares |
| Alta | Sincronización offline | Cola de sincronización para observaciones/RFIs creados sin conexión |
| Media | Dashboard de métricas | KPIs de obra: observaciones por categoría, RFIs abiertos/cerrados, tiempos de respuesta |
| Media | AR nativo (WebXR) | Overlay del modelo 3D sobre cámara del dispositivo usando WebXR Device API |
| Media | Comparación de versiones | Diff visual entre versiones del modelo BIM |
| Baja | Exportación IFC | Conversión GLB → IFC para interoperabilidad con otros software BIM |
| Baja | Integración BIM 360 | Sincronización bidireccional con Autodesk BIM 360 |

---

## 16. Consideraciones de Rendimiento

### 16.1 Métricas Objetivo

| Métrica | Objetivo | Notas |
|---------|----------|-------|
| First Contentful Paint | < 2s | Shell de la app sin modelo |
| Carga de GLB (50MB) | < 10s (4G) | Con cache: < 500ms |
| FPS en visor 3D | ≥ 30 FPS | Móvil con 5 capas visibles |
| Memoria máxima | < 512MB | Modelo completo cargado |
| Tamaño del bundle JS | < 500KB (gzip) | Sin Three.js tree-shaking completo |

### 16.2 Optimizaciones Implementadas

- **Proxy streaming** para GLBs (no carga todo en memoria del servidor)
- **matrixAutoUpdate = false** en meshes estáticos
- **EdgesGeometry** pre-calculada al cargar (no en cada frame)
- **Raycasting selectivo** solo contra meshes visibles del piso actual
- **Throttle** en eventos de giroscopio y touch
- **Lerp suave** para movimiento (reduce carga de GPU por frames intermedios)

---

*Documento generado para el equipo de desarrollo de Objetiva. Para consultas técnicas, referirse al código fuente y a la documentación inline en cada componente.*
