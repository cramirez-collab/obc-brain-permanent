import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Loader2, ArrowLeft, Eye, EyeOff, Scissors, MousePointer,
  Layers, Move3D, RotateCcw, Orbit, Menu, X, Smartphone,
  ChevronUp, ChevronDown, Footprints, Maximize, ZoomIn, ZoomOut,
  Map as MapIcon, Crosshair, Settings2, Ruler, Camera, Building2,
  Palette, SunMedium, Contrast, Scan, Zap, Pin, Share2, MessageSquarePlus, Link2, Copy,
  ClipboardList, FileQuestion, FileBarChart, MapPinned,
  Glasses, Moon, Ghost, Box, ArrowUpDown, AlertTriangle, Shield,
  Upload, Download, FolderPlus, FileUp, Check, Pipette, Paintbrush, BrickWall,
  RefreshCw, CheckCircle2, Clock, XCircle, CircleDot, Stamp, Trash2, GitBranch,
  MousePointerClick, Target, CornerDownRight, Pentagon, Hexagon
} from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";

// Patch Three.js prototypes for BVH-accelerated raycasting (global, runs once)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import nipplejs from "nipplejs";
import { fetchGLBWithCache, getCacheSize, clearCache, isCached } from "@/lib/glbCache";
import { toast } from "sonner";

/* ─── Objetiva Brand Colors ─── */
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
};

const BRAND = {
  navy: "#1B2A4A",
  teal: "#00A89D",
  tealLight: "#00C4B7",
  tealDark: "#008F85",
  navyLight: "#2A3F6A",
  bg: "#F7F9FC",
  cardBg: "#FFFFFF",
  border: "#E2E8F0",
  textPrimary: "#1B2A4A",
  textSecondary: "#64748B",
  textMuted: "#94A3B8",
};

/* ─── Types ─── */
interface LayerState {
  visible: boolean;
  loaded: boolean;
  loading: boolean;
  progress: number;
  group: THREE.Group | null;
  edgeGroup: THREE.Group | null;
  fromCache?: boolean;
  lodLoaded?: boolean;
  fullResLoading?: boolean;
  // ETA tracking
  downloadStartTime?: number;
  bytesLoaded?: number;
  bytesTotal?: number;
  etaSeconds?: number;
  speedBps?: number;
}

interface SelectedInfo {
  name: string;
  specialty: string;
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
}

/* ─── Walk Mode Constants ─── */
const WALK_HEIGHT = 1.65;
const MOUSE_SENSITIVITY = 0.002;
const FLOOR_RAY_MAX = 20;
const FLOOR_LERP = 0.12;
const GRAVITY_STEP = 0.08;

/* ─── Collision Constants ─── */
const COLLISION_DISTANCE = 0.4;
const COLLISION_HEIGHT_OFFSET = 0.8;

/* ─── Zoom Constants (FOV + Dolly hybrid) ─── */
const MIN_FOV = 5;          // Extreme zoom in (telephoto)
const MAX_FOV = 120;        // Extreme zoom out (wide angle)
const DEFAULT_FOV = 60;
const DOLLY_NEAR_THRESHOLD = 0.001;  // Switch to FOV zoom when dolly gets this close
const DOLLY_FAR_THRESHOLD = 50000;   // Switch to FOV zoom when dolly gets this far

/* ─── Gyroscope Constants (Complementary Filter) ─── */
const GYRO_FILTER_ALPHA = 0.92;  // Complementary filter coefficient (higher = more gyro, less accel)
const GYRO_DEADZONE = 0.3;       // Degrees per second below which rotation is ignored
const GYRO_SMOOTHING = 0.12;     // Output smoothing factor

/* ─── Anti-motion-sickness ─── */
const MOVE_LERP = 0.25;          // Movement smoothing (higher = more responsive walk)
const MAX_ANGULAR_VELOCITY = 3.5; // Radians/sec cap for camera rotation

/* ─── Pipe specialty keywords ─── */
const PIPE_SPECIALTIES = ["plumbing", "hvac", "mechanical", "electrical"];

/* ─── Architecture/Structure specialties (includes legacy arch_struct) ─── */
const ARCH_SPECIALTIES = ["arch_struct", "architecture", "structure"];

/* ─── Detect mobile/tablet ─── */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024 || "ontouchstart" in window);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

export default function ProjectViewer() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const [, navigate] = useLocation();
  const isMobile = useIsMobile();

  /* ─── Three.js refs ─── */
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number>(0);
  const firstFitDone = useRef(false);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const clippingPlaneRef = useRef<THREE.Plane | null>(null);
  const highlightRef = useRef<THREE.Mesh | null>(null);
  const clipVisualPlaneRef = useRef<THREE.Mesh | null>(null);

  /* Walk mode refs */
  const walkModeRef = useRef(false);
  const keysRef = useRef<Set<string>>(new Set());
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const joystickMoveRef = useRef({ x: 0, y: 0 });

  /* Smooth movement target (anti-nausea) */
  const targetPosRef = useRef(new THREE.Vector3());
  const smoothPosInitialized = useRef(false);

  /* Floor detection refs */
  const floorRaycaster = useRef(new THREE.Raycaster());
  const currentFloorY = useRef(0);

  /* Collision raycaster */
  const collisionRaycaster = useRef(new THREE.Raycaster());

  /* Gyroscope refs (complementary filter) */
  const gyroEnabledRef = useRef(false);
  const gyroAlphaFiltered = useRef(0);
  const gyroBetaFiltered = useRef(0);
  const gyroGammaFiltered = useRef(0);
  const gyroInitRef = useRef(false);
  const gyroBaseAlpha = useRef(0);
  const gyroBaseBeta = useRef(0);
  const gyroLastTimestamp = useRef(0);

  /* Minimap refs */
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);

  /* Axis Gizmo ref */
  const gizmoCanvasRef = useRef<HTMLCanvasElement>(null);

  /* Pinch-to-zoom refs */
  const pinchStartDist = useRef(0);
  const pinchStartFov = useRef(DEFAULT_FOV);

  /* Double-tap detection */
  const lastTapTime = useRef(0);

  /* ─── State ─── */
  const [layers, setLayers] = useState<Record<string, LayerState>>({});
  const [coords, setCoords] = useState({ x: 0, y: 0, z: 0 });
  const [coordsApplied, setCoordsApplied] = useState(false);
  const [utmCalibration, setUtmCalibration] = useState<{ utmRef: { easting: number; northing: number; zone: number; hemisphere: string; elevation: number }; modelRef: { x: number; y: number; z: number } } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedInfo, setSelectedInfo] = useState<SelectedInfo | null>(null);
  const [clippingEnabled, setClippingEnabled] = useState(false);
  const [clippingHeight, setClippingHeight] = useState(50);
  const [clippingAxis, setClippingAxis] = useState<"y" | "x" | "z">("y");
  const [modelBounds, setModelBounds] = useState({ min: -10, max: 100 });
  const [clipDragging, setClipDragging] = useState(false);
  const clipDraggingRef = useRef(false);

  // Element type filter for section cut
  const ELEMENT_TYPES = [
    { key: "wall", label: "Muros", icon: "\u25AE" },
    { key: "slab", label: "Losas", icon: "\u25AC" },
    { key: "column", label: "Columnas", icon: "\u25AE" },
    { key: "beam", label: "Vigas", icon: "\u2500" },
    { key: "door", label: "Puertas", icon: "\u25A1" },
    { key: "window", label: "Ventanas", icon: "\u25A3" },
    { key: "stair", label: "Escaleras", icon: "\u2197" },
    { key: "roof", label: "Techos", icon: "\u25B3" },
    { key: "mep", label: "MEP", icon: "\u25CB" },
    { key: "furniture", label: "Mobiliario", icon: "\u25A0" },
    { key: "railing", label: "Barandas", icon: "\u2502" },
    { key: "other", label: "Otros", icon: "\u25C7" },
  ];
  const [elementTypeFilter, setElementTypeFilter] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ELEMENT_TYPES.map(t => [t.key, true]))
  );
  const [activeTab, setActiveTab] = useState<"layers" | "coords" | "clip" | "info" | "settings" | "measure" | "visual" | "annotate" | "collisions" | "align">("layers");
  const [walkMode, setWalkMode] = useState(false);
  const [walkPos, setWalkPos] = useState({ x: 0, y: 0, z: 0 });
  const [gyroEnabled, setGyroEnabled] = useState(false);
  const [gyroPermission, setGyroPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [bottomSheetExpanded, setBottomSheetExpanded] = useState(false);
  const [currentFloor, setCurrentFloor] = useState<string>("");
  const [showMinimap, setShowMinimap] = useState(true);

  /* Measurement tool */
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([]);
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);
  const measureLineRef = useRef<THREE.Object3D | null>(null);
  const measureSpheresRef = useRef<THREE.Mesh[]>([]);
  const measureLabelRef = useRef<THREE.Sprite | null>(null);
  const measureExtrasRef = useRef<THREE.Object3D[]>([]);
  /* Chain measurement mode: multiple segments */
  const [measureChainMode, setMeasureChainMode] = useState(false);
  const [measureChainPoints, setMeasureChainPoints] = useState<THREE.Vector3[]>([]);
  const [measureChainDistances, setMeasureChainDistances] = useState<number[]>([]);
  const measureChainObjectsRef = useRef<THREE.Object3D[]>([]);
  /* Preview line (real-time dashed line from point A to cursor) */
  const measurePreviewLineRef = useRef<THREE.Line | null>(null);
  const measurePreviewDistLabelRef = useRef<THREE.Sprite | null>(null);
  /* Area measurement mode */
  const [measureAreaMode, setMeasureAreaMode] = useState(false);
  const [measureAreaPoints, setMeasureAreaPoints] = useState<THREE.Vector3[]>([]);
  const measureAreaObjectsRef = useRef<THREE.Object3D[]>([]);
  const [measureAreaResult, setMeasureAreaResult] = useState<{ area: number; perimeter: number } | null>(null);
  /* Measurement history */
  interface MeasureRecord {
    id: string;
    type: "single" | "chain" | "area";
    points: { x: number; y: number; z: number }[];
    distances: number[];
    total: number;
    area?: number;
    perimeter?: number;
    timestamp: number;
    floorLabel?: string;
  }
  const [measureHistory, setMeasureHistory] = useState<MeasureRecord[]>([]);

  /* Screenshot */
  const [screenshotting, setScreenshotting] = useState(false);

  /* Floor levels — detected from model vertex analysis (m). 2 sótanos + PB + 22 niveles */
  const FLOOR_LEVELS = [
    { label: "Sótano 2", short: "S2", y: -8.0 },
    { label: "Sótano 1", short: "S1", y: -4.9 },
    { label: "Planta Baja", short: "PB", y: 0.0 },
    { label: "Nivel 1", short: "N1", y: 3.0 },
    { label: "Nivel 2", short: "N2", y: 5.5 },
    { label: "Nivel 3", short: "N3", y: 12.9 },
    { label: "Nivel 4", short: "N4", y: 16.3 },
    { label: "Nivel 5", short: "N5", y: 19.6 },
    { label: "Nivel 6", short: "N6", y: 23.0 },
    { label: "Nivel 7", short: "N7", y: 26.4 },
    { label: "Nivel 8", short: "N8", y: 29.8 },
    { label: "Nivel 9", short: "N9", y: 33.1 },
    { label: "Nivel 10", short: "N10", y: 36.5 },
    { label: "Nivel 11", short: "N11", y: 39.9 },
    { label: "Nivel 12", short: "N12", y: 43.2 },
    { label: "Nivel 13", short: "N13", y: 46.6 },
    { label: "Nivel 14", short: "N14", y: 50.0 },
    { label: "Nivel 15", short: "N15", y: 52.9 },
    { label: "Nivel 16", short: "N16", y: 56.6 },
    { label: "Nivel 17", short: "N17", y: 59.3 },
    { label: "Nivel 18", short: "N18", y: 63.0 },
    { label: "Nivel 19", short: "N19", y: 66.8 },
    { label: "Nivel 20", short: "N20", y: 70.0 },
    { label: "Nivel 21", short: "N21", y: 73.5 },
    { label: "Azotea", short: "AZ", y: 79.9 },
  ];
  const [showFloorPicker, setShowFloorPicker] = useState(false);
  // Floor isolation: when a floor is selected, clip everything above its ceiling
  const [floorIsolation, setFloorIsolation] = useState(false);
  const [isolatedFloorIdx, setIsolatedFloorIdx] = useState<number | null>(null);

  /* ─── Visual Controls per category ─── */
  interface VisualSettings {
    hueShift: number;       // -180 to +180
    saturation: number;     // 0 to 2
    opacity: number;        // 0 to 100
    edgeThickness: number;  // 0 to 4
    edgeColor: string;
  }
  const [visualSettings, setVisualSettings] = useState<Record<string, VisualSettings>>({});
  const [xrayMode, setXrayMode] = useState(false);

  /* Wall independent control */
  const [wallsVisible, setWallsVisible] = useState(true);
  const [wallOpacity, setWallOpacity] = useState(100);

  /* Custom colors per specialty (overrides default file.color) */
  const [customColors, setCustomColors] = useState<Record<string, string>>({});
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null);
  type VisualMode = "normal" | "crystal" | "solid" | "dark" | "translucent" | "xray";
  const [visualMode, setVisualMode] = useState<VisualMode>("normal");
  const [walkHeight, setWalkHeight] = useState(WALK_HEIGHT);
  const walkHeightRef = useRef(WALK_HEIGHT);
  walkHeightRef.current = walkHeight;
  const visualSettingsRef = useRef<Record<string, VisualSettings>>({});
  visualSettingsRef.current = visualSettings;

  /* Annotations */
  type AnnotationCategory = "observacion" | "defecto" | "aprobado" | "informativo";
  interface Annotation {
    id: string;
    dbId?: number; // DB id for persisted annotations
    position: THREE.Vector3;
    text: string;
    specialty: string;
    category: AnnotationCategory;
    floorLabel?: string;
    resolved: boolean;
    timestamp: number;
    sprite?: THREE.Sprite;
  }
  const ANNOTATION_COLORS: Record<AnnotationCategory, string> = {
    observacion: "#F59E0B", // amber
    defecto: "#EF4444",     // red
    aprobado: "#22C55E",    // green
    informativo: "#3B82F6", // blue
  };
  const ANNOTATION_LABELS: Record<AnnotationCategory, string> = {
    observacion: "Observaci\u00f3n",
    defecto: "Defecto",
    aprobado: "Aprobado",
    informativo: "Informativo",
  };
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState("");
  const [annotationCategory, setAnnotationCategory] = useState<AnnotationCategory>("observacion");
  const [pendingAnnotationPoint, setPendingAnnotationPoint] = useState<THREE.Vector3 | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

  /* Share view */
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);

  /* Grid toggle */
  const [showGrid, setShowGrid] = useState(true);
  const gridGroupRef = useRef<THREE.Group | null>(null);

  /* Floor labels in 3D viewport */
  const [showFloorLabels, setShowFloorLabels] = useState(true);
  const floorLabelsGroupRef = useRef<THREE.Group | null>(null);

  /* Inspection paint mode: touch element → green Objetiva */
  const [inspectionMode, setInspectionMode] = useState(false);
  const paintedMeshesRef = useRef<Map<string, { fileId: number; meshName: string; meshIndex: number }>>(new Map());
  const saveMarksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paintedCount, setPaintedCount] = useState(0);
  const marksRestoredForFiles = useRef<Set<number>>(new Set());

  /* Sensitivity settings */
  const [walkSpeed, setWalkSpeed] = useState(0.35);
  const [lookSensitivity, setLookSensitivity] = useState(1.0);
  const [gyroSensitivity, setGyroSensitivity] = useState(1.0);

  const walkSpeedRef = useRef(0.35);
  const lookSensitivityRef = useRef(1.0);
  const gyroSensitivityRef = useRef(1.0);
  walkSpeedRef.current = walkSpeed;
  lookSensitivityRef.current = lookSensitivity;
  gyroSensitivityRef.current = gyroSensitivity;

  /* AR Immersive Mode */
  const [arSupported, setArSupported] = useState(false);
  const [arActive, setArActive] = useState(false);
  const [arStarting, setArStarting] = useState(false);
  const arSessionRef = useRef<any>(null);
  const arHitTestSourceRef = useRef<any>(null);
  const arReticleRef = useRef<THREE.Mesh | null>(null);
  const arModelPlaced = useRef(false);
  const arModelGroup = useRef<THREE.Group | null>(null);
  const arScaleRef = useRef(1);
  const arRefSpaceRef = useRef<any>(null);
  const arModelCenterRef = useRef(new THREE.Vector3());
  const arModelBaseYRef = useRef(0);
  const arPlacementModeRef = useRef<"site" | "immersive">("site");
  const arOpacityRef = useRef(100);
  const arPlaceFnRef = useRef<(() => void) | null>(null);
  const arEnterImmersiveFnRef = useRef<(() => void) | null>(null);

  /* AR Georeferencing */
  const [arGeoMode, setArGeoMode] = useState(false);
  const [arGpsStatus, setArGpsStatus] = useState<"idle" | "acquiring" | "ready" | "error">("idle");
  const [arCompassHeading, setArCompassHeading] = useState<number | null>(null);
  const [arGpsPosition, setArGpsPosition] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const arCompassRef = useRef<number | null>(null);
  const arGpsWatchRef = useRef<number | null>(null);
  const arCompassListenerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null);

  const layersRef = useRef(layers);
  layersRef.current = layers;
  const coordsRef = useRef(coords);
  coordsRef.current = coords;
  const coordsAppliedRef = useRef(coordsApplied);
  coordsAppliedRef.current = coordsApplied;

  // Load UTM calibration + persisted coords from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(`utm-cal-${projectId}`);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setUtmCalibration(data);
        if (data.modelRef) {
          setCoords({ x: data.modelRef.x, y: data.modelRef.y, z: data.modelRef.z });
          setCoordsApplied(true);
        }
      } catch { /* ignore */ }
    }
    // Also load manually-saved coords (takes precedence over UTM if both exist)
    const savedCoords = localStorage.getItem(`project-coords-${projectId}`);
    if (savedCoords) {
      try {
        const c = JSON.parse(savedCoords);
        if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.z === "number") {
          setCoords(c);
          setCoordsApplied(true);
        }
      } catch { /* ignore */ }
    }
  }, [projectId]);

  /* ─── Data ─── */
  const trpcUtils = trpc.useUtils();
  const projectQuery = trpc.project.getById.useQuery(
    { id: projectId },
    { enabled: !isNaN(projectId) }
  );
  const project = projectQuery.data;
  const files = project?.files ?? [];

  /* ─── Mutations ─── */
  const reprocessMutation = trpc.project.reprocessFile.useMutation({
    onSuccess: () => {
      projectQuery.refetch();
      toast.success("Archivo re-procesado exitosamente");
    },
    onError: (err) => toast.error(`Error re-procesando: ${err.message}`),
  });
  const updateFileStatusMutation = trpc.project.updateFileStatus.useMutation({
    onSuccess: () => projectQuery.refetch(),
    onError: (err) => toast.error(`Error actualizando estado: ${err.message}`),
  });
  const addFileMutation = trpc.project.addFile.useMutation({
    onSuccess: () => projectQuery.refetch(),
    onError: (err) => toast.error(`Error registrando archivo: ${err.message}`),
  });
  const deleteFileMutation = trpc.project.deleteFile.useMutation({
    onSuccess: () => {
      projectQuery.refetch();
      toast.success("Capa eliminada");
    },
    onError: (err) => toast.error(`Error eliminando capa: ${err.message}`),
  });
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);
  const [reprocessingFileId, setReprocessingFileId] = useState<number | null>(null);

  /* ─── Model Alignment ─── */
  const updateFileTransformMutation = trpc.project.updateFileTransform.useMutation({
    onSuccess: () => toast.success("Transformación guardada"),
    onError: (err) => toast.error(`Error: ${err.message}`),
  });
  const [alignEditing, setAlignEditing] = useState<string | null>(null); // specialty being edited
  const [alignValues, setAlignValues] = useState<Record<string, { rotX: number; rotY: number; rotZ: number; posX: number; posY: number; posZ: number; modelScale: number }>>({});

  // Initialize alignValues from file data
  useEffect(() => {
    if (files.length > 0 && Object.keys(alignValues).length === 0) {
      const vals: typeof alignValues = {};
      files.forEach((f: any) => {
        vals[f.specialty] = {
          rotX: f.rotX || 0, rotY: f.rotY || 0, rotZ: f.rotZ || 0,
          posX: f.posX || 0, posY: f.posY || 0, posZ: f.posZ || 0,
          modelScale: f.modelScale || 1,
        };
      });
      setAlignValues(vals);
    }
  }, [files]);

  // Apply alignment changes in real-time to the scene
  const applyAlignmentLive = useCallback((specialty: string, vals: { rotX: number; rotY: number; rotZ: number; posX: number; posY: number; posZ: number; modelScale: number }) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const layer = layers[specialty];
    if (!layer?.group) return;

    const applyTo = (g: THREE.Group) => {
      // Reset transform
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      g.scale.set(1, 1, 1);
      // Apply new transform
      if (vals.modelScale !== 1) g.scale.set(vals.modelScale, vals.modelScale, vals.modelScale);
      if (vals.rotX !== 0) g.rotateX(vals.rotX * Math.PI / 180);
      if (vals.rotY !== 0) g.rotateY(vals.rotY * Math.PI / 180);
      if (vals.rotZ !== 0) g.rotateZ(vals.rotZ * Math.PI / 180);
      g.position.set(g.position.x + vals.posX, g.position.y + vals.posY, g.position.z + vals.posZ);
      // Add user coordinate offset
      if (coordsAppliedRef.current) {
        const c = coordsRef.current;
        g.position.x += c.x;
        g.position.y += c.z;
        g.position.z += c.y;
      }
    };
    applyTo(layer.group);
    if (layer.edgeGroup) applyTo(layer.edgeGroup);
  }, [layers]);

  /* ─── Inspection Marks (Avance persistence) ─── */
  const inspectionMarksQuery = trpc.inspectionMarks.get.useQuery(
    { projectId },
    { enabled: !isNaN(projectId) }
  );
  const saveInspectionMarksMutation = trpc.inspectionMarks.save.useMutation({
    onSuccess: () => { /* silent save */ },
    onError: (err) => console.warn("Error guardando avance:", err.message),
  });

  // Load persisted annotations from DB
  const annotations3dQuery = trpc.annotations3d.list.useQuery(
    { projectId },
    { enabled: !isNaN(projectId) }
  );

  /* ═══════════════════════════════════════════════════
     Recenter camera (gyro + manual)
     ═══════════════════════════════════════════════════ */
  const recenterCamera = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    if (walkModeRef.current) {
      // Reset pitch to 0, keep yaw
      pitchRef.current = 0;
      const euler = new THREE.Euler(0, yawRef.current, 0, "YXZ");
      cam.quaternion.setFromEuler(euler);
      // Reset gyro base
      gyroInitRef.current = false;
    }
  }, []);

  /* ═══════════════════════════════════════════════════
     Draw Minimap — Architectural floor plan with real-time position
     ═══════════════════════════════════════════════════ */
  const minimapZoomRef = useRef(3.0); // meters per pixel
  const drawMinimap = useCallback(() => {
    const canvas = minimapCanvasRef.current;
    const cam = cameraRef.current;
    if (!canvas || !cam || !walkModeRef.current) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const scale = minimapZoomRef.current; // meters per pixel
    const halfW = W / 2;
    const halfH = H / 2;

    // ── Background ──
    ctx.clearRect(0, 0, W, H);
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
    ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H);
    ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 168, 157, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.save();
    ctx.clip(); // clip all drawing to rounded rect

    // ── Subtle grid ──
    const gridSpacing = Math.max(10, Math.round(5 / scale)); // ~5m grid
    ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
    ctx.lineWidth = 0.5;
    const camX = cam.position.x;
    const camZ = cam.position.z;
    const camY = cam.position.y;
    const gridOffsetX = (camX % (gridSpacing * scale)) / scale;
    const gridOffsetZ = (camZ % (gridSpacing * scale)) / scale;
    for (let gx = -halfW - gridSpacing; gx <= halfW + gridSpacing; gx += gridSpacing) {
      const px = halfW + gx - gridOffsetX;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
    for (let gz = -halfH - gridSpacing; gz <= halfH + gridSpacing; gz += gridSpacing) {
      const py = halfH + gz - gridOffsetZ;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    }

    // ── Draw architecture (walls/slabs) as floor plan ──
    const archKeys = Object.keys(layersRef.current).filter(k => ARCH_SPECIALTIES.includes(k));
    const floorTolerance = 2.0; // Y tolerance for current floor
    const floorY = camY - walkHeightRef.current;

    archKeys.forEach(archKey => {
      const aLayer = layersRef.current[archKey];
      if (!aLayer?.group || !aLayer.visible) return;
      aLayer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const geo = mesh.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        if (!geo.boundingBox) return;

        const bb = geo.boundingBox.clone();
        bb.applyMatrix4(mesh.matrixWorld);

        // Only show elements on current floor (within tolerance)
        if (bb.max.y < floorY - floorTolerance || bb.min.y > floorY + 3.0 + floorTolerance) return;

        const minX = halfW + (bb.min.x - camX) / scale;
        const minZ = halfH + (bb.min.z - camZ) / scale;
        const maxX = halfW + (bb.max.x - camX) / scale;
        const maxZ = halfH + (bb.max.z - camZ) / scale;

        // Cull off-screen
        if (maxX < -5 || minX > W + 5 || maxZ < -5 || minZ > H + 5) return;

        const w = maxX - minX;
        const h = maxZ - minZ;

        // Classify: thin elements = walls, wide = slabs/floors
        const worldW = bb.max.x - bb.min.x;
        const worldD = bb.max.z - bb.min.z;
        const worldH = bb.max.y - bb.min.y;
        const minDim = Math.min(worldW, worldD);
        const isWall = minDim < 0.5 && worldH > 1.0;
        const isSlab = worldH < 0.6 && worldW > 1.5 && worldD > 1.5;

        if (isWall) {
          // Walls: solid lines with slight fill
          ctx.fillStyle = "rgba(203, 213, 225, 0.35)";
          ctx.strokeStyle = "rgba(226, 232, 240, 0.8)";
          ctx.lineWidth = Math.max(1, Math.min(w, h, 3));
          ctx.fillRect(minX, minZ, w, h);
          ctx.strokeRect(minX, minZ, w, h);
        } else if (isSlab) {
          // Slabs: very subtle fill
          ctx.fillStyle = "rgba(100, 116, 139, 0.08)";
          ctx.fillRect(minX, minZ, w, h);
        } else {
          // Other elements (columns, beams): small filled rects
          ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
          ctx.fillRect(minX, minZ, w, h);
        }
      });
    });

    // ── Draw MEP elements ──
    for (const [key, layer] of Object.entries(layersRef.current)) {
      if (ARCH_SPECIALTIES.includes(key) || !layer.group || !layer.visible) continue;
      const file = files.find(f => f.specialty === key);
      const color = file ? file.color : BRAND.teal;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const geo = mesh.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        if (!geo.boundingBox) return;

        const bb = geo.boundingBox.clone();
        bb.applyMatrix4(mesh.matrixWorld);

        if (bb.max.y < floorY - floorTolerance || bb.min.y > floorY + 3.0 + floorTolerance) return;

        const cx = halfW + (((bb.min.x + bb.max.x) / 2) - camX) / scale;
        const cz = halfH + (((bb.min.z + bb.max.z) / 2) - camZ) / scale;

        if (cx < -5 || cx > W + 5 || cz < -5 || cz > H + 5) return;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.arc(cx, cz, Math.max(1.5, 3 / scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    // ── View cone (field of view indicator) ──
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const camAngle = Math.atan2(dir.x, dir.z);
    const fovRad = (cam.fov * Math.PI) / 360; // half FOV
    const coneLen = 35; // px
    const leftAngle = camAngle - fovRad;
    const rightAngle = camAngle + fovRad;

    const gradient = ctx.createRadialGradient(halfW, halfH, 0, halfW, halfH, coneLen);
    gradient.addColorStop(0, "rgba(0, 196, 183, 0.25)");
    gradient.addColorStop(1, "rgba(0, 196, 183, 0.0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(halfW, halfH);
    ctx.lineTo(halfW + Math.sin(leftAngle) * coneLen, halfH + Math.cos(leftAngle) * coneLen);
    ctx.arc(halfW, halfH, coneLen, Math.PI / 2 - leftAngle, Math.PI / 2 - rightAngle, true);
    ctx.closePath();
    ctx.fill();

    // View direction line
    ctx.strokeStyle = BRAND.tealLight;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(halfW, halfH);
    ctx.lineTo(halfW + Math.sin(camAngle) * 22, halfH + Math.cos(camAngle) * 22);
    ctx.stroke();

    // ── Player dot ──
    ctx.beginPath();
    ctx.arc(halfW, halfH, 5, 0, Math.PI * 2);
    ctx.fillStyle = BRAND.teal;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Compass rose (top-right corner) ──
    const compassX = W - 18;
    const compassY = 18;
    const compassR = 10;
    // N indicator rotated based on camera
    const nAngle = -camAngle; // north relative to view
    ctx.save();
    ctx.translate(compassX, compassY);
    // Circle bg
    ctx.beginPath();
    ctx.arc(0, 0, compassR + 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 23, 42, 0.6)";
    ctx.fill();
    // N arrow
    ctx.rotate(nAngle);
    ctx.beginPath();
    ctx.moveTo(0, -compassR);
    ctx.lineTo(-3, 2);
    ctx.lineTo(3, 2);
    ctx.closePath();
    ctx.fillStyle = "#EF4444"; // red for north
    ctx.fill();
    // S arrow
    ctx.beginPath();
    ctx.moveTo(0, compassR);
    ctx.lineTo(-3, -2);
    ctx.lineTo(3, -2);
    ctx.closePath();
    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.fill();
    ctx.restore();
    // N label
    ctx.font = "bold 8px 'Outfit', sans-serif";
    ctx.fillStyle = "#EF4444";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const nLabelX = compassX + Math.sin(nAngle) * (compassR + 8);
    const nLabelY = compassY - Math.cos(nAngle) * (compassR + 8);
    ctx.fillText("N", nLabelX, nLabelY);

    // ── Scale bar (bottom-left) ──
    const scaleBarMeters = scale * 20; // 20px bar
    const scaleLabel = scaleBarMeters >= 1 ? `${Math.round(scaleBarMeters)}m` : `${Math.round(scaleBarMeters * 100)}cm`;
    ctx.strokeStyle = "rgba(226, 232, 240, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, H - 10); ctx.lineTo(28, H - 10);
    ctx.moveTo(8, H - 13); ctx.lineTo(8, H - 7);
    ctx.moveTo(28, H - 13); ctx.lineTo(28, H - 7);
    ctx.stroke();
    ctx.font = "7px 'Outfit', sans-serif";
    ctx.fillStyle = "rgba(226, 232, 240, 0.7)";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(scaleLabel, 18, H - 13);

    ctx.restore(); // restore clip
  }, [files]);

  /* ═══════════════════════════════════════════════════
     Draw Axis Gizmo (Revit-style orientation cube)
     ═══════════════════════════════════════════════════ */
  const drawGizmo = useCallback(() => {
    const canvas = gizmoCanvasRef.current;
    const cam = cameraRef.current;
    if (!canvas || !cam) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = canvas.width;
    const half = size / 2;
    const axisLen = size * 0.32;

    ctx.clearRect(0, 0, size, size);

    // Background circle
    ctx.beginPath();
    ctx.arc(half, half, half - 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(27, 42, 74, 0.75)";
    ctx.fill();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Get camera rotation matrix (only rotation, no translation)
    const rotMatrix = new THREE.Matrix4();
    rotMatrix.extractRotation(cam.matrixWorldInverse);

    // Define axes in world space
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: "#EF4444", label: "X" },
      { dir: new THREE.Vector3(0, 1, 0), color: "#22C55E", label: "Y" },
      { dir: new THREE.Vector3(0, 0, 1), color: "#3B82F6", label: "Z" },
    ];

    // Project axes to screen space and sort by depth (painter's algorithm)
    const projected = axes.map((axis) => {
      const v = axis.dir.clone().applyMatrix4(rotMatrix);
      return {
        ...axis,
        screenX: half + v.x * axisLen,
        screenY: half - v.y * axisLen,
        depth: v.z, // positive = towards camera
      };
    });

    // Sort: draw farthest first
    projected.sort((a, b) => a.depth - b.depth);

    for (const axis of projected) {
      const opacity = axis.depth > 0 ? 1.0 : 0.35;

      // Axis line
      ctx.beginPath();
      ctx.moveTo(half, half);
      ctx.lineTo(axis.screenX, axis.screenY);
      ctx.strokeStyle = axis.color;
      ctx.globalAlpha = opacity;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Axis tip circle
      ctx.beginPath();
      ctx.arc(axis.screenX, axis.screenY, 8, 0, Math.PI * 2);
      ctx.fillStyle = axis.color;
      ctx.fill();

      // Axis label
      ctx.fillStyle = "#fff";
      ctx.font = "bold 9px 'Outfit', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(axis.label, axis.screenX, axis.screenY);
    }

    ctx.globalAlpha = 1;

    // Center dot
    ctx.beginPath();
    ctx.arc(half, half, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fill();
  }, []);

  /* ═══════════════════════════════════════════════════
     Three.js Scene Init
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BRAND.bg);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, el.clientWidth / el.clientHeight, 0.001, 1000000);
    camera.position.set(50, 30, 50);
    cameraRef.current = camera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isMobile,
        powerPreference: isMobile ? "low-power" : "high-performance",
        logarithmicDepthBuffer: true,
      });
    } catch {
      console.warn("WebGL not available");
      return;
    }
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Shadows for architectural realism (all devices for consistency)
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Generate a lit environment for PBR reflections (not empty/black)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    // Add lights to the env scene so PBR materials get proper ambient reflections
    envScene.add(new THREE.HemisphereLight(0xddeeff, 0x8899aa, 1.0));
    envScene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const envSun = new THREE.DirectionalLight(0xfff5e6, 0.8);
    envSun.position.set(1, 2, 1);
    envScene.add(envSun);
    const neutralEnv = pmremGenerator.fromScene(envScene).texture;
    scene.environment = neutralEnv;
    pmremGenerator.dispose();

    // Check WebXR AR support
    if (navigator.xr) {
      navigator.xr.isSessionSupported("immersive-ar").then((supported) => {
        setArSupported(supported);
      }).catch(() => setArSupported(false));
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI;
    controls.minDistance = 0.0001;     // Virtually no min distance
    controls.maxDistance = 1000000;    // Virtually no max distance
    controls.zoomSpeed = 1.5;
    // Mobile: use OrbitControls native DOLLY_PAN for pinch - it persists zoom correctly
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.enableZoom = true; // Keep zoom enabled - OrbitControls handles pinch dolly natively
    controlsRef.current = controls;

    // Dynamic near/far adjustment based on distance to target
    const updateClipPlanes = () => {
      if (walkModeRef.current) return;
      const dist = camera.position.distanceTo(controls.target);
      // Near plane: 0.1% of distance, min 0.001
      camera.near = Math.max(0.001, dist * 0.001);
      // Far plane: 1000x distance, min 10000
      camera.far = Math.max(10000, dist * 1000);
      camera.updateProjectionMatrix();
    };
    controls.addEventListener("change", updateClipPlanes);

    // Scroll-wheel zoom: OrbitControls handles zoom natively.
    // We only do a very subtle target shift towards cursor on zoom-in for precision.
    const onWheel = (e: WheelEvent) => {
      if (walkModeRef.current) return;
      // Only shift target on zoom-in (scroll up), and very subtly
      if (e.deltaY >= 0) return; // zoom-out: no target shift
      const rect = el.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(mouse, camera);
      const meshes: THREE.Mesh[] = [];
      Object.values(layersRef.current).forEach((layer) => {
        if (layer.group && layer.visible) {
          layer.group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
          });
        }
      });
      const intersects = rc.intersectObjects(meshes, false);
      if (intersects.length > 0) {
        const hitPoint = intersects[0].point;
        // Very subtle shift (3%) — just enough for precision zoom without apparent rotation
        controls.target.lerp(hitPoint, 0.03);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });

    // Lighting — Revit-quality: hemisphere for sky/ground fill + key directional with shadows
    const hemi = new THREE.HemisphereLight(0xddeeff, 0x8899aa, 0.8);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    // Key light (sun) with soft shadows — same on all devices for consistency
    const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    sunLight.position.set(150, 300, 200);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = isMobile ? 1024 : 2048;
    sunLight.shadow.mapSize.height = isMobile ? 1024 : 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 1500;
    sunLight.shadow.camera.left = -500;
    sunLight.shadow.camera.right = 500;
    sunLight.shadow.camera.top = 500;
    sunLight.shadow.camera.bottom = -500;
    sunLight.shadow.bias = -0.0003;
    sunLight.shadow.normalBias = 0.03;
    scene.add(sunLight);
    // Fill light (cooler, from opposite side)
    const fillLight = new THREE.DirectionalLight(0xc8d8f0, 0.7);
    fillLight.position.set(-200, 150, -150);
    scene.add(fillLight);
    // Rim/back light for depth
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
    rimLight.position.set(0, 50, -300);
    scene.add(rimLight);

    // Adaptive Grid System
    const gridGroup = new THREE.Group();
    gridGroup.name = "__adaptive_grid";
    // Fine grid: 10cm cells (200m, 2000 divisions)
    const gridFine = new THREE.GridHelper(200, 2000, 0xdddddd, 0xeeeeee);
    (gridFine.material as THREE.Material).opacity = 0.15;
    (gridFine.material as THREE.Material).transparent = true;
    gridFine.visible = false;
    gridFine.name = "grid_fine";
    gridGroup.add(gridFine);
    // Medium grid: 1m cells (500m, 500 divisions)
    const gridMedium = new THREE.GridHelper(500, 500, 0xcccccc, 0xe0e0e0);
    (gridMedium.material as THREE.Material).opacity = 0.25;
    (gridMedium.material as THREE.Material).transparent = true;
    gridMedium.visible = true;
    gridMedium.name = "grid_medium";
    gridGroup.add(gridMedium);
    // Coarse grid: 10m cells (500m, 50 divisions)
    const gridCoarse = new THREE.GridHelper(500, 50, 0xbbbbbb, 0xd0d0d0);
    (gridCoarse.material as THREE.Material).opacity = 0.35;
    (gridCoarse.material as THREE.Material).transparent = true;
    gridCoarse.visible = false;
    gridCoarse.name = "grid_coarse";
    gridGroup.add(gridCoarse);
    scene.add(gridGroup);
    gridGroupRef.current = gridGroup;

    // Floor level signs — created lazily after model loads (only for floors in range)
    const floorLabelsGroup = new THREE.Group();
    floorLabelsGroup.name = "__floor_labels";
    scene.add(floorLabelsGroup);
    floorLabelsGroupRef.current = floorLabelsGroup;

    // Axes
    const axes = new THREE.AxesHelper(10);
    scene.add(axes);

    // Target dot indicator (pivot point visualization)
    const targetDotGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const targetDotMat = new THREE.MeshBasicMaterial({
      color: 0x00A89D, // BRAND.teal
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const targetDot = new THREE.Mesh(targetDotGeo, targetDotMat);
    targetDot.renderOrder = 9999;
    targetDot.name = "__target_dot";
    scene.add(targetDot);

    // Ring around target dot
    const ringGeo = new THREE.RingGeometry(0.12, 0.18, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00A89D,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const targetRing = new THREE.Mesh(ringGeo, ringMat);
    targetRing.renderOrder = 9999;
    targetRing.name = "__target_ring";
    scene.add(targetRing);

    // Show/hide target dot on orbit interaction
    let targetDotFadeTimeout: ReturnType<typeof setTimeout> | null = null;
    const showTargetDot = () => {
      if (walkModeRef.current) return;
      targetDotMat.opacity = 0.7;
      ringMat.opacity = 0.5;
      if (targetDotFadeTimeout) clearTimeout(targetDotFadeTimeout);
      targetDotFadeTimeout = setTimeout(() => {
        // Fade out over 600ms via animate loop
        const fadeStart = performance.now();
        const fadeDuration = 600;
        const doFade = () => {
          const elapsed = performance.now() - fadeStart;
          const t = Math.min(elapsed / fadeDuration, 1);
          targetDotMat.opacity = 0.7 * (1 - t);
          ringMat.opacity = 0.5 * (1 - t);
          if (t < 1) requestAnimationFrame(doFade);
        };
        doFade();
      }, 800);
    };
    controls.addEventListener("start", showTargetDot);

    /* ─── Animate loop ─── */
    let lastTime = performance.now();

    function animate() {
      animFrameRef.current = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05); // Cap at 50ms to prevent jumps
      lastTime = now;

      if (walkModeRef.current) {
        const cam = cameraRef.current!;
        const speed = walkSpeedRef.current;

        // Apply gyroscope if enabled
        if (gyroEnabledRef.current && gyroInitRef.current) {
          const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, "YXZ");
          cam.quaternion.setFromEuler(euler);
        }

        // Movement from keyboard or joystick
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        dir.y = 0;
        dir.normalize();
        const right = new THREE.Vector3().crossVectors(dir, cam.up).normalize();

        const keys = keysRef.current;
        const jx = joystickMoveRef.current.x;
        const jy = joystickMoveRef.current.y;

        // Initialize smooth position
        if (!smoothPosInitialized.current) {
          targetPosRef.current.copy(cam.position);
          smoothPosInitialized.current = true;
        }

        // Calculate desired movement
        const moveVec = new THREE.Vector3();

        // Keyboard
        if (keys.has("w") || keys.has("arrowup")) moveVec.add(dir);
        if (keys.has("s") || keys.has("arrowdown")) moveVec.sub(dir);
        if (keys.has("a") || keys.has("arrowleft")) moveVec.sub(right);
        if (keys.has("d") || keys.has("arrowright")) moveVec.add(right);

        // Joystick
        if (Math.abs(jy) > 0.05) moveVec.addScaledVector(dir, -jy);
        if (Math.abs(jx) > 0.05) moveVec.addScaledVector(right, jx);

        // Normalize and apply speed
        if (moveVec.lengthSq() > 0.001) {
          moveVec.normalize().multiplyScalar(speed);

          // Collision check
          const blocked = checkCollisionFn(cam.position, moveVec);
          if (!blocked) {
            targetPosRef.current.add(moveVec);
          } else {
            // Wall sliding: try X-only
            const slideX = new THREE.Vector3(moveVec.x, 0, 0);
            if (slideX.lengthSq() > 0.0001 && !checkCollisionFn(cam.position, slideX.clone().normalize())) {
              targetPosRef.current.add(slideX);
            } else {
              // Try Z-only
              const slideZ = new THREE.Vector3(0, 0, moveVec.z);
              if (slideZ.lengthSq() > 0.0001 && !checkCollisionFn(cam.position, slideZ.clone().normalize())) {
                targetPosRef.current.add(slideZ);
              }
            }
          }
        }

        // Vertical movement (Q/E)
        if (keys.has("q")) targetPosRef.current.y += speed * 0.5;
        if (keys.has("e")) targetPosRef.current.y -= speed * 0.5;

        // Only move camera when there is actual user input (joystick, keyboard, or vertical keys)
        const hasMovement = moveVec.lengthSq() > 0.001 || keys.has("q") || keys.has("e");

        // Floor detection ONLY when user is actively moving horizontally
        if (hasMovement && !keys.has("q") && !keys.has("e")) {
          const floorMeshes = getArchMeshes();
          if (floorMeshes.length > 0) {
            _collisionOrigin.copy(targetPosRef.current);
            _collisionOrigin.y += 1;
            floorRaycaster.current.set(_collisionOrigin, _downVec);
            floorRaycaster.current.far = FLOOR_RAY_MAX;
            floorRaycaster.current.firstHitOnly = true;

            const hits = floorRaycaster.current.intersectObjects(floorMeshes, false);
            if (hits.length > 0) {
              const floorY = hits[0].point.y;
              const targetY = floorY + walkHeightRef.current;
              currentFloorY.current += (targetY - currentFloorY.current) * FLOOR_LERP;
              targetPosRef.current.y = currentFloorY.current;
            }
          }
        }

        // Smooth interpolation (anti-nausea) - only interpolate if there's movement
        if (hasMovement) {
          cam.position.lerp(targetPosRef.current, MOVE_LERP);
        }
      } else {
        controls.update();
      }

      // Update target dot position and scale based on distance
      targetDot.position.copy(controls.target);
      targetRing.position.copy(controls.target);
      targetRing.lookAt(camera.position);
      // Scale dot/ring proportionally to camera distance for consistent screen size
      const dotDist = camera.position.distanceTo(controls.target);
      const dotScale = Math.max(0.3, dotDist * 0.012);
      targetDot.scale.setScalar(dotScale);
      targetRing.scale.setScalar(dotScale);
      // Hide in walk mode
      targetDot.visible = !walkModeRef.current;
      targetRing.visible = !walkModeRef.current;

      // Adaptive grid: switch resolution based on camera distance
      const camDist = walkModeRef.current ? 5 : camera.position.distanceTo(controls.target);
      if (gridGroup.visible) {
        gridFine.visible = camDist < 10;
        gridMedium.visible = camDist >= 5 && camDist < 60;
        gridCoarse.visible = camDist >= 40;
      }

      renderer.render(scene, camera);

      // Draw overlays
      drawGizmo();
      if (walkModeRef.current) drawMinimap();
    }

    // Cached collision/floor meshes — rebuilt only when layers change (not every frame)
    let cachedArchMeshes: THREE.Mesh[] = [];
    let cachedArchVersion = 0;
    function getArchMeshes(): THREE.Mesh[] {
      // Simple version check: sum of loaded arch layers
      let version = 0;
      Object.entries(layersRef.current).forEach(([key, layer]) => {
        if (ARCH_SPECIALTIES.includes(key) && layer.group && layer.visible) version += layer.group.children.length + 1;
      });
      if (version !== cachedArchVersion) {
        cachedArchMeshes = [];
        Object.entries(layersRef.current).forEach(([key, layer]) => {
          if (!ARCH_SPECIALTIES.includes(key) || !layer.group || !layer.visible) return;
          layer.group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) cachedArchMeshes.push(child as THREE.Mesh);
          });
        });
        cachedArchVersion = version;
      }
      return cachedArchMeshes;
    }

    // Reusable vectors for collision/floor detection (avoid GC pressure)
    const _collisionOrigin = new THREE.Vector3();
    const _collisionDir = new THREE.Vector3();
    const _downVec = new THREE.Vector3(0, -1, 0);

    // Collision check function (uses cached meshes + BVH-accelerated raycast)
    function checkCollisionFn(position: THREE.Vector3, direction: THREE.Vector3): boolean {
      const meshes = getArchMeshes();
      if (meshes.length === 0) return false;

      _collisionOrigin.copy(position);
      _collisionOrigin.y = currentFloorY.current - walkHeightRef.current + COLLISION_HEIGHT_OFFSET;

      _collisionDir.set(direction.x, 0, direction.z).normalize();

      const cr = collisionRaycaster.current;
      cr.set(_collisionOrigin, _collisionDir);
      cr.far = COLLISION_DISTANCE;
      cr.firstHitOnly = true; // BVH optimization: stop at first hit

      const hits = cr.intersectObjects(meshes, false);
      return hits.length > 0;
    }

    animate();

    /* ─── Resize ─── */
    const handleResize = () => {
      if (!el) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    /* ─── Keyboard ─── */
    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.key.toLowerCase());
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      controls.removeEventListener("change", updateClipPlanes);
      controls.removeEventListener("start", showTargetDot);
      if (targetDotFadeTimeout) clearTimeout(targetDotFadeTimeout);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      cancelAnimationFrame(animFrameRef.current);
      renderer.dispose();
      if (el && renderer.domElement.parentNode === el) {
        el.removeChild(renderer.domElement);
      }
    };
  }, []);

  /* ═════════════════════════════════════════════════
     Grid visibility sync
     ═════════════════════════════════════════════════ */
  useEffect(() => {
    if (gridGroupRef.current) gridGroupRef.current.visible = showGrid;
  }, [showGrid]);

  /* ═════════════════════════════════════════════════
     Floor Labels visibility sync
     ═════════════════════════════════════════════════ */
  useEffect(() => {
    if (floorLabelsGroupRef.current) floorLabelsGroupRef.current.visible = showFloorLabels;
  }, [showFloorLabels]);

  /* Lazily create & position floor signs only for floors within model range */
  useEffect(() => {
    const group = floorLabelsGroupRef.current;
    if (!group) return;

    // Calculate model bounding box
    const box = new THREE.Box3();
    let hasVisibleLayer = false;
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.loaded) {
        box.expandByObject(layer.group);
        hasVisibleLayer = true;
      }
    });
    if (!hasVisibleLayer || box.isEmpty()) return;

    // Gather arch meshes for raycasting
    const archMeshes: THREE.Mesh[] = [];
    Object.entries(layersRef.current).forEach(([key, layer]) => {
      if (ARCH_SPECIALTIES.includes(key) && layer.group && layer.loaded) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) archMeshes.push(child as THREE.Mesh);
        });
      }
    });

    // All possible floor levels
    const ALL_FLOORS = [
      { label: "S2", y: -8.0 }, { label: "S1", y: -4.9 }, { label: "PB", y: 0.0 },
      { label: "N1", y: 3.0 }, { label: "N2", y: 5.5 }, { label: "N3", y: 12.9 },
      { label: "N4", y: 16.3 }, { label: "N5", y: 19.6 }, { label: "N6", y: 23.0 },
      { label: "N7", y: 26.4 }, { label: "N8", y: 29.8 }, { label: "N9", y: 33.1 },
      { label: "N10", y: 36.5 }, { label: "N11", y: 39.9 }, { label: "N12", y: 43.2 },
      { label: "N13", y: 46.6 }, { label: "N14", y: 50.0 }, { label: "N15", y: 52.9 },
      { label: "N16", y: 56.6 }, { label: "N17", y: 59.3 }, { label: "N18", y: 63.0 },
      { label: "N19", y: 66.8 }, { label: "N20", y: 70.0 }, { label: "N21", y: 73.5 },
      { label: "AZ", y: 79.9 },
    ];

    // Filter to only floors within model range
    const floorsInRange = ALL_FLOORS.filter(fl => fl.y >= box.min.y - 3 && fl.y <= box.max.y + 3);

    // Check if signs already match (avoid re-creating)
    const existingLabels = new Set<string>();
    group.children.forEach((c) => {
      if ((c as THREE.Mesh).userData?.isFloorLabel) existingLabels.add((c as THREE.Mesh).userData.floorLabel);
    });
    const neededLabels = new Set(floorsInRange.map(f => f.label));
    const alreadyCorrect = existingLabels.size === neededLabels.size && Array.from(neededLabels).every(l => existingLabels.has(l));
    
    if (!alreadyCorrect) {
      // Dispose old signs
      while (group.children.length > 0) {
        const child = group.children[0] as THREE.Mesh;
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          const mat = child.material as THREE.MeshBasicMaterial;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
        group.remove(child);
      }

      // Create 1 sign per floor (lightweight)
      const createWallSign = (fl: { label: string; y: number }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 256;
        const ctx2 = canvas.getContext("2d")!;
        const accentColor = fl.y === 0 ? "#00A89D" : fl.y < 0 ? "#FF6B35" : "#3B82F6";
        ctx2.fillStyle = accentColor;
        ctx2.fillRect(0, 0, 512, 256);
        ctx2.fillStyle = "rgba(0,0,0,0.75)";
        ctx2.fillRect(8, 8, 496, 240);
        ctx2.strokeStyle = "#FFFFFF";
        ctx2.lineWidth = 6;
        ctx2.strokeRect(4, 4, 504, 248);
        ctx2.font = "bold 36px system-ui, -apple-system, sans-serif";
        ctx2.textAlign = "center";
        ctx2.textBaseline = "middle";
        ctx2.fillStyle = accentColor;
        ctx2.fillText("NIVEL", 256, 60);
        ctx2.font = "bold 120px system-ui, -apple-system, sans-serif";
        ctx2.fillStyle = "#FFFFFF";
        ctx2.fillText(fl.label, 256, 170);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        const geo = new THREE.PlaneGeometry(1.5, 0.75);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 500;
        mesh.userData.floorY = fl.y;
        mesh.userData.floorLabel = fl.label;
        mesh.userData.isFloorLabel = true;
        return mesh;
      };

      floorsInRange.forEach((fl) => {
        const sign = createWallSign(fl);
        sign.position.set(0, fl.y + 1.6, 0);
        group.add(sign);
      });
    }

    // Position signs on walls using raycasting
    const centerX = (box.min.x + box.max.x) / 2;
    const centerZ = (box.min.z + box.max.z) / 2;
    const raycaster = new THREE.Raycaster();
    raycaster.far = 200;

    // Try to find a wall to attach each sign
    group.children.forEach((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.userData.isFloorLabel) return;
      const floorY = mesh.userData.floorY as number;
      const signY = floorY + 1.6;
      const offset = 0.08;

      // Try 4 directions from center, pick first wall hit
      const dirs = [
        { dir: new THREE.Vector3(0, 0, -1), rot: 0 },
        { dir: new THREE.Vector3(-1, 0, 0), rot: Math.PI / 2 },
        { dir: new THREE.Vector3(0, 0, 1), rot: Math.PI },
        { dir: new THREE.Vector3(1, 0, 0), rot: -Math.PI / 2 },
      ];

      let placed = false;
      for (const { dir, rot } of dirs) {
        raycaster.set(new THREE.Vector3(centerX, signY, centerZ), dir);
        const hits = raycaster.intersectObjects(archMeshes, false);
        const hit = hits.find(h => h.distance > 1.0);
        if (hit) {
          const p = hit.point.clone();
          p.addScaledVector(dir, -offset);
          p.y = signY;
          mesh.position.copy(p);
          mesh.rotation.set(0, rot, 0);
          placed = true;
          break;
        }
      }

      if (!placed) {
        // Fallback: place at model edge
        mesh.position.set(box.min.x + 1.0, signY, centerZ);
        mesh.rotation.set(0, Math.PI / 2, 0);
      }

      mesh.visible = showFloorLabels;
    });
  }, [layers, showFloorLabels]);

  /* ═══════════════════════════════════════════════════
     Walk Mode mouse look (with angular velocity cap)
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    walkModeRef.current = walkMode;
    const controls = controlsRef.current;
    if (!controls) return;

    if (walkMode) {
      controls.enabled = false;
      const cam = cameraRef.current!;
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      yawRef.current = Math.atan2(dir.x, dir.z);
      pitchRef.current = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      currentFloorY.current = cam.position.y;
      targetPosRef.current.copy(cam.position);
      smoothPosInitialized.current = true;
    } else {
      controls.enabled = true;
    }
  }, [walkMode]);

  useEffect(() => {
    if (!walkMode) return;
    const el = containerRef.current;
    if (!el) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!walkModeRef.current || gyroEnabledRef.current) return;
      if (document.pointerLockElement !== el && !(e.buttons & 1)) return;

      const sens = lookSensitivityRef.current;
      const dx = e.movementX * MOUSE_SENSITIVITY * sens;
      const dy = e.movementY * MOUSE_SENSITIVITY * sens;

      // Cap angular velocity
      const cappedDx = THREE.MathUtils.clamp(dx, -MAX_ANGULAR_VELOCITY * 0.016, MAX_ANGULAR_VELOCITY * 0.016);
      const cappedDy = THREE.MathUtils.clamp(dy, -MAX_ANGULAR_VELOCITY * 0.016, MAX_ANGULAR_VELOCITY * 0.016);

      yawRef.current -= cappedDx;
      pitchRef.current -= cappedDy;
      pitchRef.current = THREE.MathUtils.clamp(pitchRef.current, -Math.PI / 2 + 0.1, Math.PI / 2 - 0.1);

      const cam = cameraRef.current!;
      const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, "YXZ");
      cam.quaternion.setFromEuler(euler);
    };

    const onPointerDown = () => {
      if (walkModeRef.current && !gyroEnabledRef.current && !isMobile && document.pointerLockElement !== el) {
        el.requestPointerLock?.();
      }
    };

    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchLookActive = false;

    const onTouchStart = (e: TouchEvent) => {
      if (!walkModeRef.current || gyroEnabledRef.current) return;
      const touch = e.changedTouches[0];
      if (touch.clientX > el.clientWidth * 0.4) {
        lastTouchX = touch.clientX;
        lastTouchY = touch.clientY;
        touchLookActive = true;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touchLookActive || !walkModeRef.current || gyroEnabledRef.current) return;
      const touch = e.changedTouches[0];
      const sens = lookSensitivityRef.current;
      const dx = (touch.clientX - lastTouchX) * MOUSE_SENSITIVITY * 1.5 * sens;
      const dy = (touch.clientY - lastTouchY) * MOUSE_SENSITIVITY * 1.5 * sens;
      lastTouchX = touch.clientX;
      lastTouchY = touch.clientY;

      yawRef.current -= dx;
      pitchRef.current -= dy;
      pitchRef.current = THREE.MathUtils.clamp(pitchRef.current, -Math.PI / 2 + 0.1, Math.PI / 2 - 0.1);

      const cam = cameraRef.current!;
      const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, "YXZ");
      cam.quaternion.setFromEuler(euler);
    };

    const onTouchEnd = () => {
      touchLookActive = false;
    };

    el.addEventListener("mousemove", onMouseMove);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      if (document.pointerLockElement === el) {
        document.exitPointerLock?.();
      }
    };
  }, [walkMode, isMobile]);

  /* ═══════════════════════════════════════════════════
     Pinch-to-zoom (orbit mode on mobile)
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (walkMode || !isMobile) return;
    const el = containerRef.current;
    if (!el) return;

    // Walk mode: custom pinch for FOV zoom (inmersivo)
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && walkModeRef.current) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartFov.current = cameraRef.current?.fov ?? DEFAULT_FOV;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStartDist.current > 0 && walkModeRef.current) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ratio = pinchStartDist.current / dist;
        const newFov = THREE.MathUtils.clamp(pinchStartFov.current * ratio, MIN_FOV, MAX_FOV);
        const cam = cameraRef.current;
        if (cam) {
          cam.fov = newFov;
          cam.updateProjectionMatrix();
        }
      }
      // In orbit mode: OrbitControls handles pinch dolly natively - NO custom FOV change
    };

    const onTouchEnd = () => {
      pinchStartDist.current = 0;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [walkMode, isMobile]);

  /* ═══════════════════════════════════════════════════
     Recentrar orbital target via raycast (doble-clic/doble-tap)
     ═══════════════════════════════════════════════════ */
  const recentrarOrbitalTarget = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!el || !camera || !controls || walkModeRef.current) return;

    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = rc.intersectObjects(meshes, false);
    if (intersects.length > 0) {
      const hitPoint = intersects[0].point.clone();
      // Animate target smoothly to the hit point
      const startTarget = controls.target.clone();
      const startTime = performance.now();
      const duration = 400; // ms
      const animateTarget = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const ease = 1 - Math.pow(1 - t, 3);
        controls.target.lerpVectors(startTarget, hitPoint, ease);
        controls.update();
        if (t < 1) requestAnimationFrame(animateTarget);
      };
      animateTarget();
    }
  }, []);

  /* ═══════════════════════════════════════════════════
     Double-tap / double-click to recentrar target
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Desktop: double-click
    const onDblClick = (e: MouseEvent) => {
      if (walkModeRef.current) return;
      recentrarOrbitalTarget(e.clientX, e.clientY);
    };

    // Mobile: double-tap
    const onTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return;
      const now = Date.now();
      if (now - lastTapTime.current < 300) {
        if (walkModeRef.current) {
          recenterCamera();
        } else {
          // Recentrar orbital target al punto tocado
          const touch = e.changedTouches[0];
          recentrarOrbitalTarget(touch.clientX, touch.clientY);
        }
        lastTapTime.current = 0;
      } else {
        lastTapTime.current = now;
      }
    };

    el.addEventListener("dblclick", onDblClick);
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [recenterCamera, recentrarOrbitalTarget]);

  /* ═══════════════════════════════════════════════════
     Gyroscope with Complementary Filter
     ═══════════════════════════════════════════════════ */
  const requestGyroPermission = useCallback(async () => {
    const DeviceOrientationEventTyped = DeviceOrientationEvent as any;
    if (typeof DeviceOrientationEventTyped.requestPermission === "function") {
      try {
        const perm = await DeviceOrientationEventTyped.requestPermission();
        if (perm === "granted") {
          setGyroPermission("granted");
          setGyroEnabled(true);
          gyroEnabledRef.current = true;
          gyroInitRef.current = false;
        } else {
          setGyroPermission("denied");
        }
      } catch {
        setGyroPermission("denied");
      }
    } else {
      setGyroPermission("granted");
      setGyroEnabled(true);
      gyroEnabledRef.current = true;
      gyroInitRef.current = false;
    }
  }, []);

  const toggleGyro = useCallback(() => {
    if (!gyroEnabled) {
      if (gyroPermission === "unknown") {
        requestGyroPermission();
      } else if (gyroPermission === "granted") {
        setGyroEnabled(true);
        gyroEnabledRef.current = true;
        gyroInitRef.current = false;
      }
    } else {
      setGyroEnabled(false);
      gyroEnabledRef.current = false;
    }
  }, [gyroEnabled, gyroPermission, requestGyroPermission]);

  useEffect(() => {
    if (!gyroEnabled || !walkMode) {
      gyroEnabledRef.current = false;
      return;
    }
    gyroEnabledRef.current = true;

    // Store initial yaw so gyro offsets are relative to current look direction
    const baseYaw = yawRef.current;
    const basePitch = pitchRef.current;

    const handler = (e: DeviceOrientationEvent) => {
      if (e.alpha === null || e.beta === null || e.gamma === null) return;

      // First reading: capture the device's initial orientation as reference
      if (!gyroInitRef.current) {
        gyroBaseAlpha.current = e.alpha;
        gyroBaseBeta.current = e.beta;
        gyroAlphaFiltered.current = e.alpha;
        gyroBetaFiltered.current = e.beta;
        gyroInitRef.current = true;
        return;
      }

      // Smooth the raw values with a low-pass filter to reduce noise
      const lp = GYRO_FILTER_ALPHA;
      gyroAlphaFiltered.current = lp * gyroAlphaFiltered.current + (1 - lp) * e.alpha;
      gyroBetaFiltered.current = lp * gyroBetaFiltered.current + (1 - lp) * e.beta;

      const sens = gyroSensitivityRef.current;

      // ABSOLUTE offset from initial orientation (no accumulation = no drift)
      // Handle alpha wraparound (0-360)
      let deltaAlpha = gyroAlphaFiltered.current - gyroBaseAlpha.current;
      if (deltaAlpha > 180) deltaAlpha -= 360;
      if (deltaAlpha < -180) deltaAlpha += 360;

      const deltaBeta = gyroAlphaFiltered.current !== null
        ? gyroBetaFiltered.current - gyroBaseBeta.current
        : 0;

      // Apply deadzone on the absolute delta (degrees)
      const yawOffset = Math.abs(deltaAlpha) > GYRO_DEADZONE
        ? (-deltaAlpha * Math.PI / 180) * sens
        : 0;
      const pitchOffset = Math.abs(deltaBeta) > GYRO_DEADZONE
        ? (-deltaBeta * Math.PI / 180) * 0.5 * sens
        : 0;

      // Set absolute orientation = base + offset (no += accumulation)
      yawRef.current = baseYaw + yawOffset;
      pitchRef.current = THREE.MathUtils.clamp(
        basePitch + pitchOffset,
        -Math.PI / 2 + 0.1,
        Math.PI / 2 - 0.1
      );

      const cam = cameraRef.current;
      if (cam) {
        const euler = new THREE.Euler(pitchRef.current, yawRef.current, 0, "YXZ");
        cam.quaternion.setFromEuler(euler);
      }
    };

    window.addEventListener("deviceorientation", handler, true);
    return () => {
      window.removeEventListener("deviceorientation", handler, true);
    };
  }, [gyroEnabled, walkMode]);

  /* ═══════════════════════════════════════════════════
     Mobile Joystick
     ═══════════════════════════════════════════════════ */
  const joystickContainerRef = useRef<HTMLDivElement>(null);
  const joystickInstanceRef = useRef<ReturnType<typeof nipplejs.create> | null>(null);

  useEffect(() => {
    if (!walkMode || !isMobile || !joystickContainerRef.current) {
      if (joystickInstanceRef.current) {
        joystickInstanceRef.current.destroy();
        joystickInstanceRef.current = null;
      }
      joystickMoveRef.current = { x: 0, y: 0 };
      return;
    }

    const manager = nipplejs.create({
      zone: joystickContainerRef.current,
      mode: "static",
      position: { left: "50%", top: "50%" },
      color: BRAND.teal,
      size: 120,
      restOpacity: 0.6,
    });

    manager.on("move", (_evt, data) => {
      if (data.vector) {
        joystickMoveRef.current = { x: data.vector.x, y: data.vector.y };
      }
    });

    manager.on("end", () => {
      joystickMoveRef.current = { x: 0, y: 0 };
    });

    joystickInstanceRef.current = manager;

    return () => {
      manager.destroy();
      joystickInstanceRef.current = null;
      joystickMoveRef.current = { x: 0, y: 0 };
    };
  }, [walkMode, isMobile]);

  /* ═══════════════════════════════════════════════════
     Load GLBs - enhanced material for pipes
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (!files.length || !sceneRef.current) return;

    const initLayers: Record<string, LayerState> = {};
    files.forEach((f) => {
      if (!layersRef.current[f.specialty]) {
        initLayers[f.specialty] = {
          visible: true, loaded: false, loading: false, progress: 0, group: null, edgeGroup: null,
        };
      }
    });
    if (Object.keys(initLayers).length > 0) {
      setLayers((prev) => ({ ...prev, ...initLayers }));
    }

    // Filter out files pending conversion (RVT files without GLB yet)
    const loadableFiles = files.filter((f: any) => f.conversionStatus !== "pending_conversion");

    // Smart loading: small files in parallel, large files sequential
    const LARGE_THRESHOLD = 100 * 1024 * 1024; // 100MB
    const sortedFiles = [...loadableFiles].sort((a, b) => {
      // Structure first (gives immediate visual context)
      const aIsStruct = a.specialty === 'structure';
      const bIsStruct = b.specialty === 'structure';
      if (aIsStruct && !bIsStruct) return -1;
      if (!aIsStruct && bIsStruct) return 1;
      return (a.fileSize || 0) - (b.fileSize || 0);
    });

    let cancelled = false;
    (async () => {
      const notLoaded = (f: any) => !layersRef.current[f.specialty]?.loaded && !layersRef.current[f.specialty]?.loading;

      // Phase 1: Load structure first for immediate context
      const structFile = sortedFiles.find(f => f.specialty === 'structure' && notLoaded(f));
      if (structFile && !cancelled) {
        try { await loadFile(structFile); } catch (err) { console.error(`[Load] Failed structure:`, err); }
        await new Promise(r => setTimeout(r, 50));
      }

      // Phase 2: Load all small files (<100MB) in parallel batches of 3
      const smallFiles = sortedFiles.filter(f => f !== structFile && (f.fileSize || 0) < LARGE_THRESHOLD && notLoaded(f));
      for (let i = 0; i < smallFiles.length; i += 3) {
        if (cancelled) break;
        const batch = smallFiles.slice(i, i + 3).filter(notLoaded);
        await Promise.allSettled(batch.map(f => loadFile(f).catch(err => console.error(`[Load] Failed ${f.specialty}:`, err))));
        await new Promise(r => setTimeout(r, 50));
      }

      // Phase 3: Load large files (>100MB) — if they have gzip versions (<30MB compressed),
      // load them in parallel since the download is fast. Otherwise sequential.
      const largeFiles = sortedFiles.filter(f => (f.fileSize || 0) >= LARGE_THRESHOLD && notLoaded(f));
      const gzLargeFiles = largeFiles.filter(f => !!(f as any).gzFileKey);
      const rawLargeFiles = largeFiles.filter(f => !(f as any).gzFileKey);

      // Gzipped large files can load in parallel (25MB + 11MB = 36MB total download)
      if (gzLargeFiles.length > 0 && !cancelled) {
        console.log(`[Load] Phase 3a: ${gzLargeFiles.length} gzipped large files in parallel`);
        await Promise.allSettled(
          gzLargeFiles.filter(notLoaded).map(f =>
            loadFile(f).catch(err => console.error(`[Load] Failed ${f.specialty}:`, err))
          )
        );
        await new Promise(r => setTimeout(r, 100));
      }

      // Non-gzipped large files still load sequentially
      for (const file of rawLargeFiles) {
        if (cancelled) break;
        if (!notLoaded(file)) continue;
        try { await loadFile(file); } catch (err) { console.error(`[Load] Failed ${file.specialty}:`, err); }
        await new Promise(r => setTimeout(r, 300));
      }
    })();

    return () => { cancelled = true; };
  }, [files]);

  /* Helper: parse GLB buffer into Three.js Group + EdgeGroup */
  // Persistent DRACOLoader with Web Worker pool (reused across all file loads)
  const dracoLoaderRef = useRef<InstanceType<typeof DRACOLoader> | null>(null);
  const getDracoLoader = useCallback(() => {
    if (!dracoLoaderRef.current) {
      dracoLoaderRef.current = new DRACOLoader();
      dracoLoaderRef.current.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
      // WASM decoder is 3-5x faster than the JS fallback for the large
      // compressed MEP models (800-900MB). Spread decoding across a worker
      // pool sized to the device so the main thread never stalls.
      dracoLoaderRef.current.setDecoderConfig({ type: "wasm" });
      const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
      dracoLoaderRef.current.setWorkerLimit(Math.min(Math.max(cores - 1, 2), 8));
      dracoLoaderRef.current.preload(); // Pre-download decoder WASM
    }
    return dracoLoaderRef.current;
  }, []);

  const parseGLBToGroups = useCallback(async (buffer: ArrayBuffer, file: (typeof files)[0]): Promise<{ group: THREE.Group; edgeGroup: THREE.Group }> => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDracoLoader());
    // Support meshopt-compressed GLBs (lossless MEP pipeline)
    const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder);

    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(buffer, "", resolve, reject);
    });

    // Yield to main thread after heavy parse
    await new Promise(r => setTimeout(r, 0));

    // Force computation of matrixWorld for all nodes (critical for models
    // where root transforms are on intermediate nodes, e.g. sanitary)
    gltf.scene.updateMatrixWorld(true);

    const group = new THREE.Group();
    group.name = file.specialty;
    const edgeGroup = new THREE.Group();
    edgeGroup.name = `${file.specialty}_edges`;

    const isTransparent = file.transparent === 1;
    const opacity = file.opacity / 100;
    const isPipe = PIPE_SPECIALTIES.includes(file.specialty);

    // Collect regular meshes and InstancedMesh objects separately
    const meshes: THREE.Mesh[] = [];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    gltf.scene.traverse((child: THREE.Object3D) => {
      if ((child as any).isInstancedMesh) {
        instancedMeshes.push(child as THREE.InstancedMesh);
      } else if ((child as THREE.Mesh).isMesh) {
        meshes.push(child as THREE.Mesh);
      }
    });
    const isLargeModel = (file.fileSize || 0) > 50 * 1024 * 1024;
    const parseStart = performance.now();
    console.log(`[Parse] ${file.specialty}: ${meshes.length} meshes + ${instancedMeshes.length} instanced meshes${isLargeModel ? ' (LARGE — INSTANT path)' : ''}`);

    /* ========================================================================
     * ULTRA-FAST PATH for large models (>50MB): merge ALL geometries into
     * a small number of merged meshes (~1-4) instead of 2000+ individual meshes.
     * This reduces draw calls from 2000+ to ~1-4 and eliminates per-mesh overhead.
     * Raycasting still works because Three.js raycasts against the merged geometry.
     * ======================================================================== */
    if (isLargeModel) {
      const { mergeGeometries } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");

      // Single shared material
      const sharedMat = isPipe
        ? new THREE.MeshStandardMaterial({
            color: new THREE.Color(file.color),
            transparent: isTransparent,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: true,
            metalness: 0.35,
            roughness: 0.35,
            flatShading: false,
            envMapIntensity: 0.8,
          })
        : new THREE.MeshStandardMaterial({
            color: new THREE.Color(file.color),
            transparent: isTransparent,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: !isTransparent,
            roughness: 0.7,
            metalness: 0.0,
            envMapIntensity: isTransparent ? 0.3 : 0.5,
          });

      // Bake world transforms into geometry positions (required for merge)
      // Process in chunks of 2000 to allow occasional yield
      const MERGE_CHUNK = 2000;
      const preparedGeos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        const geo = mesh.geometry.clone();
        // Apply world matrix to geometry so all positions are in world space
        geo.applyMatrix4(mesh.matrixWorld);
        // Ensure geometry only has position attribute (strip uv, normal if missing)
        // Keep position + normal (if present) for correct lighting
        if (!geo.attributes.position) continue;
        preparedGeos.push(geo);
        // Yield every MERGE_CHUNK meshes to prevent page freeze
        if (i > 0 && i % MERGE_CHUNK === 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // Merge all geometries into batches of ~5000 to stay within GPU buffer limits
      const MAX_VERTS_PER_MERGE = 5_000_000; // ~5M vertices per merged mesh
      let currentBatch: THREE.BufferGeometry[] = [];
      let currentVerts = 0;
      let mergedCount = 0;

      const flushBatch = () => {
        if (currentBatch.length === 0) return;
        try {
          const merged = mergeGeometries(currentBatch, false);
          if (merged) {
            // Source GLB geometries already carry normals, and
            // BufferGeometry.applyMatrix4 transforms them correctly, so
            // mergeGeometries preserves valid normals. Recomputing them on a
            // multi-million-vertex buffer is the single biggest main-thread
            // freeze ("no responde") when loading the 800-900MB models —
            // only do it when normals are genuinely missing.
            if (!merged.attributes.normal) merged.computeVertexNormals();
            const mergedMesh = new THREE.Mesh(merged, sharedMat);
            mergedMesh.matrixAutoUpdate = false;
            mergedMesh.name = `${file.specialty}_merged_${mergedCount}`;
            mergedMesh.castShadow = false;
            mergedMesh.receiveShadow = false;
            mergedMesh.userData = { specialty: file.label, fileSpecialty: file.specialty, elementType: "mep", fileId: file.id, meshIndex: mergedCount, merged: true };
            group.add(mergedMesh);
            mergedCount++;
          }
        } catch (e) {
          console.warn(`[Parse] ${file.specialty}: merge batch failed, adding individually`, e);
          // Fallback: add individually
          for (const geo of currentBatch) {
            const m = new THREE.Mesh(geo, sharedMat);
            m.matrixAutoUpdate = false;
            m.userData = { specialty: file.label, fileSpecialty: file.specialty, elementType: "mep", fileId: file.id };
            group.add(m);
          }
        }
        currentBatch = [];
        currentVerts = 0;
      };

      for (const geo of preparedGeos) {
        const verts = geo.attributes.position.count;
        if (currentVerts + verts > MAX_VERTS_PER_MERGE && currentBatch.length > 0) {
          flushBatch();
          await new Promise(r => setTimeout(r, 0)); // yield between merges
        }
        currentBatch.push(geo);
        currentVerts += verts;
      }
      flushBatch(); // flush remaining

      // Process InstancedMesh objects for large models
      for (const im of instancedMeshes) {
        const newIM = new THREE.InstancedMesh(im.geometry, sharedMat, im.count);
        newIM.instanceMatrix.copy(im.instanceMatrix);
        if (im.instanceColor) newIM.instanceColor = im.instanceColor;
        newIM.matrixAutoUpdate = false;
        newIM.matrix.copy(im.matrixWorld);
        newIM.name = im.name || "";
        newIM.userData = { specialty: file.label, fileSpecialty: file.specialty, elementType: "instanced", fileId: file.id };
        newIM.castShadow = false;
        newIM.receiveShadow = false;
        group.add(newIM);
      }

      const elapsed = performance.now() - parseStart;
      console.log(`[Parse] ${file.specialty}: INSTANT path done in ${elapsed.toFixed(0)}ms — ${meshes.length} meshes → ${mergedCount} merged + ${instancedMeshes.length} instanced (${group.children.length} total draw calls)`);

    } else {
      /* ================================================================
       * STANDARD PATH for normal-sized models (<50MB)
       * Individual meshes with full classification, edges, BVH, etc.
       * ================================================================ */
      const BATCH_SIZE = 50;

      for (let batchStart = 0; batchStart < meshes.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, meshes.length);
        for (let mi = batchStart; mi < batchEnd; mi++) {
          const mesh = meshes[mi];
          const geo = mesh.geometry;

          if (isPipe) {
            geo.computeVertexNormals();
            if (!geo.index) geo.computeVertexNormals();
          }

          let mat: THREE.Material;
          if (isPipe) {
            mat = new THREE.MeshStandardMaterial({
              color: new THREE.Color(file.color),
              transparent: isTransparent,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: true,
              metalness: 0.35,
              roughness: 0.35,
              flatShading: false,
              polygonOffset: false,
              envMapIntensity: 0.8,
            });
          } else {
            const isWallLike = /wall|muro|pared/i.test(mesh.name || "");
            const isSlabLike = /slab|losa|piso|floor|entrepiso/i.test(mesh.name || "");
            const isColumnLike = /column|columna|pilar/i.test(mesh.name || "");
            mat = new THREE.MeshStandardMaterial({
              color: new THREE.Color(file.color),
              transparent: isTransparent,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: !isTransparent,
              roughness: isWallLike ? 0.85 : isSlabLike ? 0.9 : isColumnLike ? 0.75 : 0.7,
              metalness: isColumnLike ? 0.05 : 0.0,
              envMapIntensity: isTransparent ? 0.3 : 0.5,
            });
          }

          const newMesh = new THREE.Mesh(geo, mat);
          newMesh.matrixAutoUpdate = false;
          newMesh.matrix.copy(mesh.matrixWorld);
          newMesh.name = mesh.name || "";
          newMesh.castShadow = true;
          newMesh.receiveShadow = true;
          if (geo.attributes.position) {
            try { (geo as any).computeBoundsTree(); } catch { /* non-critical */ }
          }

          // Classify element type
          const meshName = (mesh.name || "").toLowerCase();
          let elementType = "other";
          if (/wall|muro|pared|ifcwall/i.test(meshName)) elementType = "wall";
          else if (/slab|losa|piso|floor|ifcslab|entrepiso/i.test(meshName)) elementType = "slab";
          else if (/beam|viga|ifcbeam|trabe/i.test(meshName)) elementType = "beam";
          else if (/column|columna|ifccolumn|pilar/i.test(meshName)) elementType = "column";
          else if (/door|puerta|ifcdoor/i.test(meshName)) elementType = "door";
          else if (/window|ventana|ifcwindow/i.test(meshName)) elementType = "window";
          else if (/stair|escalera|ifcstair/i.test(meshName)) elementType = "stair";
          else if (/roof|techo|cubierta|ifcroof/i.test(meshName)) elementType = "roof";
          else if (/pipe|tubo|tuberia|duct|ducto|ifcpipe|ifcduct|ifcflow/i.test(meshName)) elementType = "mep";
          else if (/furnish|furniture|mueble|mobiliario|ifcfurnish/i.test(meshName)) elementType = "furniture";
          else if (/railing|baranda|ifcrailing/i.test(meshName)) elementType = "railing";
          else {
            const bbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
            bbox.applyMatrix4(mesh.matrixWorld);
            const size = bbox.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const minDim = Math.min(size.x, size.y, size.z);
            if (maxDim > 0.01) {
              const flatness = minDim / maxDim;
              if (flatness < 0.05 && size.y === minDim && size.x > 1 && size.z > 1) elementType = "slab";
              else if (flatness < 0.1 && size.y > 1.5 && (size.x > 1 || size.z > 1)) elementType = "wall";
              else if (size.y > 1.5 && size.x < 1 && size.z < 1) elementType = "column";
              else if (size.y < 0.8 && (size.x > 2 || size.z > 2) && flatness < 0.15) elementType = "beam";
            }
          }

          newMesh.userData = { specialty: file.label, fileSpecialty: file.specialty, elementType, fileId: file.id, meshIndex: mi };
          group.add(newMesh);

          const edgeAngle = isPipe ? 60 : 25;
          const edges = new THREE.EdgesGeometry(geo, edgeAngle);
          const lineMat = new THREE.LineBasicMaterial({
            color: isPipe ? new THREE.Color(file.color).multiplyScalar(0.6).getHex() : 0x999999,
            transparent: true,
            opacity: isPipe ? 0.15 : 0.3,
          });
          const lineSegments = new THREE.LineSegments(edges, lineMat);
          lineSegments.matrixAutoUpdate = false;
          lineSegments.matrix.copy(mesh.matrixWorld);
          edgeGroup.add(lineSegments);
        } // end inner for (mi)
        if (batchEnd < meshes.length) {
          await new Promise(r => setTimeout(r, 0));
        }
      } // end outer for (batchStart)

      // Process InstancedMesh objects
      for (const im of instancedMeshes) {
        const mat = isPipe
          ? new THREE.MeshStandardMaterial({
              color: new THREE.Color(file.color),
              transparent: isTransparent,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: true,
              metalness: 0.35,
              roughness: 0.35,
              flatShading: false,
              envMapIntensity: 0.8,
            })
          : new THREE.MeshStandardMaterial({
              color: new THREE.Color(file.color),
              transparent: isTransparent,
              opacity,
              side: THREE.DoubleSide,
              depthWrite: !isTransparent,
              roughness: 0.7,
              metalness: 0.0,
              envMapIntensity: isTransparent ? 0.3 : 0.5,
            });

        const newIM = new THREE.InstancedMesh(im.geometry, mat, im.count);
        newIM.instanceMatrix.copy(im.instanceMatrix);
        if (im.instanceColor) newIM.instanceColor = im.instanceColor;
        newIM.matrixAutoUpdate = false;
        newIM.matrix.copy(im.matrixWorld);
        newIM.name = im.name || "";
        newIM.userData = { specialty: file.label, fileSpecialty: file.specialty, elementType: "instanced", fileId: file.id };
        newIM.castShadow = false;
        newIM.receiveShadow = false;
        group.add(newIM);
      }
      if (instancedMeshes.length > 0) {
        console.log(`[Instanced] ${file.specialty}: added ${instancedMeshes.length} InstancedMesh objects to group`);
      }
    } // end if/else isLargeModel

    return { group, edgeGroup };
  }, [getDracoLoader]);

  /* Helper: apply per-model transform from DB (rotation, position, scale) */
  const applyModelTransform = useCallback((group: THREE.Group, edgeGroup: THREE.Group, file: (typeof files)[0]) => {
    const rotX = (file as any).rotX || 0;
    const rotY = (file as any).rotY || 0;
    const rotZ = (file as any).rotZ || 0;
    const posX = (file as any).posX || 0;
    const posY = (file as any).posY || 0;
    const posZ = (file as any).posZ || 0;
    const scale = (file as any).modelScale || 1;

    // Skip if no transform needed
    if (rotX === 0 && rotY === 0 && rotZ === 0 && posX === 0 && posY === 0 && posZ === 0 && scale === 1) return;

    // Create a wrapper group to apply transform without affecting internal mesh positions
    // Order: scale → rotate → translate
    const applyTo = (g: THREE.Group) => {
      if (scale !== 1) g.scale.set(scale, scale, scale);
      if (rotX !== 0) g.rotateX(rotX * Math.PI / 180); // degrees to radians
      if (rotY !== 0) g.rotateY(rotY * Math.PI / 180);
      if (rotZ !== 0) g.rotateZ(rotZ * Math.PI / 180);
      // Position offset is applied AFTER rotation/scale
      g.position.set(
        g.position.x + posX,
        g.position.y + posY,
        g.position.z + posZ
      );
    };
    applyTo(group);
    applyTo(edgeGroup);
    console.log(`[Transform] ${file.specialty}: rot=[${rotX},${rotY},${rotZ}] pos=[${posX},${posY},${posZ}] scale=${scale}`);
  }, []);

  const loadFile = useCallback(async (file: (typeof files)[0]) => {
    const scene = sceneRef.current;
    if (!scene) return;

    const downloadStart = performance.now();
    setLayers((prev) => ({
      ...prev,
      [file.specialty]: { ...(prev[file.specialty] ?? { visible: true, loaded: false, loading: false, progress: 0, group: null, edgeGroup: null }), loading: true, fromCache: false, downloadStartTime: downloadStart, bytesLoaded: 0, bytesTotal: (file as any).fileSize || 0, etaSeconds: undefined, speedBps: undefined },
    }));

    const hasLOD = !!(file as any).lodUrl;
    // Resolve permanent CloudFront URL from fileKey (stable, no expiry)
    let resolvedUrl = file.url;
    let gzResolvedUrl: string | null = null;
    if ((file as any).fileKey) {
      try {
        const result = await trpcUtils.storage.getFileUrl.fetch({ fileKey: (file as any).fileKey });
        resolvedUrl = result.url;
      } catch (e) {
        console.warn(`[GLB] ${file.specialty}: Failed to resolve URL from fileKey, using stored URL`, e);
      }
    }
    // If gzFileKey exists, resolve its URL for faster download (85-94% smaller)
    if ((file as any).gzFileKey) {
      try {
        const gzResult = await trpcUtils.storage.getFileUrl.fetch({ fileKey: (file as any).gzFileKey });
        gzResolvedUrl = gzResult.url;
        const origMB = ((file as any).fileSize || 0) / (1024 * 1024);
        console.log(`[GLB] ${file.specialty}: Using pre-gzipped version (${origMB.toFixed(0)}MB → compressed) for faster download`);
      } catch (e) {
        console.warn(`[GLB] ${file.specialty}: Failed to resolve gzFileKey, falling back to original`, e);
      }
    }
    // Prefer gzipped URL (browser auto-decompresses via Content-Encoding: gzip)
    const downloadUrl = gzResolvedUrl || resolvedUrl;
    const proxyUrl = `/api/proxy-glb?url=${encodeURIComponent(downloadUrl)}`;
    const lodProxyUrl = hasLOD ? `/api/proxy-glb?url=${encodeURIComponent((file as any).lodUrl)}` : null;

    try {
      const startTime = performance.now();
      let wasCached = false;

      // ── STEP 1: If LOD exists and full-res is NOT cached, load LOD first ──
      let usedLOD = false;
      if (lodProxyUrl) {
        const cacheKeyFull = (file as any).fileKey || proxyUrl;
        const fullResCacheCheck = await isCached(cacheKeyFull);
        if (!fullResCacheCheck.cached) {
          // Load LOD for instant preview
          try {
            const lodCacheKey = ((file as any).fileKey || '') + '_lod';
            const { buffer: lodBuffer, fromCache: lodFromCache } = await fetchGLBWithCache(
              lodCacheKey,
              lodProxyUrl,
              (loaded, total) => {
                const pct = total > 0 ? Math.round((loaded / total) * 50) : 0; // LOD = 0-50%
                setLayers((prev) => ({
                  ...prev,
                  [file.specialty]: { ...(prev[file.specialty] ?? { visible: true, loaded: false, loading: true, progress: 0, group: null, edgeGroup: null }), progress: pct, fromCache: lodFromCache },
                }));
              }
            );

            const lodTime = performance.now() - startTime;
            console.log(`[GLB-LOD] ${file.specialty}: ${lodFromCache ? "CACHE" : "NETWORK"} in ${lodTime.toFixed(0)}ms (${(lodBuffer.byteLength / 1024 / 1024).toFixed(1)}MB)`);

            const { group, edgeGroup } = await parseGLBToGroups(lodBuffer, file);
            group.userData.isLOD = true;

            // Apply per-model transform from DB (rotation, position, scale)
            applyModelTransform(group, edgeGroup, file);

            // Apply coordinate offset to LOD model (additive on top of model transform)
            if (coordsAppliedRef.current) {
              const c = coordsRef.current;
              group.position.x += c.x;
              group.position.y += c.z;
              group.position.z += c.y;
              edgeGroup.position.x += c.x;
              edgeGroup.position.y += c.z;
              edgeGroup.position.z += c.y;
            }

            scene.add(group);
            scene.add(edgeGroup);

            if (!firstFitDone.current) {
              firstFitDone.current = true;
              const box = new THREE.Box3().setFromObject(group);
              if (!box.isEmpty()) {
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                if (cameraRef.current && controlsRef.current) {
                  cameraRef.current.position.set(
                    center.x + maxDim * 0.7,
                    center.y + maxDim * 0.5,
                    center.z + maxDim * 0.7
                  );
                  controlsRef.current.target.copy(center);
                  controlsRef.current.update();
                }
                setModelBounds({ min: Math.floor(box.min.y - 5), max: Math.ceil(box.max.y + 5) });
                setClippingHeight(Math.ceil(box.max.y + 5));
              }
            }

            // Mark as loaded with LOD (user can interact immediately)
            setLayers((prev) => ({
              ...prev,
              [file.specialty]: {
                ...(prev[file.specialty] ?? {}),
                loaded: true,
                loading: false,
                progress: 50,
                group,
                edgeGroup: file.showEdges === 1 ? edgeGroup : null,
                visible: true,
                fromCache: lodFromCache,
                lodLoaded: true,
                fullResLoading: true,
              },
            }));
            usedLOD = true;
          } catch (lodErr) {
            console.warn(`[GLB-LOD] ${file.specialty}: LOD load failed, falling back to full-res`, lodErr);
          }
        }
      }

      // ── STEP 2: Load full-res (either as primary or as background upgrade) ──
      // For gzip files, the browser auto-decompresses so Content-Length is unreliable.
      // Use the decompressed buffer size (= original fileSize) for accurate progress.
      const isGzDownload = !!gzResolvedUrl;
      const originalFileSize = (file as any).fileSize || 0;
      const cacheKeyMain = (file as any).fileKey || proxyUrl;
      const { buffer, fromCache } = await fetchGLBWithCache(
        cacheKeyMain,
        proxyUrl,
        (loaded, total) => {
          // For gzip: 'loaded' is decompressed bytes, 'total' may be 0 or compressed size.
          // Use originalFileSize as the reference total for accurate progress.
          const effectiveTotal = isGzDownload ? (originalFileSize || loaded) : (total || originalFileSize || loaded);
          const elapsed = (performance.now() - downloadStart) / 1000;
          const speedBps = elapsed > 0.5 ? loaded / elapsed : 0;
          const remaining = effectiveTotal > loaded ? effectiveTotal - loaded : 0;
          const etaSeconds = speedBps > 0 ? Math.ceil(remaining / speedBps) : undefined;
          if (!usedLOD) {
            const pct = effectiveTotal > 0 ? Math.min(99, Math.round((loaded / effectiveTotal) * 100)) : 0;
            setLayers((prev) => ({
              ...prev,
              [file.specialty]: { ...(prev[file.specialty] ?? { visible: true, loaded: false, loading: true, progress: 0, group: null, edgeGroup: null }), progress: pct, fromCache: false, bytesLoaded: loaded, bytesTotal: effectiveTotal, etaSeconds, speedBps },
            }));
          } else {
            const pct = effectiveTotal > 0 ? 50 + Math.min(49, Math.round((loaded / effectiveTotal) * 50)) : 50;
            setLayers((prev) => ({
              ...prev,
              [file.specialty]: { ...(prev[file.specialty] ?? {}), progress: pct, fullResLoading: true, bytesLoaded: loaded, bytesTotal: effectiveTotal, etaSeconds, speedBps },
            }));
          }
        }
      );
      wasCached = fromCache;

      const loadTime = performance.now() - startTime;
      console.log(`[GLB] ${file.specialty}: ${fromCache ? "CACHE" : "NETWORK"} in ${loadTime.toFixed(0)}ms (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`);

      const { group: fullGroup, edgeGroup: fullEdgeGroup } = await parseGLBToGroups(buffer, file);

      // If LOD was loaded, swap it out
      if (usedLOD) {
        const currentLayer = layersRef.current[file.specialty];
        if (currentLayer?.group) {
          scene.remove(currentLayer.group);
          currentLayer.group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              (child as THREE.Mesh).geometry.dispose();
              const mat = (child as THREE.Mesh).material;
              if (Array.isArray(mat)) mat.forEach(m => m.dispose());
              else mat.dispose();
            }
          });
        }
        if (currentLayer?.edgeGroup) {
          scene.remove(currentLayer.edgeGroup);
        }
        console.log(`[GLB-LOD→FULL] ${file.specialty}: Swapped LOD → full-res`);
      }

      // Apply per-model transform from DB (rotation, position, scale)
      applyModelTransform(fullGroup, fullEdgeGroup, file);

      // Log bounding box after transform for alignment verification
      {
        const _bb = new THREE.Box3().setFromObject(fullGroup);
        if (!_bb.isEmpty()) {
          const _sz = _bb.getSize(new THREE.Vector3());
          console.log(`[BBox] ${file.specialty}: min=[${_bb.min.x.toFixed(1)},${_bb.min.y.toFixed(1)},${_bb.min.z.toFixed(1)}] max=[${_bb.max.x.toFixed(1)},${_bb.max.y.toFixed(1)},${_bb.max.z.toFixed(1)}] size=[${_sz.x.toFixed(1)},${_sz.y.toFixed(1)},${_sz.z.toFixed(1)}]`);
        }
      }

      // Apply current coordinate offset to newly loaded model (additive on top of model transform)
      if (coordsAppliedRef.current) {
        const c = coordsRef.current;
        fullGroup.position.x += c.x;
        fullGroup.position.y += c.z;
        fullGroup.position.z += c.y;
        fullEdgeGroup.position.x += c.x;
        fullEdgeGroup.position.y += c.z;
        fullEdgeGroup.position.z += c.y;
      }

      scene.add(fullGroup);
      scene.add(fullEdgeGroup);

      if (!firstFitDone.current) {
        firstFitDone.current = true;
        const box = new THREE.Box3().setFromObject(fullGroup);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          if (cameraRef.current && controlsRef.current) {
            cameraRef.current.position.set(
              center.x + maxDim * 0.7,
              center.y + maxDim * 0.5,
              center.z + maxDim * 0.7
            );
            controlsRef.current.target.copy(center);
            controlsRef.current.update();
          }
          setModelBounds({ min: Math.floor(box.min.y - 5), max: Math.ceil(box.max.y + 5) });
          setClippingHeight(Math.ceil(box.max.y + 5));
        }
      }

      setLayers((prev) => ({
        ...prev,
        [file.specialty]: {
          ...(prev[file.specialty] ?? {}),
          loaded: true,
          loading: false,
          progress: 100,
          group: fullGroup,
          edgeGroup: file.showEdges === 1 ? fullEdgeGroup : null,
          visible: true,
          fromCache,
          lodLoaded: false,
          fullResLoading: false,
        },
      }));
    } catch (error) {
      console.error(`Error loading ${file.specialty}:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      toast.error(`Error cargando ${file.label || file.specialty}`, {
        description: errMsg.includes("abort") ? "Timeout — archivo muy grande. Intente con WiFi." : errMsg,
        duration: 8000,
      });
      setLayers((prev) => ({
        ...prev,
        [file.specialty]: {
          ...(prev[file.specialty] ?? { visible: true, loaded: false, loading: false, progress: 0, group: null, edgeGroup: null }),
          loading: false,
          fullResLoading: false,
          // Mark as failed so user can retry
          loadError: errMsg,
        } as any,
      }));
    }
  }, [parseGLBToGroups]);

  /* ═══════════════════════════════════════════════════
     Restore Inspection Marks from DB
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const marks = inspectionMarksQuery.data;
    if (!marks || marks.length === 0) return;

    // For each loaded layer, find meshes that match saved marks and paint them green
    let restoredCount = 0;
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group || !layer.loaded) return;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const meshFileId = mesh.userData.fileId ?? 0;
        const meshName = mesh.name || `mesh_${mesh.userData.meshIndex ?? 0}`;
        const meshIndex = mesh.userData.meshIndex ?? 0;

        // Skip if this mesh is already painted
        if (paintedMeshesRef.current.has(mesh.uuid)) return;

        // Check if this mesh matches any saved mark
        const match = marks.find(
          (m: any) => m.fileId === meshFileId && m.meshName === meshName && m.meshIndex === meshIndex
        );
        if (match) {
          // Paint green
          if (!mesh.userData._originalMaterial) {
            mesh.userData._originalMaterial = mesh.material;
          }
          const greenMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(BRAND.teal).getHex(),
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            roughness: 0.4,
            metalness: 0.1,
          });
          mesh.material = greenMat;
          paintedMeshesRef.current.set(mesh.uuid, {
            fileId: meshFileId,
            meshName,
            meshIndex,
          });
          restoredCount++;
        }
      });
    });

    if (restoredCount > 0) {
      setPaintedCount(paintedMeshesRef.current.size);
      console.log(`[Avance] Restored ${restoredCount} inspection marks from DB`);
    }
  }, [inspectionMarksQuery.data, layers]);

  /* ═══════════════════════════════════════════════════
     Annotation Sprite Factory (moved up for DB restore)
     ═══════════════════════════════════════════════════ */
  const createAnnotationSprite = useCallback((text: string, position: THREE.Vector3, category: AnnotationCategory = "observacion", resolved = false): THREE.Sprite => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 148;
    const ctx = canvas.getContext('2d')!;

    const catColor = ANNOTATION_COLORS[category];
    const alpha = resolved ? 0.5 : 1.0;

    // Category color strip at top
    ctx.fillStyle = catColor;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(0, 0, 512, 24, [12, 12, 0, 0]);
    ctx.fill();
    // Category label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ANNOTATION_LABELS[category].toUpperCase(), 256, 12);

    // Pin background
    ctx.fillStyle = resolved ? '#6B7280' : BRAND.navy;
    ctx.beginPath();
    ctx.roundRect(0, 24, 512, 96, [0, 0, 12, 12]);
    ctx.fill();
    // Pin arrow
    ctx.beginPath();
    ctx.moveTo(240, 120);
    ctx.lineTo(256, 148);
    ctx.lineTo(272, 120);
    ctx.fill();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxChars = 40;
    const displayText = text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
    ctx.fillText(displayText, 256, 72);

    // Resolved strike-through
    if (resolved) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(56, 72);
      ctx.lineTo(456, 72);
      ctx.stroke();
    }

    ctx.globalAlpha = 1.0;
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, opacity: alpha });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.copy(position);
    sprite.position.y += 0.5;
    sprite.scale.set(3, 0.85, 1);
    sprite.renderOrder = 900;
    return sprite;
  }, []);

  /* ═══════════════════════════════════════════════════
     Restore Annotations from DB
     ═══════════════════════════════════════════════════ */
  const dbAnnotationsLoaded = useRef(false);
  useEffect(() => {
    const dbAnns = annotations3dQuery.data;
    if (!dbAnns || dbAnns.length === 0 || dbAnnotationsLoaded.current) return;
    const scene = sceneRef.current;
    if (!scene) return;

    dbAnnotationsLoaded.current = true;
    const restored: Annotation[] = [];

    for (const dbAnn of dbAnns) {
      const pos = new THREE.Vector3(dbAnn.posX, dbAnn.posY, dbAnn.posZ);
      const cat = (dbAnn.category || "observacion") as AnnotationCategory;
      const resolved = dbAnn.resolved === 1;
      const sprite = createAnnotationSprite(dbAnn.text, pos, cat, resolved);
      scene.add(sprite);

      // Pin marker sphere
      const pinGeo = new THREE.SphereGeometry(0.12, 16, 16);
      const pinMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLORS[cat]).getHex(), depthTest: false });
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.copy(pos);
      pin.renderOrder = 901;
      scene.add(pin);

      restored.push({
        id: `db-${dbAnn.id}`,
        dbId: dbAnn.id,
        position: pos,
        text: dbAnn.text,
        specialty: "general",
        category: cat,
        floorLabel: dbAnn.floorLabel ?? undefined,
        resolved,
        timestamp: new Date(dbAnn.createdAt).getTime(),
        sprite,
      });
    }

    if (restored.length > 0) {
      setAnnotations(prev => [...prev, ...restored]);
      console.log(`[Annotations] Restored ${restored.length} annotations from DB`);
    }
  }, [annotations3dQuery.data, createAnnotationSprite]);

  /* ═══════════════════════════════════════════════════
     Toggle Layer Visibility
     ═══════════════════════════════════════════════════ */
  const toggleLayer = useCallback((key: string) => {
    setLayers((prev) => {
      const layer = prev[key];
      if (!layer?.loaded || !layer.group) return prev;
      const newVis = !layer.visible;
      layer.group.visible = newVis;
      if (layer.edgeGroup) layer.edgeGroup.visible = newVis;
      return { ...prev, [key]: { ...layer, visible: newVis } };
    });
  }, []);

  /* ═══════════════════════════════════════════════════
     Apply Coordinate Offset
     ═══════════════════════════════════════════════════ */
  const applyCoords = useCallback(() => {
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group) layer.group.position.set(coords.x, coords.z, coords.y);
      if (layer.edgeGroup) layer.edgeGroup.position.set(coords.x, coords.z, coords.y);
    });
    setCoordsApplied(true);
    // Persist coords to localStorage for reload survival
    try {
      localStorage.setItem(`project-coords-${projectId}`, JSON.stringify(coords));
    } catch { /* quota exceeded */ }
  }, [coords, projectId]);

  const resetCoords = useCallback(() => {
    setCoords({ x: 0, y: 0, z: 0 });
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group) layer.group.position.set(0, 0, 0);
      if (layer.edgeGroup) layer.edgeGroup.position.set(0, 0, 0);
    });
    setCoordsApplied(false);
    try {
      localStorage.removeItem(`project-coords-${projectId}`);
    } catch { /* ignore */ }
  }, [projectId]);

  /* ═══════════════════════════════════════════════════
     Fit Camera
     ═══════════════════════════════════════════════════ */
  const fitAll = useCallback(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls || walkMode) return;

    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.5, center.z + maxDim * 0.7);
    camera.fov = DEFAULT_FOV;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }, [walkMode]);

  /* ═══════════════════════════════════════════════════
     Enter Walk Mode
     ═══════════════════════════════════════════════════ */
  const enterWalkMode = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;

    // Calcular el centro del modelo y posicionar la cámara dentro a nivel de piso
    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });

    camera.fov = 80; // Wider FOV for immersive walk-through (Revit-like)
    camera.near = 0.05;
    camera.far = 2000;
    camera.updateProjectionMatrix();

    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const baseY = box.min.y;
      // Posicionar en una esquina del modelo (no en el centro) para mejor orientación
      // Esto permite ver las etiquetas de piso y tener referencia espacial inmediata
      const edgeX = box.min.x + size.x * 0.15; // Near the left edge
      const edgeZ = box.min.z + size.z * 0.15; // Near the front edge
      const floorY = baseY + walkHeightRef.current;
      camera.position.set(edgeX, floorY, edgeZ);
      // Mirar hacia el centro del modelo para orientación inmediata
      const lookAtAngle = Math.atan2(center.z - edgeZ, center.x - edgeX);
      yawRef.current = lookAtAngle;
      pitchRef.current = 0;
      const euler = new THREE.Euler(0, lookAtAngle, 0, "YXZ");
      camera.quaternion.setFromEuler(euler);
      currentFloorY.current = floorY;
    } else {
      currentFloorY.current = camera.position.y;
    }
    targetPosRef.current.copy(camera.position);
    smoothPosInitialized.current = true;

    // Hacer muros semitransparentes para ver el interior (all arch layers)
    Object.entries(layersRef.current).forEach(([key, layer]) => {
      if (!ARCH_SPECIALTIES.includes(key) || !layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial;
        if (mat && !Array.isArray(mat)) {
          mat.transparent = true;
          mat.opacity = 0.2;
          mat.depthWrite = false;
          mat.needsUpdate = true;
        }
      });
    });

    setWalkMode(true);
    setShowFloorPicker(true);
    setWalkPos({ x: +camera.position.x.toFixed(1), y: +camera.position.y.toFixed(1), z: +camera.position.z.toFixed(1) });
  }, []);

  const exitWalkMode = useCallback(() => {
    // Restaurar opacidad de muros al salir (all arch layers)
    Object.entries(layersRef.current).forEach(([key, layer]) => {
      if (!ARCH_SPECIALTIES.includes(key) || !layer.group) return;
      const file = files.find(f => f.specialty === key);
      const origOpacity = file ? file.opacity / 100 : 1;
      const origTransparent = file ? file.transparent === 1 : false;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial;
        if (mat && !Array.isArray(mat)) {
          mat.transparent = origTransparent;
          mat.opacity = origOpacity;
          mat.depthWrite = !origTransparent;
          mat.needsUpdate = true;
        }
      });
    });
    setWalkMode(false);
    setShowFloorPicker(false);
    setGyroEnabled(false);
    gyroEnabledRef.current = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    fitAll();
  }, [fitAll, files]);

  /* ═══════════════════════════════════════════════════
     Immersive Walk Mode (fallback for non-WebXR devices)
     Enters walk mode at PB (Y=1.2m) center of building with gyro auto-enabled
     ═══════════════════════════════════════════════════ */
  const enterImmersiveWalk = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;

    // Calculate model bounds
    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });

    camera.fov = 80;
    camera.near = 0.05;
    camera.far = 2000;
    camera.updateProjectionMatrix();

    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const baseY = box.min.y;
      // PB elevadores/pasillo at Y=1.2m above terrain + eye height
      const floorY = baseY + 1.2 + walkHeightRef.current;
      // Position at CENTER of building (not edge) for interior view
      camera.position.set(center.x, floorY, center.z);
      // Look forward along Z axis
      yawRef.current = 0;
      pitchRef.current = 0;
      const euler = new THREE.Euler(0, 0, 0, "YXZ");
      camera.quaternion.setFromEuler(euler);
      currentFloorY.current = floorY;
    } else {
      currentFloorY.current = camera.position.y;
    }
    targetPosRef.current.copy(camera.position);
    smoothPosInitialized.current = true;

    // Make walls semi-transparent for interior visibility
    Object.entries(layersRef.current).forEach(([key, layer]) => {
      if (!ARCH_SPECIALTIES.includes(key) || !layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial;
        if (mat && !Array.isArray(mat)) {
          mat.transparent = true;
          mat.opacity = 0.2;
          mat.depthWrite = false;
          mat.needsUpdate = true;
        }
      });
    });

    setWalkMode(true);
    setCurrentFloor("PB");
    setShowFloorPicker(true);
    setWalkPos({ x: +camera.position.x.toFixed(1), y: +camera.position.y.toFixed(1), z: +camera.position.z.toFixed(1) });

    // Auto-enable gyroscope after a short delay (needs walk mode active first)
    setTimeout(() => {
      requestGyroPermission();
    }, 300);
  }, [requestGyroPermission]);

  /* ═══════════════════════════════════════════════════
     AR Immersive Mode
     ═══════════════════════════════════════════════════ */
  const [arStep, setArStep] = useState<"scanning" | "placed" | "walking">("scanning");
  const [arCurrentFloor, setArCurrentFloor] = useState("PB");
  const [arFloorPickerOpen, setArFloorPickerOpen] = useState(false);
  const [arOpacity, setArOpacity] = useState(100);
  const arRotationRef = useRef(0);
  const arPinchStartRef = useRef<number | null>(null);
  const arPinchScaleRef = useRef(1);

  const enterARMode = useCallback(async () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    if (!renderer || !scene || !navigator.xr) return;
    if (arStarting) return; // Prevent double-tap
    setArStarting(true);

    // Guard: if there's already an active session, end it first
    if (arSessionRef.current) {
      try {
        await arSessionRef.current.end();
      } catch (_e) { /* session may already be ending */ }
      arSessionRef.current = null;
      // Small delay to let the browser release the session
      await new Promise(r => setTimeout(r, 300));
    }

    try {
      // Floor detection + real-world hit-test for Gamma-AR-style placement.
      const session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["dom-overlay", "hit-test", "anchors", "light-estimation"],
        // @ts-ignore
        domOverlay: { root: document.getElementById("ar-overlay") || document.body },
      });

      arSessionRef.current = session;
      renderer.xr.enabled = true;
      await renderer.xr.setSession(session);

      const origBg = scene.background;
      scene.background = null;

      // ── Model bounds (already in real meters) ──
      const box = new THREE.Box3();
      Object.values(layersRef.current).forEach((layer) => {
        if (layer.group && layer.visible) box.expandByObject(layer.group);
      });
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      const baseY = box.isEmpty() ? 0 : box.min.y;
      arModelCenterRef.current.copy(center);
      arModelBaseYRef.current = baseY;
      // PB elevadores/pasillo height = 1.2m + eye height 1.6m above model base
      const pbY = box.isEmpty() ? 2.8 : baseY + 1.2 + 1.6;

      // ── Build the AR model group (1:1), kept hidden until placed ──
      const modelGroup = new THREE.Group();
      scene.add(modelGroup);
      arModelGroup.current = modelGroup;
      Object.entries(layersRef.current).forEach(([key, layer]: [string, any]) => {
        if (layer?.group) {
          const clone = layer.group.clone(true);
          if (ARCH_SPECIALTIES.includes(key)) {
            clone.traverse((child: any) => {
              if (child.isMesh && child.material && !Array.isArray(child.material)) {
                child.material = child.material.clone();
                child.material.transparent = true;
                child.material.opacity = 0.35;
                child.material.depthWrite = false;
                child.material.needsUpdate = true;
              }
            });
          }
          modelGroup.add(clone);
        }
      });
      arScaleRef.current = 1;
      modelGroup.scale.setScalar(1);
      arRotationRef.current = 0;
      modelGroup.rotation.y = 0;
      arOpacityRef.current = 100;
      setArOpacity(100);

      // ── Reticle: glowing ring that snaps to the detected real floor ──
      const reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.1, 0.16, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x14b8a6, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }),
      );
      reticle.renderOrder = 9999;
      const reticleDot = new THREE.Mesh(
        new THREE.CircleGeometry(0.035, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
      );
      reticleDot.renderOrder = 10000;
      reticle.add(reticleDot);
      reticle.matrixAutoUpdate = false;
      reticle.visible = false;
      scene.add(reticle);
      arReticleRef.current = reticle;

      const refSpace = await session.requestReferenceSpace("local-floor");
      arRefSpaceRef.current = refSpace;

      // ── Hit-test source: viewer ray → real-world surfaces ──
      let hitTestSource: any = null;
      try {
        // @ts-ignore
        if (typeof session.requestHitTestSource === "function") {
          const viewerSpace = await session.requestReferenceSpace("viewer");
          // @ts-ignore
          hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
          arHitTestSourceRef.current = hitTestSource;
        }
      } catch (e) {
        console.warn("[AR] hit-test unavailable, using direct placement", e);
      }

      // ── Placement strategies ──
      const placeImmersive = () => {
        modelGroup.position.set(-center.x, -pbY + 1.6, -center.z);
        modelGroup.rotation.y = arRotationRef.current;
        modelGroup.scale.setScalar(1);
        modelGroup.visible = true;
        arScaleRef.current = 1;
        arPlacementModeRef.current = "immersive";
        arModelPlaced.current = true;
        reticle.visible = false;
        setArStep("walking");
        setArCurrentFloor("PB");
      };

      const placeAtReticle = () => {
        if (arModelPlaced.current) return;
        const pos = new THREE.Vector3();
        if (reticle.visible) pos.setFromMatrixPosition(reticle.matrix);
        // Anchor so the model's real base sits on the detected floor,
        // centered under the reticle, at true 1:1 scale.
        modelGroup.position.set(pos.x - center.x, pos.y - baseY, pos.z - center.z);
        modelGroup.rotation.y = arRotationRef.current;
        modelGroup.scale.setScalar(1);
        modelGroup.visible = true;
        arScaleRef.current = 1;
        arPlacementModeRef.current = "site";
        arModelPlaced.current = true;
        reticle.visible = false;
        setArStep("placed");
        setArCurrentFloor("PB");
      };

      arPlaceFnRef.current = placeAtReticle;
      arEnterImmersiveFnRef.current = placeImmersive;

      // A screen tap (XR select) on the real world drops the model there.
      const onSelect = () => { if (!arModelPlaced.current) placeAtReticle(); };
      session.addEventListener("select", onSelect);

      if (hitTestSource) {
        modelGroup.visible = false;
        arModelPlaced.current = false;
        setArStep("scanning");
        setArCurrentFloor("PB");
      } else {
        placeImmersive();
      }

      renderer.setAnimationLoop((_timestamp: number, frame: any) => {
        if (!frame) return;
        if (!arModelPlaced.current && hitTestSource) {
          const results = frame.getHitTestResults(hitTestSource);
          if (results && results.length > 0) {
            const pose = results[0].getPose(refSpace);
            if (pose) {
              reticle.visible = true;
              reticle.matrix.fromArray(pose.transform.matrix);
            }
          } else {
            reticle.visible = false;
          }
        }
        renderer.render(scene, renderer.xr.getCamera());
      });

      // Handle session end
      session.addEventListener("end", () => {
        renderer.xr.enabled = false;
        renderer.setAnimationLoop(null);
        scene.background = origBg;
        try { session.removeEventListener("select", onSelect); } catch { /* noop */ }
        if (reticle.parent) scene.remove(reticle);
        if (modelGroup.parent) {
          modelGroup.clear();
          scene.remove(modelGroup);
        }
        arSessionRef.current = null;
        arHitTestSourceRef.current = null;
        arReticleRef.current = null;
        arRefSpaceRef.current = null;
        arPlaceFnRef.current = null;
        arEnterImmersiveFnRef.current = null;
        arModelPlaced.current = false;
        arModelGroup.current = null;
        setArActive(false);
        setArStep("scanning");
      });

      setArActive(true);
      setArStarting(false);
    } catch (err) {
      console.error("[AR] Failed to start AR session:", err);
      setArStarting(false);
      const msg = (err as Error).message || "AR no disponible";
      alert(`No se pudo iniciar AR: ${msg}\n\nRequiere Android Chrome con WebXR o Quest Browser.`);
    }
  }, [arStarting]);

  const exitARMode = useCallback(() => {
    if (arSessionRef.current) {
      arSessionRef.current.end();
    }
  }, []);

  /** Teleport to a different floor in AR mode by repositioning the model group */
  const teleportARToFloor = useCallback((floorShort: string) => {
    if (!arModelGroup.current || !arModelPlaced.current) return;
    const floor = FLOOR_LEVELS.find(f => f.short === floorShort);
    if (!floor) return;

    // Site mode: model is anchored to the real floor — don't move it,
    // just update the active-floor label.
    if (arPlacementModeRef.current === "site") {
      setArCurrentFloor(floorShort);
      setArFloorPickerOpen(false);
      return;
    }

    // Calculate model center
    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach((layer: any) => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const targetY = box.isEmpty() ? floor.y + 1.6 : box.min.y + floor.y + 1.6;

    // Reposition model so user stands at the target floor
    arModelGroup.current.position.set(-center.x, -targetY + 1.6, -center.z);
    // Preserve existing rotation
    arModelGroup.current.rotation.y = arRotationRef.current;

    setArCurrentFloor(floorShort);
    setArFloorPickerOpen(false);
  }, []);

  const adjustARScale = useCallback((factor: number) => {
    arScaleRef.current *= factor;
    if (arModelGroup.current && arModelPlaced.current) {
      arModelGroup.current.scale.setScalar(arScaleRef.current);
    }
  }, []);

  const rotateARModel = useCallback((degrees: number) => {
    arRotationRef.current += (degrees * Math.PI) / 180;
    if (arModelGroup.current && arModelPlaced.current) {
      arModelGroup.current.rotation.y = arRotationRef.current;
    }
  }, []);

  const resetARPlacement = useCallback(() => {
    // Keep the (expensive) cloned model — just hide it and re-enter the
    // scan/reticle flow so the user can re-anchor it somewhere else.
    arModelPlaced.current = false;
    arScaleRef.current = 1;
    if (arModelGroup.current) {
      arModelGroup.current.visible = false;
      arModelGroup.current.scale.setScalar(1);
    }
    if (arReticleRef.current) arReticleRef.current.visible = false;
    setArStep("scanning");
  }, []);

  /** Global AR transparency — "x-ray" overlay vs. the real site (field tool) */
  const applyAROpacity = useCallback((pct: number) => {
    arOpacityRef.current = pct;
    setArOpacity(pct);
    const g = arModelGroup.current;
    if (!g) return;
    const o = Math.max(0.05, Math.min(1, pct / 100));
    g.traverse((child: any) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m: any) => {
          m.transparent = pct < 100;
          m.opacity = o;
          m.depthWrite = pct >= 100;
          m.needsUpdate = true;
        });
      }
    });
  }, []);

  /** Switch from anchored "site" view into the 1:1 walk-through */
  const enterImmersiveFromAR = useCallback(() => {
    arEnterImmersiveFnRef.current?.();
  }, []);

  /* ═══════════════════════════════════════════════════
     AR Georeferencing: GPS + Compass for auto-alignment
     ═══════════════════════════════════════════════════ */

  /** Convert lat/lng to UTM (simplified WGS84 → UTM) */
  const latLngToUTM = useCallback((lat: number, lng: number) => {
    const zone = Math.floor((lng + 180) / 6) + 1;
    const hemisphere = lat >= 0 ? "N" : "S";
    // Simplified UTM conversion (accurate to ~1m for construction)
    const a = 6378137; // WGS84 semi-major axis
    const f = 1 / 298.257223563;
    const e2 = 2 * f - f * f;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const latRad = (lat * Math.PI) / 180;
    const lngRad = (lng * Math.PI) / 180;
    const lng0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
    const T = Math.tan(latRad) ** 2;
    const C = (e2 / (1 - e2)) * Math.cos(latRad) ** 2;
    const A = Math.cos(latRad) * (lngRad - lng0);
    const M = a * (
      (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latRad
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latRad)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latRad)
      - (35 * e6 / 3072) * Math.sin(6 * latRad)
    );
    const easting = 500000 + 0.9996 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2) * A ** 5 / 120);
    const northing = (hemisphere === "S" ? 10000000 : 0) + 0.9996 * (M + N * Math.tan(latRad) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24));
    return { easting, northing, zone, hemisphere };
  }, []);

  /** Start GPS + compass acquisition for AR georeferencing */
  const startARGeoref = useCallback(() => {
    setArGeoMode(true);
    setArGpsStatus("acquiring");
    setArCompassHeading(null);
    setArGpsPosition(null);

    // Start GPS watch
    if ("geolocation" in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setArGpsPosition({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
          if (pos.coords.accuracy < 20) {
            setArGpsStatus("ready");
          }
        },
        (err) => {
          console.error("[AR Geo] GPS error:", err);
          setArGpsStatus("error");
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
      arGpsWatchRef.current = watchId;
    } else {
      setArGpsStatus("error");
    }

    // Start compass (absolute orientation)
    const compassHandler = (e: DeviceOrientationEvent) => {
      // webkitCompassHeading for iOS, alpha for Android
      let heading: number | null = null;
      if (typeof (e as any).webkitCompassHeading === "number") {
        heading = (e as any).webkitCompassHeading;
      } else if (e.absolute && typeof e.alpha === "number") {
        heading = 360 - e.alpha; // Convert to compass bearing
      } else if (typeof e.alpha === "number") {
        heading = 360 - e.alpha;
      }
      if (heading !== null) {
        arCompassRef.current = heading;
        setArCompassHeading(heading);
      }
    };
    arCompassListenerRef.current = compassHandler;

    // Request permission for iOS 13+
    if (typeof (DeviceOrientationEvent as any).requestPermission === "function") {
      (DeviceOrientationEvent as any).requestPermission().then((perm: string) => {
        if (perm === "granted") {
          window.addEventListener("deviceorientationabsolute", compassHandler as any);
          window.addEventListener("deviceorientation", compassHandler);
        }
      });
    } else {
      window.addEventListener("deviceorientationabsolute", compassHandler as any);
      window.addEventListener("deviceorientation", compassHandler);
    }
  }, []);

  /** Stop GPS + compass */
  const stopARGeoref = useCallback(() => {
    if (arGpsWatchRef.current !== null) {
      navigator.geolocation.clearWatch(arGpsWatchRef.current);
      arGpsWatchRef.current = null;
    }
    if (arCompassListenerRef.current) {
      window.removeEventListener("deviceorientationabsolute", arCompassListenerRef.current as any);
      window.removeEventListener("deviceorientation", arCompassListenerRef.current);
      arCompassListenerRef.current = null;
    }
    setArGeoMode(false);
    setArGpsStatus("idle");
  }, []);

  /** Apply georeferencing: auto-rotate model to match compass + UTM offset */
  const applyARGeoref = useCallback(() => {
    if (!arModelGroup.current || !arModelPlaced.current) return;
    if (!arGpsPosition || arCompassHeading === null || !utmCalibration) return;

    const { easting: gpsEasting, northing: gpsNorthing } = latLngToUTM(arGpsPosition.lat, arGpsPosition.lng);
    const { easting: refEasting, northing: refNorthing } = utmCalibration.utmRef;

    // Calculate offset from calibration point to current GPS position in meters
    const dEasting = gpsEasting - refEasting;
    const dNorthing = gpsNorthing - refNorthing;

    // Compass heading: 0=North, 90=East, 180=South, 270=West
    // In Three.js: Y-up, Z=North when rotation.y=0
    // We need to rotate the model so its "north" aligns with real north
    const headingRad = (arCompassHeading * Math.PI) / 180;

    // Apply rotation to align model north with real north
    arRotationRef.current = -headingRad;
    arModelGroup.current.rotation.y = arRotationRef.current;

    console.log(`[AR Geo] Applied: heading=${arCompassHeading.toFixed(1)}°, GPS accuracy=${arGpsPosition.accuracy.toFixed(1)}m, UTM offset=(${dEasting.toFixed(1)}, ${dNorthing.toFixed(1)})`);
  }, [arGpsPosition, arCompassHeading, utmCalibration, latLngToUTM]);

  // Cleanup georef on unmount
  useEffect(() => {
    return () => {
      if (arGpsWatchRef.current !== null) {
        navigator.geolocation.clearWatch(arGpsWatchRef.current);
      }
      if (arCompassListenerRef.current) {
        window.removeEventListener("deviceorientationabsolute", arCompassListenerRef.current as any);
        window.removeEventListener("deviceorientation", arCompassListenerRef.current);
      }
    };
  }, []);

  /* ═══════════════════════════════════════════════════
     Apply Visual Settings to a layer
     ═══════════════════════════════════════════════════ */
  const applyVisualToLayer = useCallback((specialty: string, settings: VisualSettings) => {
    const layer = layersRef.current[specialty];
    if (!layer?.group) return;

    layer.group.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;

      // Get original color from file config
      const file = files.find(f => f.specialty === specialty);
      if (!file) return;

      // Apply hue shift + saturation
      const baseColor = new THREE.Color(file.color);
      const hsl = { h: 0, s: 0, l: 0 };
      baseColor.getHSL(hsl);
      hsl.h = ((hsl.h + settings.hueShift / 360) % 1 + 1) % 1;
      hsl.s = Math.min(1, hsl.s * settings.saturation);
      const newColor = new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l);
      mat.color.copy(newColor);

      // Opacity
      mat.opacity = settings.opacity / 100;
      mat.transparent = settings.opacity < 100;
      mat.depthWrite = settings.opacity >= 90;
      mat.needsUpdate = true;
    });

    // Edge thickness
    if (layer.edgeGroup) {
      layer.edgeGroup.traverse((child) => {
        if ((child as THREE.LineSegments).isLineSegments) {
          const lineMat = (child as THREE.LineSegments).material as THREE.LineBasicMaterial;
          lineMat.color.set(settings.edgeColor);
          lineMat.opacity = settings.edgeThickness > 0 ? 0.3 + settings.edgeThickness * 0.15 : 0;
          lineMat.visible = settings.edgeThickness > 0;
          lineMat.needsUpdate = true;
        }
      });
      layer.edgeGroup.visible = settings.edgeThickness > 0 && layer.visible;
    }
  }, [files]);

  const updateVisualSetting = useCallback((specialty: string, key: keyof VisualSettings, value: number | string) => {
    setVisualSettings(prev => {
      const current = prev[specialty] || { hueShift: 0, saturation: 1, opacity: 100, edgeThickness: 1, edgeColor: "#999999" };
      const updated = { ...current, [key]: value };
      const newSettings = { ...prev, [specialty]: updated };
      // Apply immediately
      setTimeout(() => applyVisualToLayer(specialty, updated), 0);
      return newSettings;
    });
  }, [applyVisualToLayer]);

  /* ═══════════════════════════════════════════════════
     Visual Mode Presets (Normal, Crystal, Solid, Dark, Translucent, X-Ray)
     ═══════════════════════════════════════════════════ */
  const applyVisualMode = useCallback((mode: VisualMode) => {
    setVisualMode(mode);
    setXrayMode(mode === "xray");

    files.forEach(f => {
      const isArch = ARCH_SPECIALTIES.includes(f.specialty);
      const isPipe = PIPE_SPECIALTIES.includes(f.specialty);
      let settings: VisualSettings;

      switch (mode) {
        case "crystal":
          settings = {
            hueShift: 0, saturation: 0.4,
            opacity: isArch ? 20 : isPipe ? 85 : 35,
            edgeThickness: 2,
            edgeColor: isArch ? "#B0C4DE" : isPipe ? f.color : "#7B8FA8",
          };
          break;
        case "solid":
          settings = {
            hueShift: 0, saturation: 1.2,
            opacity: 100,
            edgeThickness: 1.5,
            edgeColor: "#333333",
          };
          break;
        case "dark":
          settings = {
            hueShift: 0, saturation: 0.6,
            opacity: isArch ? 90 : 95,
            edgeThickness: 2.5,
            edgeColor: "#00E5CC",
          };
          break;
        case "translucent":
          settings = {
            hueShift: 0, saturation: 0.8,
            opacity: isArch ? 12 : isPipe ? 70 : 30,
            edgeThickness: 1.5,
            edgeColor: isArch ? "#94A3B8" : f.color,
          };
          break;
        case "xray":
          settings = {
            hueShift: 0,
            saturation: isArch ? 0.3 : isPipe ? 1.5 : 0.5,
            opacity: isArch ? 15 : isPipe ? 100 : 60,
            edgeThickness: isArch ? 0.5 : isPipe ? 3 : 2,
            edgeColor: isArch ? "#94A3B8" : isPipe ? f.color : BRAND.navy,
          };
          break;
        default: // normal
          settings = {
            hueShift: 0, saturation: 1,
            opacity: f.opacity,
            edgeThickness: 1,
            edgeColor: "#999999",
          };
          break;
      }
      setVisualSettings(prev => ({ ...prev, [f.specialty]: settings }));
      setTimeout(() => applyVisualToLayer(f.specialty, settings), 0);
    });
  }, [files, applyVisualToLayer]);

  // Legacy compat
  const toggleXrayMode = useCallback(() => {
    applyVisualMode(visualMode === "xray" ? "normal" : "xray");
  }, [visualMode, applyVisualMode]);

  /* ═══════════════════════════════════════════════════
     Initialize visual settings when files load
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (!files.length) return;
    const init: Record<string, VisualSettings> = {};
    files.forEach(f => {
      if (!visualSettingsRef.current[f.specialty]) {
        init[f.specialty] = {
          hueShift: 0,
          saturation: 1,
          opacity: f.opacity,
          edgeThickness: 1,  // Aristas siempre activas por defecto
          edgeColor: "#999999",
        };
      }
    });
    if (Object.keys(init).length > 0) {
      setVisualSettings(prev => ({ ...prev, ...init }));
    }
  }, [files]);

  /* ═══════════════════════════════════════════════════
     Annotations
     ═══════════════════════════════════════════════════ */
  const handleAnnotationClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!annotationMode || walkMode) return;
    const el = containerRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!el || !camera || !scene) return;

    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = rc.intersectObjects(meshes, false);
    if (intersects.length === 0) return;

    const point = intersects[0].point.clone();
    const specialty = (intersects[0].object as THREE.Mesh).userData?.fileSpecialty || "general";
    setPendingAnnotationPoint(point);
    setAnnotationText("");
    setActiveTab("annotate");
    if (isMobile) {
      setPanelOpen(true);
      setBottomSheetExpanded(true);
    }
  }, [annotationMode, walkMode, isMobile]);

  // Determine floor label from Y position
  const getFloorLabelFromY = useCallback((y: number): string | undefined => {
    let closest = FLOOR_LEVELS[0];
    let minDist = Math.abs(y - FLOOR_LEVELS[0].y);
    for (const fl of FLOOR_LEVELS) {
      const d = Math.abs(y - fl.y);
      if (d < minDist) { minDist = d; closest = fl; }
    }
    // Only assign if within 5m of a floor
    return minDist <= 5 ? closest.label : undefined;
  }, []);

  const createAnnotationMut = trpc.annotations3d.create.useMutation();
  const deleteAnnotationMut = trpc.annotations3d.delete.useMutation();
  const updateAnnotationMut = trpc.annotations3d.update.useMutation();

  const addAnnotation = useCallback(async () => {
    if (!pendingAnnotationPoint || !annotationText.trim()) return;
    const scene = sceneRef.current;
    if (!scene) return;

    const cat = annotationCategory;
    const floorLabel = getFloorLabelFromY(pendingAnnotationPoint.y);
    const sprite = createAnnotationSprite(annotationText, pendingAnnotationPoint, cat, false);
    scene.add(sprite);

    // Pin marker sphere with category color
    const pinGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const pinMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLORS[cat]).getHex(), depthTest: false });
    const pin = new THREE.Mesh(pinGeo, pinMat);
    pin.position.copy(pendingAnnotationPoint);
    pin.renderOrder = 901;
    scene.add(pin);

    const localId = `ann-${Date.now()}`;
    const annotation: Annotation = {
      id: localId,
      position: pendingAnnotationPoint.clone(),
      text: annotationText,
      specialty: "general",
      category: cat,
      floorLabel,
      resolved: false,
      timestamp: Date.now(),
      sprite,
    };

    setAnnotations(prev => [...prev, annotation]);
    setPendingAnnotationPoint(null);
    setAnnotationText("");

    // Persist to DB
    try {
      const result = await createAnnotationMut.mutateAsync({
        projectId: projectId,
        text: annotationText,
        category: cat,
        floorLabel,
        posX: pendingAnnotationPoint.x,
        posY: pendingAnnotationPoint.y,
        posZ: pendingAnnotationPoint.z,
      });
      // Update local annotation with DB id
      setAnnotations(prev => prev.map(a => a.id === localId ? { ...a, dbId: result.id } : a));
    } catch (e) {
      console.error("Failed to save annotation to DB:", e);
    }
  }, [pendingAnnotationPoint, annotationText, annotationCategory, createAnnotationSprite, getFloorLabelFromY, projectId]);

  const removeAnnotation = useCallback((id: string) => {
    const scene = sceneRef.current;
    setAnnotations(prev => {
      const ann = prev.find(a => a.id === id);
      if (ann?.sprite && scene) {
        scene.remove(ann.sprite);
      }
      // Delete from DB if persisted
      if (ann?.dbId) {
        deleteAnnotationMut.mutate({ id: ann.dbId });
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const toggleAnnotationResolved = useCallback((annId: string) => {
    const scene = sceneRef.current;
    setAnnotations(prev => prev.map(ann => {
      if (ann.id !== annId) return ann;
      const newResolved = !ann.resolved;
      // Recreate sprite with new resolved state
      if (ann.sprite && scene) {
        scene.remove(ann.sprite);
        const newSprite = createAnnotationSprite(ann.text, ann.position, ann.category, newResolved);
        scene.add(newSprite);
        // Update DB
        if (ann.dbId) {
          updateAnnotationMut.mutate({ id: ann.dbId, resolved: newResolved });
        }
        return { ...ann, resolved: newResolved, sprite: newSprite };
      }
      return { ...ann, resolved: newResolved };
    }));
  }, [createAnnotationSprite]);

  /* ═══════════════════════════════════════════════════
     Share View
     ═══════════════════════════════════════════════════ */
  const generateShareUrl = useCallback(() => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam) return;

    const pos = cam.position;
    const target = controls?.target || new THREE.Vector3();
    const fov = cam.fov;
    const isWalk = walkModeRef.current;

    const params = new URLSearchParams();
    params.set('cx', pos.x.toFixed(2));
    params.set('cy', pos.y.toFixed(2));
    params.set('cz', pos.z.toFixed(2));
    params.set('tx', target.x.toFixed(2));
    params.set('ty', target.y.toFixed(2));
    params.set('tz', target.z.toFixed(2));
    params.set('fov', fov.toFixed(0));
    if (isWalk) {
      params.set('walk', '1');
      params.set('yaw', yawRef.current.toFixed(3));
      params.set('pitch', pitchRef.current.toFixed(3));
    }

    // Visible layers
    const visibleLayers = Object.entries(layersRef.current)
      .filter(([, l]) => l.visible)
      .map(([k]) => k);
    params.set('layers', visibleLayers.join(','));

    const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    setShareUrl(url);
    setShowShareDialog(true);
  }, []);

  const copyShareUrl = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl).catch(() => {});
    }
  }, [shareUrl]);

  /* ═══════════════════════════════════════════════════
     Restore shared view from URL params
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cx = params.get('cx');
    if (!cx) return; // No shared view params

    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls) return;

    const pos = new THREE.Vector3(
      parseFloat(params.get('cx') || '0'),
      parseFloat(params.get('cy') || '0'),
      parseFloat(params.get('cz') || '0')
    );
    const target = new THREE.Vector3(
      parseFloat(params.get('tx') || '0'),
      parseFloat(params.get('ty') || '0'),
      parseFloat(params.get('tz') || '0')
    );
    const fov = parseFloat(params.get('fov') || '60');

    cam.position.copy(pos);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    controls.target.copy(target);
    controls.update();

    if (params.get('walk') === '1') {
      yawRef.current = parseFloat(params.get('yaw') || '0');
      pitchRef.current = parseFloat(params.get('pitch') || '0');
      setWalkMode(true);
    }
  }, []);

  /* ═══════════════════════════════════════════════════
     Measurement Tool
     ═══════════════════════════════════════════════════ */
  const clearMeasurement = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (measureLineRef.current) { scene.remove(measureLineRef.current); measureLineRef.current = null; }
    measureSpheresRef.current.forEach(s => scene.remove(s));
    measureSpheresRef.current = [];
    if (measureLabelRef.current) { scene.remove(measureLabelRef.current); measureLabelRef.current = null; }
    measureExtrasRef.current.forEach(o => scene.remove(o));
    measureExtrasRef.current = [];
    // Chain measurement cleanup
    measureChainObjectsRef.current.forEach(o => scene.remove(o));
    measureChainObjectsRef.current = [];
    // Preview line cleanup
    if (measurePreviewLineRef.current) { scene.remove(measurePreviewLineRef.current); measurePreviewLineRef.current = null; }
    if (measurePreviewDistLabelRef.current) { scene.remove(measurePreviewDistLabelRef.current); measurePreviewDistLabelRef.current = null; }
    // Area measurement cleanup
    measureAreaObjectsRef.current.forEach(o => scene.remove(o));
    measureAreaObjectsRef.current = [];
    setMeasurePoints([]);
    setMeasureDistance(null);
    setMeasureChainPoints([]);
    setMeasureChainDistances([]);
    setMeasureAreaPoints([]);
    setMeasureAreaResult(null);
  }, []);

  /* Save current measurement to history */
  const saveMeasurement = useCallback(() => {
    const floorLabel = floorIsolation && isolatedFloorIdx !== null
      ? FLOOR_LEVELS[isolatedFloorIdx].label
      : undefined;
    if (measureAreaMode && measureAreaResult && measureAreaPoints.length >= 3) {
      const perimeter = measureAreaResult.perimeter;
      setMeasureHistory(prev => [...prev, {
        id: `m-${Date.now()}`,
        type: "area",
        points: measureAreaPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
        distances: [],
        total: measureAreaResult.area,
        area: measureAreaResult.area,
        perimeter,
        timestamp: Date.now(),
        floorLabel,
      }]);
      toast.success("Medici\u00f3n de \u00e1rea guardada");
    } else if (measureChainMode && measureChainPoints.length >= 2) {
      setMeasureHistory(prev => [...prev, {
        id: `m-${Date.now()}`,
        type: "chain",
        points: measureChainPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
        distances: measureChainDistances,
        total: measureChainDistances.reduce((a, b) => a + b, 0),
        timestamp: Date.now(),
        floorLabel,
      }]);
      toast.success("Medici\u00f3n en cadena guardada");
    } else if (measureDistance !== null && measurePoints.length === 2) {
      setMeasureHistory(prev => [...prev, {
        id: `m-${Date.now()}`,
        type: "single",
        points: measurePoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
        distances: [measureDistance],
        total: measureDistance,
        timestamp: Date.now(),
        floorLabel,
      }]);
      toast.success("Medici\u00f3n guardada");
    }
  }, [measureAreaMode, measureAreaResult, measureAreaPoints, measureChainMode, measureChainPoints, measureChainDistances, measureDistance, measurePoints, floorIsolation, isolatedFloorIdx]);

  /* Export all measurements as CSV */
  const exportMeasurements = useCallback(() => {
    if (measureHistory.length === 0) return;
    const rows = ["ID,Tipo,Nivel,Total (m),Puntos,Fecha"];
    measureHistory.forEach(m => {
      const pts = m.points.map(p => `(${p.x.toFixed(3)};${p.y.toFixed(3)};${p.z.toFixed(3)})`).join(" > ");
      const date = new Date(m.timestamp).toLocaleString("es-MX");
      rows.push(`${m.id},${m.type},${m.floorLabel || "Global"},${m.total.toFixed(4)},"${pts}",${date}`);
    });
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `OAR_mediciones_${new Date().toISOString().slice(0,10)}.csv`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`${measureHistory.length} mediciones exportadas`);
  }, [measureHistory]);

  /* ─── Snap crosshair preview (follows cursor in measure mode) ─── */
  const snapPreviewRef = useRef<THREE.Group | null>(null);
  const snapActiveRef = useRef(false);

  useEffect(() => {
    if (!measureMode) {
      // Cleanup preview when leaving measure mode
      if (snapPreviewRef.current && sceneRef.current) {
        sceneRef.current.remove(snapPreviewRef.current);
        snapPreviewRef.current = null;
      }
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      if (!measureMode || walkMode) return;
      const camera = cameraRef.current;
      const scene = sceneRef.current;
      if (!camera || !scene) return;

      const rect = el.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(mouse, camera);

      const meshes: THREE.Mesh[] = [];
      Object.values(layersRef.current).forEach((layer) => {
        if (layer.group && layer.visible) {
          layer.group.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
          });
        }
      });

      const intersects = rc.intersectObjects(meshes, false);
      if (intersects.length === 0) {
        if (snapPreviewRef.current) snapPreviewRef.current.visible = false;
        return;
      }

      let point = intersects[0].point.clone();
      let snapped = false;

      // Snap to nearest edge
      const SNAP_SCREEN_PX = 50;
      const hitMesh = intersects[0].object as THREE.Mesh;
      const geo = hitMesh.geometry;
      if (geo) {
        const edgesGeo = new THREE.EdgesGeometry(geo, 25);
        const posAttr = edgesGeo.getAttribute("position");
        if (posAttr) {
          let bestDist = Infinity;
          let bestPoint: THREE.Vector3 | null = null;
          const worldMatrix = hitMesh.matrixWorld;
          const v0 = new THREE.Vector3();
          const v1 = new THREE.Vector3();
          const projected = new THREE.Vector3();
          for (let i = 0; i < posAttr.count; i += 2) {
            v0.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
            v1.fromBufferAttribute(posAttr, i + 1).applyMatrix4(worldMatrix);
            const lineDir = new THREE.Vector3().subVectors(v1, v0);
            const lineLen = lineDir.length();
            if (lineLen < 0.001) continue;
            lineDir.normalize();
            const t = Math.max(0, Math.min(lineLen, new THREE.Vector3().subVectors(point, v0).dot(lineDir)));
            projected.copy(v0).addScaledVector(lineDir, t);
            const screenPoint = point.clone().project(camera);
            const screenProj = projected.clone().project(camera);
            const dx2 = (screenPoint.x - screenProj.x) * el.clientWidth * 0.5;
            const dy2 = (screenPoint.y - screenProj.y) * el.clientHeight * 0.5;
            const screenDist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (screenDist < SNAP_SCREEN_PX && screenDist < bestDist) {
              bestDist = screenDist;
              bestPoint = projected.clone();
            }
          }
          if (bestPoint) { point = bestPoint; snapped = true; }
          edgesGeo.dispose();
        }
      }

      // Create or update the crosshair preview
      if (!snapPreviewRef.current) {
        const group = new THREE.Group();
        group.renderOrder = 999;

        // Crosshair lines (4 arms)
        const armLen = 0.15;
        const armMat = new THREE.LineBasicMaterial({ color: 0xff4444, depthTest: false, linewidth: 2 });
        const arms = [
          [new THREE.Vector3(-armLen, 0, 0), new THREE.Vector3(armLen, 0, 0)],
          [new THREE.Vector3(0, 0, -armLen), new THREE.Vector3(0, 0, armLen)],
          [new THREE.Vector3(0, -armLen, 0), new THREE.Vector3(0, armLen, 0)],
        ];
        arms.forEach(([a, b]) => {
          const g = new THREE.BufferGeometry().setFromPoints([a, b]);
          const l = new THREE.Line(g, armMat);
          l.renderOrder = 999;
          group.add(l);
        });

        // Diamond/square indicator for snap
        const diamondSize = 0.1;
        const diamondGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, diamondSize, 0),
          new THREE.Vector3(diamondSize, 0, 0),
          new THREE.Vector3(0, -diamondSize, 0),
          new THREE.Vector3(-diamondSize, 0, 0),
          new THREE.Vector3(0, diamondSize, 0),
        ]);
        const diamondMat = new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, linewidth: 2 });
        const diamond = new THREE.Line(diamondGeo, diamondMat);
        diamond.renderOrder = 999;
        diamond.name = "snapDiamond";
        diamond.visible = false;
        group.add(diamond);

        // Center dot
        const dotGeo = new THREE.SphereGeometry(0.03, 12, 12);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff4444, depthTest: false });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.renderOrder = 999;
        dot.name = "centerDot";
        group.add(dot);

        scene.add(group);
        snapPreviewRef.current = group;
      }

      const preview = snapPreviewRef.current;
      preview.position.copy(point);
      preview.visible = true;

      // Show/hide snap diamond and change colors
      const diamond = preview.getObjectByName("snapDiamond");
      const centerDot = preview.getObjectByName("centerDot") as THREE.Mesh | undefined;
      if (diamond) diamond.visible = snapped;
      if (centerDot && centerDot.material) {
        (centerDot.material as THREE.MeshBasicMaterial).color.set(snapped ? 0x00ff88 : 0xff4444);
      }
      // Change crosshair arm colors based on snap
      preview.children.forEach(child => {
        if (child instanceof THREE.Line && child.name !== "snapDiamond") {
          (child.material as THREE.LineBasicMaterial).color.set(snapped ? 0x00ff88 : 0xff4444);
        }
      });

      snapActiveRef.current = snapped;

      // ─── Real-time preview line from last placed point to cursor ───
      const startPoint = measureAreaMode
        ? (measureAreaPoints.length > 0 ? measureAreaPoints[measureAreaPoints.length - 1] : null)
        : measureChainMode
          ? (measureChainPoints.length > 0 ? measureChainPoints[measureChainPoints.length - 1] : null)
          : (measurePoints.length === 1 ? measurePoints[0] : null);

      if (startPoint && scene) {
        // Remove old preview line
        if (measurePreviewLineRef.current) {
          scene.remove(measurePreviewLineRef.current);
          measurePreviewLineRef.current = null;
        }
        if (measurePreviewDistLabelRef.current) {
          scene.remove(measurePreviewDistLabelRef.current);
          measurePreviewDistLabelRef.current = null;
        }

        // Create dashed line from start to cursor
        const lineGeo = new THREE.BufferGeometry().setFromPoints([startPoint, point]);
        const lineMat = new THREE.LineDashedMaterial({
          color: measureAreaMode ? 0x4fc3f7 : new THREE.Color(BRAND.teal).getHex(),
          dashSize: 0.15,
          gapSize: 0.08,
          depthTest: false,
          transparent: true,
          opacity: 0.8,
        });
        const dashedLine = new THREE.Line(lineGeo, lineMat);
        dashedLine.computeLineDistances();
        dashedLine.renderOrder = 9980;
        scene.add(dashedLine);
        measurePreviewLineRef.current = dashedLine;

        // Create floating distance label at midpoint
        const previewDist = startPoint.distanceTo(point);
        if (previewDist > 0.01) {
          const labelCanvas = document.createElement('canvas');
          const lw = 256;
          const lh = 64;
          labelCanvas.width = lw;
          labelCanvas.height = lh;
          const lctx = labelCanvas.getContext('2d')!;
          // Background pill
          lctx.fillStyle = 'rgba(20,35,65,0.85)';
          lctx.beginPath();
          lctx.roundRect(0, 0, lw, lh, 12);
          lctx.fill();
          lctx.strokeStyle = measureAreaMode ? '#4fc3f7' : BRAND.teal;
          lctx.lineWidth = 2;
          lctx.stroke();
          // Distance text
          const distText = previewDist >= 1.0 ? `${previewDist.toFixed(2)} m` : `${(previewDist * 100).toFixed(0)} cm`;
          lctx.fillStyle = '#ffffff';
          lctx.font = 'bold 28px Outfit, Arial, sans-serif';
          lctx.textAlign = 'center';
          lctx.textBaseline = 'middle';
          lctx.fillText(distText, lw / 2, lh / 2);

          const labelTexture = new THREE.CanvasTexture(labelCanvas);
          labelTexture.needsUpdate = true;
          const labelSpriteMat = new THREE.SpriteMaterial({ map: labelTexture, depthTest: false, transparent: true });
          const labelSprite = new THREE.Sprite(labelSpriteMat);
          const mid = startPoint.clone().add(point).multiplyScalar(0.5);
          const camDist = camera.position.distanceTo(mid);
          const labelScale = Math.max(0.6, camDist * 0.06);
          labelSprite.scale.set(labelScale * (lw / lh), labelScale, 1);
          mid.y += Math.max(0.2, camDist * 0.02);
          labelSprite.position.copy(mid);
          labelSprite.renderOrder = 9985;
          scene.add(labelSprite);
          measurePreviewDistLabelRef.current = labelSprite;
        }

        // For area mode: also draw closing line from cursor back to first point
        if (measureAreaMode && measureAreaPoints.length >= 2) {
          const closingGeo = new THREE.BufferGeometry().setFromPoints([point, measureAreaPoints[0]]);
          const closingMat = new THREE.LineDashedMaterial({
            color: 0x4fc3f7,
            dashSize: 0.1,
            gapSize: 0.1,
            depthTest: false,
            transparent: true,
            opacity: 0.4,
          });
          const closingLine = new THREE.Line(closingGeo, closingMat);
          closingLine.computeLineDistances();
          closingLine.renderOrder = 9979;
          scene.add(closingLine);
          // Store as extra to clean up next frame
          measureAreaObjectsRef.current.push(closingLine);
        }
      } else {
        // No start point, clean up preview
        if (measurePreviewLineRef.current && scene) {
          scene.remove(measurePreviewLineRef.current);
          measurePreviewLineRef.current = null;
        }
        if (measurePreviewDistLabelRef.current && scene) {
          scene.remove(measurePreviewDistLabelRef.current);
          measurePreviewDistLabelRef.current = null;
        }
      }
    };

    el.addEventListener("pointermove", onMove);
    return () => {
      el.removeEventListener("pointermove", onMove);
      if (snapPreviewRef.current && sceneRef.current) {
        sceneRef.current.remove(snapPreviewRef.current);
        snapPreviewRef.current = null;
      }
      // Clean up preview line on unmount
      if (measurePreviewLineRef.current && sceneRef.current) {
        sceneRef.current.remove(measurePreviewLineRef.current);
        measurePreviewLineRef.current = null;
      }
      if (measurePreviewDistLabelRef.current && sceneRef.current) {
        sceneRef.current.remove(measurePreviewDistLabelRef.current);
        measurePreviewDistLabelRef.current = null;
      }
    };
  }, [measureMode, walkMode, measurePoints, measureChainPoints, measureAreaPoints, measureChainMode, measureAreaMode]);

  const handleMeasureClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!measureMode || walkMode) return;
    const el = containerRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!el || !camera || !scene) return;

    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = rc.intersectObjects(meshes, false);
    if (intersects.length === 0) return;

    let point = intersects[0].point.clone();

    // ─── Snap to nearest edge ───
    // Find closest edge segment within snap threshold (screen-space 50px)
    const SNAP_SCREEN_PX = 50;
    const hitMesh = intersects[0].object as THREE.Mesh;
    const geo = hitMesh.geometry;
    if (geo) {
      const edgesGeo = new THREE.EdgesGeometry(geo, 25);
      const posAttr = edgesGeo.getAttribute("position");
      if (posAttr) {
        let bestDist = Infinity;
        let bestPoint: THREE.Vector3 | null = null;
        const worldMatrix = hitMesh.matrixWorld;
        const v0 = new THREE.Vector3();
        const v1 = new THREE.Vector3();
        const projected = new THREE.Vector3();

        for (let i = 0; i < posAttr.count; i += 2) {
          v0.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
          v1.fromBufferAttribute(posAttr, i + 1).applyMatrix4(worldMatrix);

          // Project point onto line segment v0-v1
          const lineDir = new THREE.Vector3().subVectors(v1, v0);
          const lineLen = lineDir.length();
          if (lineLen < 0.001) continue;
          lineDir.normalize();
          const t = Math.max(0, Math.min(lineLen, new THREE.Vector3().subVectors(point, v0).dot(lineDir)));
          projected.copy(v0).addScaledVector(lineDir, t);

          // Check screen-space distance
          const screenPoint = point.clone().project(camera);
          const screenProj = projected.clone().project(camera);
          const dx = (screenPoint.x - screenProj.x) * el.clientWidth * 0.5;
          const dy = (screenPoint.y - screenProj.y) * el.clientHeight * 0.5;
          const screenDist = Math.sqrt(dx * dx + dy * dy);

          if (screenDist < SNAP_SCREEN_PX && screenDist < bestDist) {
            bestDist = screenDist;
            bestPoint = projected.clone();
          }
        }

        if (bestPoint) {
          point = bestPoint;
        }
        edgesGeo.dispose();
      }
    }

    // Add sphere marker — bright, visible, always on top
    const sphereGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false, transparent: true, opacity: 0.95 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(point);
    sphere.renderOrder = 9999;
    scene.add(sphere);
    measureSpheresRef.current.push(sphere);

    // Also add a ring around the sphere for visibility
    const ringGeo = new THREE.RingGeometry(0.18, 0.25, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff3333, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.7 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(point);
    ring.lookAt(cameraRef.current!.position);
    ring.renderOrder = 9998;
    scene.add(ring);
    measureExtrasRef.current.push(ring);

    setMeasurePoints(prev => {
      const newPoints = [...prev, point];

      if (newPoints.length === 2) {
        const dist = newPoints[0].distanceTo(newPoints[1]);
        setMeasureDistance(dist);

        const tealColor = new THREE.Color(BRAND.teal).getHex();

        // ─── Dimension line as a visible tube (WebGL ignores linewidth > 1) ───
        const direction = new THREE.Vector3().subVectors(newPoints[1], newPoints[0]);
        const lineLen = direction.length();
        const tubeRadius = Math.max(0.015, lineLen * 0.003); // Scale tube with distance
        const tubePath = new THREE.LineCurve3(newPoints[0], newPoints[1]);
        const tubeGeo = new THREE.TubeGeometry(tubePath, 1, tubeRadius, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ color: tealColor, depthTest: false, transparent: true, opacity: 0.9 });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.renderOrder = 9990;
        scene.add(tube);
        measureLineRef.current = tube;

        // ─── Arrowheads at both ends ───
        const arrowLen = Math.max(0.08, lineLen * 0.02);
        const arrowRadius = arrowLen * 0.6;
        const arrowGeo = new THREE.ConeGeometry(arrowRadius, arrowLen, 8);
        const arrowMat = new THREE.MeshBasicMaterial({ color: tealColor, depthTest: false });

        const arrow1 = new THREE.Mesh(arrowGeo, arrowMat);
        arrow1.position.copy(newPoints[0]);
        const dirNorm = direction.clone().normalize();
        arrow1.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirNorm);
        arrow1.renderOrder = 9991;
        scene.add(arrow1);
        measureExtrasRef.current.push(arrow1);

        const arrow2 = new THREE.Mesh(arrowGeo, arrowMat);
        arrow2.position.copy(newPoints[1]);
        arrow2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirNorm.clone().negate());
        arrow2.renderOrder = 9991;
        scene.add(arrow2);
        measureExtrasRef.current.push(arrow2);

        // ─── Dashed extension lines perpendicular to measurement ───
        const cam = cameraRef.current!;
        const viewDir = new THREE.Vector3().subVectors(cam.position, newPoints[0].clone().add(newPoints[1]).multiplyScalar(0.5)).normalize();
        const perpDir = new THREE.Vector3().crossVectors(dirNorm, viewDir).normalize();
        const extLen = Math.max(0.15, lineLen * 0.04);
        for (const pt of newPoints) {
          const extStart = pt.clone().addScaledVector(perpDir, extLen);
          const extEnd = pt.clone().addScaledVector(perpDir, -extLen);
          const extGeo = new THREE.BufferGeometry().setFromPoints([extStart, extEnd]);
          const extMat = new THREE.LineDashedMaterial({ color: tealColor, dashSize: 0.05, gapSize: 0.03, depthTest: false, transparent: true, opacity: 0.7 });
          const extLine = new THREE.Line(extGeo, extMat);
          extLine.computeLineDistances();
          extLine.renderOrder = 9989;
          scene.add(extLine);
          measureExtrasRef.current.push(extLine);
        }

        // ─── Text label sprite — large, high-contrast, camera-distance adaptive ───
        const canvas = document.createElement('canvas');
        const canvasW = 512;
        const canvasH = 160;
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx = canvas.getContext('2d')!;

        // Background with rounded corners
        const rr = 16;
        ctx.beginPath();
        ctx.moveTo(rr, 0); ctx.lineTo(canvasW - rr, 0); ctx.quadraticCurveTo(canvasW, 0, canvasW, rr);
        ctx.lineTo(canvasW, canvasH - rr); ctx.quadraticCurveTo(canvasW, canvasH, canvasW - rr, canvasH);
        ctx.lineTo(rr, canvasH); ctx.quadraticCurveTo(0, canvasH, 0, canvasH - rr);
        ctx.lineTo(0, rr); ctx.quadraticCurveTo(0, 0, rr, 0);
        ctx.closePath();
        ctx.fillStyle = 'rgba(20,35,65,0.92)';
        ctx.fill();
        ctx.strokeStyle = BRAND.teal;
        ctx.lineWidth = 3;
        ctx.stroke();

        // Main distance text
        const distStr = dist >= 1.0 ? `${dist.toFixed(3)} m` : `${(dist * 100).toFixed(1)} cm`;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 44px Outfit, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(distStr, canvasW / 2, 50);

        // Delta components
        const ddx = Math.abs(newPoints[1].x - newPoints[0].x);
        const ddy = Math.abs(newPoints[1].y - newPoints[0].y);
        const ddz = Math.abs(newPoints[1].z - newPoints[0].z);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '24px Outfit, Arial, sans-serif';
        ctx.fillText(`\u0394X: ${ddx.toFixed(2)}m   \u0394Y: ${ddy.toFixed(2)}m   \u0394Z: ${ddz.toFixed(2)}m`, canvasW / 2, 110);

        // Ruler icon indicator bar at top
        ctx.fillStyle = BRAND.teal;
        ctx.fillRect(16, canvasH - 8, canvasW - 32, 4);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);

        // Position label at midpoint, offset upward
        const midpoint = newPoints[0].clone().add(newPoints[1]).multiplyScalar(0.5);
        const camDist = cam.position.distanceTo(midpoint);
        // Scale sprite based on camera distance so it's always readable
        const baseScale = Math.max(1.5, camDist * 0.12);
        sprite.scale.set(baseScale * (canvasW / canvasH), baseScale, 1);
        // Offset above the line
        const upOffset = Math.max(0.5, camDist * 0.04);
        midpoint.y += upOffset;
        sprite.position.copy(midpoint);
        sprite.renderOrder = 10000;
        scene.add(sprite);
        measureLabelRef.current = sprite;
      }

      if (newPoints.length > 2) {
        // Reset for new measurement
        clearMeasurement();
        return [point];
      }

      return newPoints;
    });
  }, [measureMode, walkMode, clearMeasurement]);

  /* ─── Chain Measurement Click Handler ─── */
  const handleChainMeasureClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!measureMode || !measureChainMode || walkMode) return;
    const el = containerRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!el || !camera || !scene) return;

    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = rc.intersectObjects(meshes, false);
    if (intersects.length === 0) return;

    let point = intersects[0].point.clone();

    // Snap to edge (same logic as single measure)
    const SNAP_SCREEN_PX = 50;
    const hitMesh = intersects[0].object as THREE.Mesh;
    const geo = hitMesh.geometry;
    if (geo) {
      const edgesGeo = new THREE.EdgesGeometry(geo, 25);
      const posAttr = edgesGeo.getAttribute("position");
      if (posAttr) {
        let bestDist = Infinity;
        let bestPoint: THREE.Vector3 | null = null;
        const worldMatrix = hitMesh.matrixWorld;
        const v0 = new THREE.Vector3();
        const v1 = new THREE.Vector3();
        const projected = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i += 2) {
          v0.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
          v1.fromBufferAttribute(posAttr, i + 1).applyMatrix4(worldMatrix);
          const lineDir = new THREE.Vector3().subVectors(v1, v0);
          const lineLen = lineDir.length();
          if (lineLen < 0.001) continue;
          lineDir.normalize();
          const t = Math.max(0, Math.min(lineLen, new THREE.Vector3().subVectors(point, v0).dot(lineDir)));
          projected.copy(v0).addScaledVector(lineDir, t);
          const screenPoint = point.clone().project(camera);
          const screenProj = projected.clone().project(camera);
          const dx = (screenPoint.x - screenProj.x) * el.clientWidth * 0.5;
          const dy = (screenPoint.y - screenProj.y) * el.clientHeight * 0.5;
          const screenDist = Math.sqrt(dx * dx + dy * dy);
          if (screenDist < SNAP_SCREEN_PX && screenDist < bestDist) {
            bestDist = screenDist;
            bestPoint = projected.clone();
          }
        }
        if (bestPoint) point = bestPoint;
        edgesGeo.dispose();
      }
    }

    // Add sphere marker
    const tealHex = new THREE.Color(BRAND.teal).getHex();
    const sphereGeo = new THREE.SphereGeometry(0.1, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: tealHex, depthTest: false, transparent: true, opacity: 0.95 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(point);
    sphere.renderOrder = 9999;
    scene.add(sphere);
    measureChainObjectsRef.current.push(sphere);

    setMeasureChainPoints(prev => {
      const newPts = [...prev, point];
      if (newPts.length >= 2) {
        const lastIdx = newPts.length - 1;
        const segDist = newPts[lastIdx - 1].distanceTo(newPts[lastIdx]);
        setMeasureChainDistances(prevD => [...prevD, segDist]);

        // Draw segment tube
        const tubePath = new THREE.LineCurve3(newPts[lastIdx - 1], newPts[lastIdx]);
        const tubeRadius = Math.max(0.012, segDist * 0.003);
        const tubeGeo = new THREE.TubeGeometry(tubePath, 1, tubeRadius, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ color: tealHex, depthTest: false, transparent: true, opacity: 0.85 });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.renderOrder = 9990;
        scene.add(tube);
        measureChainObjectsRef.current.push(tube);

        // Segment label
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = 'rgba(20,35,65,0.85)';
        ctx.beginPath(); ctx.roundRect(0, 0, 256, 64, 8); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 28px Outfit, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const segStr = segDist >= 1.0 ? `${segDist.toFixed(3)} m` : `${(segDist * 100).toFixed(1)} cm`;
        ctx.fillText(segStr, 128, 32);
        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        const mid = newPts[lastIdx - 1].clone().add(newPts[lastIdx]).multiplyScalar(0.5);
        const camDist = camera.position.distanceTo(mid);
        const sc = Math.max(0.8, camDist * 0.08);
        sprite.scale.set(sc * 4, sc, 1);
        mid.y += Math.max(0.3, camDist * 0.025);
        sprite.position.copy(mid);
        sprite.renderOrder = 10000;
        scene.add(sprite);
        measureChainObjectsRef.current.push(sprite);
      }
      return newPts;
    });
  }, [measureMode, measureChainMode, walkMode]);

  /* ─── Polygon area calculation (Shoelace formula in 3D via Newell method) ─── */
  const computePolygonArea = useCallback((pts: THREE.Vector3[]): number => {
    if (pts.length < 3) return 0;
    // Newell method: compute normal and area simultaneously
    const normal = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < pts.length; i++) {
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];
      normal.x += (curr.y - next.y) * (curr.z + next.z);
      normal.y += (curr.z - next.z) * (curr.x + next.x);
      normal.z += (curr.x - next.x) * (curr.y + next.y);
    }
    return normal.length() / 2;
  }, []);

  const computePerimeter = useCallback((pts: THREE.Vector3[]): number => {
    if (pts.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      total += pts[i].distanceTo(pts[(i + 1) % pts.length]);
    }
    return total;
  }, []);

  /* ─── Area Measurement Click Handler ─── */
  const handleAreaMeasureClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!measureMode || !measureAreaMode || walkMode) return;
    const el = containerRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!el || !camera || !scene) return;

    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = rc.intersectObjects(meshes, false);
    if (intersects.length === 0) return;

    let point = intersects[0].point.clone();

    // Snap to edge
    const SNAP_SCREEN_PX = 50;
    const hitMesh = intersects[0].object as THREE.Mesh;
    const geo = hitMesh.geometry;
    if (geo) {
      const edgesGeo = new THREE.EdgesGeometry(geo, 25);
      const posAttr = edgesGeo.getAttribute("position");
      if (posAttr) {
        let bestDist = Infinity;
        let bestPoint: THREE.Vector3 | null = null;
        const worldMatrix = hitMesh.matrixWorld;
        const v0 = new THREE.Vector3();
        const v1 = new THREE.Vector3();
        const projected = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i += 2) {
          v0.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
          v1.fromBufferAttribute(posAttr, i + 1).applyMatrix4(worldMatrix);
          const lineDir = new THREE.Vector3().subVectors(v1, v0);
          const lineLen = lineDir.length();
          if (lineLen < 0.001) continue;
          lineDir.normalize();
          const t = Math.max(0, Math.min(lineLen, new THREE.Vector3().subVectors(point, v0).dot(lineDir)));
          projected.copy(v0).addScaledVector(lineDir, t);
          const screenPoint = point.clone().project(camera);
          const screenProj = projected.clone().project(camera);
          const dx = (screenPoint.x - screenProj.x) * el.clientWidth * 0.5;
          const dy = (screenPoint.y - screenProj.y) * el.clientHeight * 0.5;
          const screenDist = Math.sqrt(dx * dx + dy * dy);
          if (screenDist < SNAP_SCREEN_PX && screenDist < bestDist) {
            bestDist = screenDist;
            bestPoint = projected.clone();
          }
        }
        if (bestPoint) point = bestPoint;
        edgesGeo.dispose();
      }
    }

    // Add sphere marker (light blue for area mode)
    const areaColor = 0x4fc3f7;
    const sphereGeo = new THREE.SphereGeometry(0.1, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({ color: areaColor, depthTest: false, transparent: true, opacity: 0.95 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(point);
    sphere.renderOrder = 9999;
    scene.add(sphere);
    measureAreaObjectsRef.current.push(sphere);

    // Add point number label
    const numCanvas = document.createElement('canvas');
    numCanvas.width = 64; numCanvas.height = 64;
    const nctx = numCanvas.getContext('2d')!;
    nctx.fillStyle = 'rgba(79,195,247,0.9)';
    nctx.beginPath(); nctx.arc(32, 32, 28, 0, Math.PI * 2); nctx.fill();
    nctx.fillStyle = '#fff';
    nctx.font = 'bold 30px Outfit, Arial, sans-serif';
    nctx.textAlign = 'center'; nctx.textBaseline = 'middle';
    nctx.fillText(`${measureAreaPoints.length + 1}`, 32, 32);
    const numTex = new THREE.CanvasTexture(numCanvas);
    const numSpriteMat = new THREE.SpriteMaterial({ map: numTex, depthTest: false, transparent: true });
    const numSprite = new THREE.Sprite(numSpriteMat);
    const camDist = camera.position.distanceTo(point);
    const numScale = Math.max(0.3, camDist * 0.025);
    numSprite.scale.set(numScale, numScale, 1);
    numSprite.position.copy(point.clone().add(new THREE.Vector3(0, Math.max(0.15, camDist * 0.015), 0)));
    numSprite.renderOrder = 10001;
    scene.add(numSprite);
    measureAreaObjectsRef.current.push(numSprite);

    setMeasureAreaPoints(prev => {
      const newPts = [...prev, point];

      // Draw edge from previous point to this one
      if (newPts.length >= 2) {
        const lastIdx = newPts.length - 1;
        const segDist = newPts[lastIdx - 1].distanceTo(newPts[lastIdx]);

        // Solid line for area edges
        const tubePath = new THREE.LineCurve3(newPts[lastIdx - 1], newPts[lastIdx]);
        const tubeRadius = Math.max(0.01, segDist * 0.003);
        const tubeGeo = new THREE.TubeGeometry(tubePath, 1, tubeRadius, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ color: areaColor, depthTest: false, transparent: true, opacity: 0.85 });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        tube.renderOrder = 9990;
        scene.add(tube);
        measureAreaObjectsRef.current.push(tube);

        // Segment distance label
        const sCanvas = document.createElement('canvas');
        sCanvas.width = 192; sCanvas.height = 48;
        const sctx = sCanvas.getContext('2d')!;
        sctx.fillStyle = 'rgba(20,35,65,0.8)';
        sctx.beginPath(); sctx.roundRect(0, 0, 192, 48, 8); sctx.fill();
        sctx.fillStyle = '#ffffff';
        sctx.font = 'bold 22px Outfit, Arial, sans-serif';
        sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        const segStr = segDist >= 1.0 ? `${segDist.toFixed(2)} m` : `${(segDist * 100).toFixed(0)} cm`;
        sctx.fillText(segStr, 96, 24);
        const sTex = new THREE.CanvasTexture(sCanvas);
        const sSpriteMat = new THREE.SpriteMaterial({ map: sTex, depthTest: false, transparent: true });
        const sSprite = new THREE.Sprite(sSpriteMat);
        const mid = newPts[lastIdx - 1].clone().add(newPts[lastIdx]).multiplyScalar(0.5);
        const cd = camera.position.distanceTo(mid);
        const sc = Math.max(0.5, cd * 0.05);
        sSprite.scale.set(sc * 4, sc, 1);
        mid.y += Math.max(0.15, cd * 0.015);
        sSprite.position.copy(mid);
        sSprite.renderOrder = 10000;
        scene.add(sSprite);
        measureAreaObjectsRef.current.push(sSprite);
      }

      // If 3+ points, draw closing edge and compute area
      if (newPts.length >= 3) {
        // Remove previous closing edge if any
        const closingTag = '__area_closing_edge__';
        measureAreaObjectsRef.current = measureAreaObjectsRef.current.filter(o => {
          if ((o as any).__tag === closingTag) { scene.remove(o); return false; }
          return true;
        });

        // Draw closing edge (dashed)
        const closingGeo = new THREE.BufferGeometry().setFromPoints([newPts[newPts.length - 1], newPts[0]]);
        const closingMat = new THREE.LineDashedMaterial({ color: areaColor, dashSize: 0.12, gapSize: 0.06, depthTest: false, transparent: true, opacity: 0.6 });
        const closingLine = new THREE.Line(closingGeo, closingMat);
        closingLine.computeLineDistances();
        closingLine.renderOrder = 9989;
        (closingLine as any).__tag = closingTag;
        scene.add(closingLine);
        measureAreaObjectsRef.current.push(closingLine);

        // Semi-transparent fill polygon
        const fillTag = '__area_fill__';
        measureAreaObjectsRef.current = measureAreaObjectsRef.current.filter(o => {
          if ((o as any).__tag === fillTag) { scene.remove(o); return false; }
          return true;
        });

        // Create filled polygon using ShapeGeometry projected onto the polygon plane
        const polyNormal = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < newPts.length; i++) {
          const curr = newPts[i];
          const nxt = newPts[(i + 1) % newPts.length];
          polyNormal.x += (curr.y - nxt.y) * (curr.z + nxt.z);
          polyNormal.y += (curr.z - nxt.z) * (curr.x + nxt.x);
          polyNormal.z += (curr.x - nxt.x) * (curr.y + nxt.y);
        }
        polyNormal.normalize();

        // Project points to 2D for triangulation
        const centroid = new THREE.Vector3();
        newPts.forEach(p => centroid.add(p));
        centroid.divideScalar(newPts.length);

        // Create basis vectors for the polygon plane
        const up = Math.abs(polyNormal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const basisU = new THREE.Vector3().crossVectors(polyNormal, up).normalize();
        const basisV = new THREE.Vector3().crossVectors(polyNormal, basisU).normalize();

        const pts2D = newPts.map(p => {
          const rel = p.clone().sub(centroid);
          return new THREE.Vector2(rel.dot(basisU), rel.dot(basisV));
        });

        const shape = new THREE.Shape(pts2D);
        const shapeGeo = new THREE.ShapeGeometry(shape);

        // Transform back to 3D
        const posAttr = shapeGeo.getAttribute('position');
        for (let i = 0; i < posAttr.count; i++) {
          const u = posAttr.getX(i);
          const v = posAttr.getY(i);
          const p3d = centroid.clone()
            .addScaledVector(basisU, u)
            .addScaledVector(basisV, v);
          posAttr.setXYZ(i, p3d.x, p3d.y, p3d.z);
        }
        posAttr.needsUpdate = true;
        shapeGeo.computeVertexNormals();

        const fillMat = new THREE.MeshBasicMaterial({
          color: areaColor,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide,
          depthTest: false,
        });
        const fillMesh = new THREE.Mesh(shapeGeo, fillMat);
        fillMesh.renderOrder = 9970;
        (fillMesh as any).__tag = fillTag;
        scene.add(fillMesh);
        measureAreaObjectsRef.current.push(fillMesh);

        // Compute and set area result
        const area = computePolygonArea(newPts);
        const perimeter = computePerimeter(newPts);
        setMeasureAreaResult({ area, perimeter });
      }

      return newPts;
    });
  }, [measureMode, measureAreaMode, walkMode, measureAreaPoints, computePolygonArea, computePerimeter]);

  /* ═══════════════════════════════════════════════════
     Screenshot
     ═══════════════════════════════════════════════════ */
  const takeScreenshot = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    setScreenshotting(true);

    // ─── Render at 2x resolution for high-detail export ───
    const srcCanvas = renderer.domElement;
    const scale = 2; // 2x native resolution
    const hiResW = srcCanvas.width * scale;
    const hiResH = srcCanvas.height * scale;

    // Temporarily resize renderer for hi-res capture
    const origW = renderer.domElement.width;
    const origH = renderer.domElement.height;
    renderer.setSize(hiResW, hiResH, false);
    camera.aspect = hiResW / hiResH;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);

    // Create offscreen canvas with metadata overlay
    const offscreen = document.createElement("canvas");
    offscreen.width = hiResW;
    offscreen.height = hiResH;
    const ctx = offscreen.getContext("2d");
    if (!ctx) {
      // Restore original size
      renderer.setSize(origW, origH, false);
      camera.aspect = origW / origH;
      camera.updateProjectionMatrix();
      setScreenshotting(false);
      return;
    }

    // Draw the hi-res 3D render
    ctx.drawImage(renderer.domElement, 0, 0);

    // Restore renderer to original size immediately
    renderer.setSize(origW, origH, false);
    camera.aspect = origW / origH;
    camera.updateProjectionMatrix();

    const projectName = project?.name || "ObjetivaAR";
    const now = new Date();
    const dateStr = now.toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // ─── Bottom metadata bar ───
    const barH = Math.round(56 * scale);
    const barY = hiResH - barH;
    ctx.fillStyle = "rgba(27, 42, 74, 0.90)";
    ctx.fillRect(0, barY, hiResW, barH);

    // Teal accent line at top of bar
    ctx.fillStyle = BRAND.teal;
    ctx.fillRect(0, barY, hiResW, 3 * scale);

    // Left side: Project name + date
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `bold ${16 * scale}px Outfit, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(projectName, 16 * scale, barY + barH * 0.5);

    // Center: Level + disciplines info
    ctx.textAlign = "center";
    ctx.font = `${13 * scale}px Outfit, system-ui, sans-serif`;
    const levelInfo = floorIsolation && isolatedFloorIdx !== null
      ? FLOOR_LEVELS[isolatedFloorIdx].label
      : "Vista completa";
    const visibleDisciplines = files
      .filter((f: any) => layers[f.specialty]?.visible && layers[f.specialty]?.loaded)
      .map((f: any) => f.specialty);
    const discStr = visibleDisciplines.length === files.filter((f: any) => layers[f.specialty]?.loaded).length
      ? "Todas las disciplinas"
      : visibleDisciplines.join(" | ");
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`${levelInfo}  \u2022  ${discStr}`, hiResW / 2, barY + barH * 0.5);

    // Right side: Date + time
    ctx.textAlign = "right";
    ctx.font = `${12 * scale}px Outfit, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(`${dateStr}  ${timeStr}`, hiResW - 16 * scale, barY + barH * 0.5);

    // ─── Top-right watermark ───
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(0, 168, 157, 0.6)";
    ctx.font = `bold ${14 * scale}px Outfit, system-ui, sans-serif`;
    ctx.fillText("ObjetivaAR", hiResW - 12 * scale, 22 * scale);

    // ─── Camera position (small, top-left) ───
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = `${10 * scale}px monospace`;
    const camStr = `Cam: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`;
    ctx.fillText(camStr, 12 * scale, 18 * scale);

    // ─── Clipping info if active ───
    if (clippingEnabled || (floorIsolation && isolatedFloorIdx !== null)) {
      ctx.fillStyle = "rgba(245, 158, 11, 0.7)";
      ctx.font = `${10 * scale}px Outfit, system-ui, sans-serif`;
      const clipStr = floorIsolation && isolatedFloorIdx !== null
        ? `Corte: ${FLOOR_LEVELS[isolatedFloorIdx].label} (+${FLOOR_LEVELS[isolatedFloorIdx].y.toFixed(1)}m)`
        : `Corte: ${clippingAxis.toUpperCase()} = ${clippingHeight.toFixed(2)}m`;
      ctx.fillText(clipStr, 12 * scale, 34 * scale);
    }

    // ─── Measurement info if present ───
    if (measureDistance !== null && measurePoints.length === 2) {
      ctx.fillStyle = "rgba(0, 168, 157, 0.7)";
      ctx.font = `bold ${11 * scale}px Outfit, system-ui, sans-serif`;
      const measStr = measureDistance >= 1.0
        ? `Medici\u00f3n: ${measureDistance.toFixed(3)} m`
        : `Medici\u00f3n: ${(measureDistance * 100).toFixed(1)} cm`;
      ctx.fillText(measStr, 12 * scale, 50 * scale);
    }

    // ─── Export as high-quality PNG ───
    const dataUrl = offscreen.toDataURL("image/png");
    const link = document.createElement('a');
    const safeProjectName = projectName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    const levelSuffix = floorIsolation && isolatedFloorIdx !== null
      ? `_${FLOOR_LEVELS[isolatedFloorIdx].short}`
      : "";
    link.download = `OAR_${safeProjectName}${levelSuffix}_${now.toISOString().slice(0,19).replace(/[T:]/g, '-')}.png`;
    link.href = dataUrl;
    link.click();

    toast.success("Captura exportada", {
      description: `${hiResW}x${hiResH}px \u2022 ${levelInfo}`,
    });

    setTimeout(() => setScreenshotting(false), 500);
  }, [project?.name, floorIsolation, isolatedFloorIdx, files, layers, clippingEnabled, clippingHeight, clippingAxis, measureDistance, measurePoints]);

  /* ═══════════════════════════════════════════════════
     Floor Teleport (walk mode)
     ═══════════════════════════════════════════════════ */
  const teleportToFloor = useCallback((floorY: number) => {
    const cam = cameraRef.current;
    if (!cam || !walkModeRef.current) return;

    // Find the model's min Y to offset floors correctly
    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });
    const baseY = box.isEmpty() ? 0 : box.min.y;

    const targetY = baseY + floorY + walkHeightRef.current;
    targetPosRef.current.y = targetY;
    currentFloorY.current = targetY;
    cam.position.y = targetY;
    setShowFloorPicker(false);
  }, []);

  /* ═══════════════════════════════════════════════════
     Zoom Controls (FOV + Dolly hybrid)
     ═══════════════════════════════════════════════════ */
  const handleZoom = useCallback((direction: "in" | "out") => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    if (walkMode) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const speed = walkSpeedRef.current;
      targetPosRef.current.addScaledVector(dir, direction === "in" ? speed * 3 : -speed * 3);
    } else {
      const dist = camera.position.distanceTo(controls.target);

      // If very close or very far, adjust FOV instead of dolly
      if (direction === "in" && dist < DOLLY_NEAR_THRESHOLD) {
        camera.fov = Math.max(MIN_FOV, camera.fov - 3);
        camera.updateProjectionMatrix();
      } else if (direction === "out" && dist > DOLLY_FAR_THRESHOLD) {
        camera.fov = Math.min(MAX_FOV, camera.fov + 3);
        camera.updateProjectionMatrix();
      } else {
        // Standard dolly
        const factor = direction === "in" ? 0.65 : 1.55;
        const offset = camera.position.clone().sub(controls.target);
        offset.multiplyScalar(factor);
        camera.position.copy(controls.target).add(offset);
        controls.update();
      }
    }
  }, [walkMode]);

  /* ═══════════════════════════════════════════════════
     Clipping Plane
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Determine effective clipping: floor isolation takes priority when active
    const floorIsoActive = floorIsolation && isolatedFloorIdx !== null;
    let effectiveClip = clippingEnabled;
    let effectiveHeight = clippingHeight;
    let effectiveAxis = clippingAxis;

    if (floorIsoActive) {
      effectiveClip = true;
      effectiveAxis = "y";
      // Clip at the ceiling of the selected floor (= floor of the next level)
      const nextIdx = isolatedFloorIdx! + 1;
      if (nextIdx < FLOOR_LEVELS.length) {
        effectiveHeight = FLOOR_LEVELS[nextIdx].y;
      } else {
        // Last floor (Azotea) — clip 5m above
        effectiveHeight = FLOOR_LEVELS[isolatedFloorIdx!].y + 5;
      }
    }

    if (effectiveClip) {
      const normal = new THREE.Vector3(
        effectiveAxis === "x" ? -1 : 0,
        effectiveAxis === "y" ? -1 : 0,
        effectiveAxis === "z" ? -1 : 0
      );
      const plane = new THREE.Plane(normal, effectiveHeight);
      clippingPlaneRef.current = plane;

      scene.traverse((child) => {
        if ((child as any).isMesh || (child as any).isLineSegments || (child as any).isInstancedMesh) {
          const obj = child as THREE.Mesh;
          if (obj.material && !Array.isArray(obj.material)) {
            (obj.material as THREE.Material).clippingPlanes = [plane];
            (obj.material as THREE.Material).needsUpdate = true;
          }
        }
      });
    } else {
      clippingPlaneRef.current = null;
      scene.traverse((child) => {
        if ((child as any).isMesh || (child as any).isLineSegments || (child as any).isInstancedMesh) {
          const obj = child as THREE.Mesh;
          if (obj.material && !Array.isArray(obj.material)) {
            (obj.material as THREE.Material).clippingPlanes = [];
            (obj.material as THREE.Material).needsUpdate = true;
          }
        }
      });
    }
  }, [clippingEnabled, clippingHeight, clippingAxis, floorIsolation, isolatedFloorIdx]);

  /* ═══════════════════════════════════════════════════
     Element Type Filter (applies visibility based on elementType)
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (!clippingEnabled) return;
    // Apply element type filter to all meshes
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as any).isMesh) return;
        const mesh = child as THREE.Mesh;
        const elType = mesh.userData?.elementType || "other";
        const shouldShow = elementTypeFilter[elType] !== false;
        // Only modify visibility based on element type, respect layer visibility
        mesh.visible = shouldShow;
      });
      // Also apply to edge groups
      const edgeGroupName = `${layer.group.name}_edges`;
      const scene = sceneRef.current;
      if (!scene) return;
      const edgeGroup = scene.getObjectByName(edgeGroupName) as THREE.Group;
      if (edgeGroup) {
        const meshChildren = layer.group.children;
        edgeGroup.children.forEach((edge, idx) => {
          if (idx < meshChildren.length) {
            edge.visible = meshChildren[idx].visible;
          }
        });
      }
    });
  }, [clippingEnabled, elementTypeFilter]);

  // Reset element type filter visibility when clipping is disabled
  useEffect(() => {
    if (clippingEnabled) return;
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as any).isMesh) return;
        child.visible = true;
      });
    });
  }, [clippingEnabled]);

  /* ═══════════════════════════════════════════════════
     Visual Clipping Plane (semi-transparent colored mesh)
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove existing visual plane
    if (clipVisualPlaneRef.current) {
      scene.remove(clipVisualPlaneRef.current);
      clipVisualPlaneRef.current.geometry.dispose();
      (clipVisualPlaneRef.current.material as THREE.Material).dispose();
      clipVisualPlaneRef.current = null;
    }

    // Hide grid when clipping is active (cleaner section view)
    const effectiveClipActive = clippingEnabled || (floorIsolation && isolatedFloorIdx !== null);
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = effectiveClipActive ? false : showGrid;
    }

    if (!effectiveClipActive) return;

    // No colored visual plane — clean section cut without slab color
    // The clipping plane itself (THREE.Plane) handles the geometry cut

    return () => {
      if (clipVisualPlaneRef.current) {
        scene.remove(clipVisualPlaneRef.current);
        clipVisualPlaneRef.current.geometry.dispose();
        (clipVisualPlaneRef.current.material as THREE.Material).dispose();
        clipVisualPlaneRef.current = null;
      }
    };
  }, [clippingEnabled, clippingHeight, clippingAxis, showGrid, floorIsolation, isolatedFloorIdx]);

  /* ═══════════════════════════════════════════════════
     Dimension Annotations (plan X/Z, section Y)
     ═══════════════════════════════════════════════════ */
  const dimGroupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove previous dimension annotations
    if (dimGroupRef.current) {
      scene.remove(dimGroupRef.current);
      dimGroupRef.current.traverse((child) => {
        if ((child as any).geometry) (child as any).geometry.dispose();
        if ((child as any).material) {
          const mat = (child as any).material;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      });
      dimGroupRef.current = null;
    }

    if (!clippingEnabled) return;

    // Compute bounding boxes per layer
    const layerBoxes: { key: string; label: string; box: THREE.Box3; color: string }[] = [];
    Object.entries(layersRef.current).forEach(([key, layer]) => {
      if (!layer.group || !layer.visible || !layer.loaded) return;
      const box = new THREE.Box3().setFromObject(layer.group);
      if (box.isEmpty()) return;
      const fileInfo = files.find((f: any) => f.specialty === key);
      layerBoxes.push({
        key,
        label: fileInfo?.label || key,
        box,
        color: fileInfo?.color || "#999",
      });
    });

    if (layerBoxes.length === 0) return;

    const dimGroup = new THREE.Group();
    dimGroup.name = "__dimension_annotations";

    // Helper: create a text sprite
    const createTextSprite = (text: string, color: string, fontSize: number = 48): THREE.Sprite => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      canvas.width = 512;
      canvas.height = 128;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Background pill
      const metrics = ctx.measureText(text);
      ctx.font = `bold ${fontSize}px monospace`;
      const textW = ctx.measureText(text).width;
      const pillW = textW + 40;
      const pillH = fontSize + 20;
      const pillX = (canvas.width - pillW) / 2;
      const pillY = (canvas.height - pillH) / 2;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 8);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Text
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);

      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(3, 0.75, 1);
      sprite.renderOrder = 1000;
      return sprite;
    };

    // Helper: create a dimension line with arrows
    const createDimLine = (start: THREE.Vector3, end: THREE.Vector3, color: string): THREE.Group => {
      const g = new THREE.Group();
      const dir = end.clone().sub(start);
      const len = dir.length();
      if (len < 0.01) return g;

      // Main line
      const lineGeo = new THREE.BufferGeometry().setFromPoints([start, end]);
      const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 });
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 999;
      g.add(line);

      // Arrow heads (small cones)
      const arrowLen = Math.min(0.3, len * 0.08);
      const arrowGeo = new THREE.ConeGeometry(arrowLen * 0.4, arrowLen, 6);
      const arrowMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 });

      // Arrow at start (pointing toward start)
      const arrow1 = new THREE.Mesh(arrowGeo, arrowMat);
      arrow1.position.copy(start);
      arrow1.lookAt(end);
      arrow1.rotateX(Math.PI / 2);
      arrow1.renderOrder = 999;
      g.add(arrow1);

      // Arrow at end (pointing toward end)
      const arrow2 = new THREE.Mesh(arrowGeo.clone(), arrowMat);
      arrow2.position.copy(end);
      arrow2.lookAt(start);
      arrow2.rotateX(Math.PI / 2);
      arrow2.renderOrder = 999;
      g.add(arrow2);

      return g;
    };

    if (clippingAxis === "y") {
      // PLAN VIEW: show X and Z dimensions for each layer bounding box
      layerBoxes.forEach((lb) => {
        const { box, color } = lb;
        const sizeX = box.max.x - box.min.x;
        const sizeZ = box.max.z - box.min.z;
        const y = clippingHeight + 0.05; // slightly above cut plane

        // X dimension line (along bottom edge)
        const xStart = new THREE.Vector3(box.min.x, y, box.max.z + 0.5);
        const xEnd = new THREE.Vector3(box.max.x, y, box.max.z + 0.5);
        const xDim = createDimLine(xStart, xEnd, color);
        dimGroup.add(xDim);

        // X label
        const xLabel = createTextSprite(`${sizeX.toFixed(2)} m`, color, 40);
        xLabel.position.copy(xStart.clone().add(xEnd).multiplyScalar(0.5));
        xLabel.position.z += 0.3;
        dimGroup.add(xLabel);

        // Z dimension line (along right edge)
        const zStart = new THREE.Vector3(box.max.x + 0.5, y, box.min.z);
        const zEnd = new THREE.Vector3(box.max.x + 0.5, y, box.max.z);
        const zDim = createDimLine(zStart, zEnd, color);
        dimGroup.add(zDim);

        // Z label
        const zLabel = createTextSprite(`${sizeZ.toFixed(2)} m`, color, 40);
        zLabel.position.copy(zStart.clone().add(zEnd).multiplyScalar(0.5));
        zLabel.position.x += 0.3;
        dimGroup.add(zLabel);
      });
    } else {
      // SECTION VIEW (X or Z cut): show Y height for each layer
      layerBoxes.forEach((lb) => {
        const { box, color } = lb;
        const sizeY = box.max.y - box.min.y;
        const cutPos = clippingHeight;

        // Position the dimension line at the cut plane
        let lineX: number, lineZ: number;
        if (clippingAxis === "x") {
          lineX = cutPos + 0.5;
          lineZ = (box.min.z + box.max.z) / 2;
        } else {
          lineX = (box.min.x + box.max.x) / 2;
          lineZ = cutPos + 0.5;
        }

        // Y dimension line (vertical)
        const yStart = new THREE.Vector3(lineX, box.min.y, lineZ);
        const yEnd = new THREE.Vector3(lineX, box.max.y, lineZ);
        const yDim = createDimLine(yStart, yEnd, color);
        dimGroup.add(yDim);

        // Y label
        const yLabel = createTextSprite(`${sizeY.toFixed(2)} m`, color, 40);
        yLabel.position.copy(yStart.clone().add(yEnd).multiplyScalar(0.5));
        if (clippingAxis === "x") {
          yLabel.position.x += 0.5;
        } else {
          yLabel.position.z += 0.5;
        }
        dimGroup.add(yLabel);
      });
    }

    scene.add(dimGroup);
    dimGroupRef.current = dimGroup;

    return () => {
      if (dimGroupRef.current) {
        scene.remove(dimGroupRef.current);
        dimGroupRef.current.traverse((child) => {
          if ((child as any).geometry) (child as any).geometry.dispose();
          if ((child as any).material) {
            const mat = (child as any).material;
            if (mat.map) mat.map.dispose();
            mat.dispose();
          }
        });
        dimGroupRef.current = null;
      }
    };
  }, [clippingEnabled, clippingHeight, clippingAxis, layers, files]);

  /* ═══════════════════════════════════════════════════
     Clipping Plane Drag in Viewport
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    const el = containerRef.current;
    const camera = cameraRef.current;
    if (!el || !camera) return;
    if (!clippingEnabled) {
      clipDraggingRef.current = false;
      return;
    }

    let startY = 0;
    let startHeight = 0;

    const getAxisSensitivity = () => {
      // Map screen pixels to world units based on camera distance and model bounds
      const range = modelBounds.max - modelBounds.min;
      return range / el.clientHeight; // units per pixel
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only activate drag with middle mouse button (button=1) or with Shift+left click
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        clipDraggingRef.current = true;
        setClipDragging(true);
        startY = e.clientY;
        startHeight = clippingHeight;
        if (controlsRef.current) controlsRef.current.enabled = false;
        el.setPointerCapture(e.pointerId);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!clipDraggingRef.current) return;
      const deltaY = startY - e.clientY; // Up = positive
      const sensitivity = getAxisSensitivity();
      const newHeight = Math.max(modelBounds.min, Math.min(modelBounds.max, startHeight + deltaY * sensitivity));
      setClippingHeight(newHeight);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!clipDraggingRef.current) return;
      clipDraggingRef.current = false;
      setClipDragging(false);
      if (controlsRef.current && !walkModeRef.current) controlsRef.current.enabled = true;
      el.releasePointerCapture(e.pointerId);
    };

    // Two-finger vertical touch gesture for mobile clip drag
    let touchStartY = 0;
    let touchStartHeight = 0;
    let twoFingerActive = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        twoFingerActive = true;
        clipDraggingRef.current = true;
        setClipDragging(true);
        touchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        touchStartHeight = clippingHeight;
        if (controlsRef.current) controlsRef.current.enabled = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!twoFingerActive || e.touches.length < 2) return;
      e.preventDefault();
      const avgY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const deltaY = touchStartY - avgY;
      const sensitivity = getAxisSensitivity();
      const newHeight = Math.max(modelBounds.min, Math.min(modelBounds.max, touchStartHeight + deltaY * sensitivity));
      setClippingHeight(newHeight);
    };

    const onTouchEnd = () => {
      if (!twoFingerActive) return;
      twoFingerActive = false;
      clipDraggingRef.current = false;
      setClipDragging(false);
      if (controlsRef.current && !walkModeRef.current) controlsRef.current.enabled = true;
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [clippingEnabled, clippingHeight, modelBounds]);

  /* ═══════════════════════════════════════════════════
     Raycasting (click on element)
     ═══════════════════════════════════════════════════ */
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Handle annotation mode click
    if (annotationMode && !walkMode) {
      handleAnnotationClick(e);
      return;
    }
    if (walkMode) return;
    const el = containerRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!el || !camera || !scene) return;

    const rect = el.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, camera);

    const meshes: THREE.Mesh[] = [];
    Object.values(layersRef.current).forEach((layer) => {
      if (layer.group && layer.visible) {
        layer.group.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
        });
      }
    });

    const intersects = raycasterRef.current.intersectObjects(meshes, false);

    // Inspection paint mode: touch = green Objetiva (MEP only, skip architecture/structure)
    if (inspectionMode && intersects.length > 0) {
      const mesh = intersects[0].object as THREE.Mesh;
      // Skip architecture/structure — only MEP elements are paintable
      const meshSpecialty = (mesh.userData.fileSpecialty || "").toLowerCase();
      if (ARCH_SPECIALTIES.includes(meshSpecialty) || /arch|struct|arq|estruct/i.test(meshSpecialty)) {
        return; // Don't paint architecture/structure
      }
      const meshId = mesh.uuid;
      const isPainted = paintedMeshesRef.current.has(meshId);
      if (isPainted) {
        // Unpaint: restore original material
        paintedMeshesRef.current.delete(meshId);
        if (mesh.userData._originalMaterial) {
          mesh.material = mesh.userData._originalMaterial;
          delete mesh.userData._originalMaterial;
        }
      } else {
        // Paint green Objetiva
        paintedMeshesRef.current.set(meshId, {
          fileId: mesh.userData.fileId ?? 0,
          meshName: mesh.name || `mesh_${mesh.userData.meshIndex ?? 0}`,
          meshIndex: mesh.userData.meshIndex ?? 0,
        });
        if (!mesh.userData._originalMaterial) {
          mesh.userData._originalMaterial = mesh.material;
        }
        const greenMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(BRAND.teal).getHex(),
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          roughness: 0.4,
          metalness: 0.1,
        });
        mesh.material = greenMat;
      }
      setPaintedCount(paintedMeshesRef.current.size);
      // Debounced auto-save to DB
      if (saveMarksTimerRef.current) clearTimeout(saveMarksTimerRef.current);
      saveMarksTimerRef.current = setTimeout(() => {
        const marks = Array.from(paintedMeshesRef.current.values());
        saveInspectionMarksMutation.mutate({ projectId, marks });
      }, 2000);
      return;
    }

    if (highlightRef.current?.parent) {
      highlightRef.current.parent.remove(highlightRef.current);
      highlightRef.current = null;
    }

    if (intersects.length > 0) {
      const mesh = intersects[0].object as THREE.Mesh;

      const hlMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(BRAND.teal).getHex(),
        transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false,
      });
      const hl = new THREE.Mesh(mesh.geometry, hlMat);
      hl.matrixAutoUpdate = false;
      hl.matrix.copy(mesh.matrix);
      hl.renderOrder = 999;
      mesh.parent?.add(hl);
      highlightRef.current = hl;

      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      setSelectedInfo({
        name: mesh.userData.specialty || "Elemento",
        specialty: mesh.userData.fileSpecialty || "—",
        position: { x: +center.x.toFixed(2), y: +center.y.toFixed(2), z: +center.z.toFixed(2) },
        size: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
      });
      setActiveTab("info");
      if (isMobile) {
        setPanelOpen(true);
        setBottomSheetExpanded(true);
      }
    } else {
      setSelectedInfo(null);
    }
  }, [walkMode, isMobile, annotationMode, handleAnnotationClick, inspectionMode]);

  /* ═══════════════════════════════════════════════════
     Update walk position display + floor indicator + minimap
     ═══════════════════════════════════════════════════ */
  useEffect(() => {
    if (!walkMode) return;
    const interval = setInterval(() => {
      const cam = cameraRef.current;
      if (cam) {
        setWalkPos({ x: +cam.position.x.toFixed(1), y: +cam.position.y.toFixed(1), z: +cam.position.z.toFixed(1) });
        const floorY = cam.position.y - walkHeightRef.current;
        // Auto-detect current floor from FLOOR_LEVELS
        let detected = "";
        for (let i = FLOOR_LEVELS.length - 1; i >= 0; i--) {
          if (floorY >= FLOOR_LEVELS[i].y - 1.5) {
            detected = FLOOR_LEVELS[i].short;
            break;
          }
        }
        setCurrentFloor(detected || `${floorY.toFixed(1)}m`);

        if (showMinimap) drawMinimap();
      }
    }, 150);
    return () => clearInterval(interval);
  }, [walkMode, showMinimap, drawMinimap]);

  /* ─── Computed ─── */
  const anyLoading = Object.values(layers).some((l) => l.loading);
  const loadedCount = Object.values(layers).filter((l) => l.loaded && !l.loading).length;
  const totalProgress = Object.values(layers).reduce((sum, l) => sum + (l.loading ? l.progress : l.loaded ? 100 : 0), 0);
  const layerCount = Object.keys(layers).length;
  const overallProgress = layerCount > 0 ? Math.round(totalProgress / layerCount) : 0;
  const currentlyLoading = Object.entries(layers).find(([, l]) => l.loading);
  const currentLoadingName = currentlyLoading ? currentlyLoading[0] : null;

  /* ═══════════════════════════════════════════════════
     Layer Toggle All
     ═══════════════════════════════════════════════════ */
  const toggleAllLayers = useCallback((visible: boolean) => {
    Object.keys(layers).forEach((key) => {
      const l = layersRef.current[key];
      if (l?.loaded && l.group) {
        l.group.visible = visible;
        if (l.edgeGroup) l.edgeGroup.visible = visible;
      }
    });
    setLayers((prev) => {
      const n = { ...prev };
      for (const k of Object.keys(n)) n[k] = { ...n[k], visible };
      return n;
    });
  }, [layers]);
  /* ═════════════════════════════════════════════════
     Wall Visibility / Opacity Toggle
     ═════════════════════════════════════════════════ */
  const toggleWalls = useCallback((visible: boolean) => {
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        if (child.userData?.elementType === "wall") {
          child.visible = visible;
        }
      });
    });
    setWallsVisible(visible);
  }, []);

  const applyWallOpacity = useCallback((opacity: number) => {
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group) return;
      layer.group.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        if (child.userData?.elementType === "wall") {
          const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;
          if (!mat || Array.isArray(mat)) return;
          mat.opacity = opacity / 100;
          mat.transparent = opacity < 100;
          mat.depthWrite = opacity >= 90;
          mat.needsUpdate = true;
        }
      });
    });
    setWallOpacity(opacity);
  }, []);

  /* ═════════════════════════════════════════════════
     Apply Custom Color to Specialty
     ═════════════════════════════════════════════════ */
  const applyCustomColor = useCallback((specialty: string, newColor: string) => {
    setCustomColors(prev => ({ ...prev, [specialty]: newColor }));
    const layer = layersRef.current[specialty];
    if (!layer?.group) return;

    const vs = visualSettingsRef.current[specialty] || { hueShift: 0, saturation: 1, opacity: 100, edgeThickness: 1, edgeColor: "#999999" };
    const baseColor = new THREE.Color(newColor);
    const hsl = { h: 0, s: 0, l: 0 };
    baseColor.getHSL(hsl);
    hsl.h = ((hsl.h + vs.hueShift / 360) % 1 + 1) % 1;
    hsl.s = Math.min(1, hsl.s * vs.saturation);
    const finalColor = new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l);

    layer.group.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      mat.color.copy(finalColor);
      mat.needsUpdate = true;
    });
  }, []);

  /* ═════════════════════════════════════════════════
     Hide Furniture (Mobiliario) Toggle
     ═════════════════════════════════════════════════ */
  const [hideFurniture, setHideFurniture] = useState(false);
  const toggleFurniture = useCallback(() => {
    // Hide/show meshes whose name contains furniture-related IFC keywords
    const FURNITURE_KEYWORDS = ["furnish", "furniture", "mueble", "mobiliario", "IfcFurnishing", "IfcFurniture"];
    Object.entries(layersRef.current).forEach(([, layer]) => {
      if (!layer.group) return;
      layer.group.traverse((child) => {
        const name = (child.name || "").toLowerCase();
        const userData = (child.userData?.specialty || "").toLowerCase();
        const match = FURNITURE_KEYWORDS.some(kw => name.includes(kw.toLowerCase()) || userData.includes(kw.toLowerCase()));
        if (match) child.visible = hideFurniture; // toggle: if currently hidden, show; vice versa
      });
    });
    setHideFurniture(prev => !prev);
  }, [hideFurniture]);

  /* ═══════════════════════════════════════════════════
     Add Files to Existing Project
     ═══════════════════════════════════════════════════ */
  const [cacheVersion, setCacheVersion] = useState(0);

  // CacheInfo component to display cache size
  const CacheInfo = useCallback(() => {
    const [size, setSize] = useState<string>("...");
    useEffect(() => {
      getCacheSize().then(bytes => {
        if (bytes < 1024 * 1024) setSize(`${(bytes / 1024).toFixed(0)} KB`);
        else setSize(`${(bytes / 1024 / 1024).toFixed(1)} MB`);
      });
    }, [cacheVersion]);
    return <span className="text-xs font-mono font-semibold" style={{ color: BRAND.teal }}>{size}</span>;
  }, [cacheVersion]);

  // Offline pre-cache state
  const [offlineDownloading, setOfflineDownloading] = useState(false);
  const [offlineProgress, setOfflineProgress] = useState<{ current: number; total: number; currentFile: string; pct: number }>({ current: 0, total: 0, currentFile: '', pct: 0 });

  const downloadAllForOffline = useCallback(async () => {
    if (offlineDownloading || !files.length) return;
    setOfflineDownloading(true);
    const filesToCache = files.filter(f => f.fileKey);
    const total = filesToCache.length;
    let completed = 0;
    setOfflineProgress({ current: 0, total, currentFile: '', pct: 0 });

    for (const f of filesToCache) {
      const cacheKey = f.fileKey!;
      const cached = await isCached(cacheKey);
      if (cached.cached) {
        completed++;
        setOfflineProgress({ current: completed, total, currentFile: f.label || f.specialty, pct: Math.round((completed / total) * 100) });
        continue;
      }
      // Resolve URL
      let url = f.url;
      const gzKey = (f as any).gzFileKey;
      if (f.fileKey || gzKey) {
        try {
          const res = await fetch(`/api/trpc/project.getFileUrl?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { fileKey: gzKey || f.fileKey } } }))}`);
          const json = await res.json();
          url = json?.[0]?.result?.data?.json?.url || url;
        } catch { /* use fallback */ }
      }
      const proxyUrl = `/api/proxy-glb?url=${encodeURIComponent(url)}`;
      setOfflineProgress({ current: completed, total, currentFile: f.label || f.specialty, pct: Math.round((completed / total) * 100) });
      try {
        await fetchGLBWithCache(cacheKey, proxyUrl);
      } catch (err) {
        console.warn(`[Offline] Failed to cache ${f.specialty}:`, err);
      }
      completed++;
      setOfflineProgress({ current: completed, total, currentFile: f.label || f.specialty, pct: Math.round((completed / total) * 100) });
    }
    setOfflineDownloading(false);
    setCacheVersion(v => v + 1);
    toast.success(`${completed}/${total} archivos descargados para uso offline`);
  }, [files, offlineDownloading]);

  const [showAddFileDialog, setShowAddFileDialog] = useState(false);
  const [addFileUploading, setAddFileUploading] = useState<Record<string, number>>({});
  const [addFileSuccess, setAddFileSuccess] = useState<string[]>([]);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const [addFileSpecialty, setAddFileSpecialty] = useState("");

  // Drag & drop state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Drag & drop handlers on the 3D viewport
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    dragCounterRef.current = 0;

    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith(".glb") || name.endsWith(".gltf") || name.endsWith(".ifc") || name.endsWith(".rvt");
    });

    if (droppedFiles.length === 0) {
      toast.error("Solo se aceptan archivos GLB, IFC o RVT");
      return;
    }

    // Open the add file dialog so user can assign specialties
    setShowAddFileDialog(true);

    // If only one file, auto-trigger upload for first available specialty
    if (droppedFiles.length === 1) {
      toast.info(`Archivo "${droppedFiles[0].name}" detectado. Selecciona la especialidad para asignarlo.`, { duration: 5000 });
      // Store the dropped file temporarily for the dialog to use
      (window as any).__droppedFile = droppedFiles[0];
    } else {
      toast.info(`${droppedFiles.length} archivos detectados. Selecciona las especialidades para asignarlos.`, { duration: 5000 });
      (window as any).__droppedFiles = droppedFiles;
    }
  }, []);
  const [customSpecialtyNames, setCustomSpecialtyNames] = useState<Record<string, string>>({});

  const SPECIALTY_OPTIONS = [
    { value: "hvac", label: "Aire Acondicionado y Climatización", color: "#2196F3", custom: false },
    { value: "architecture", label: "Arquitectura", color: "#B0BEC5", custom: false },
    { value: "electrical", label: "Eléctrico", color: "#FF9800", custom: false },
    { value: "structure", label: "Estructuras", color: "#78909C", custom: false },
    { value: "gas", label: "Gas", color: "#FFC107", custom: false },
    { value: "plumbing", label: "Hidráulico", color: "#4CAF50", custom: false },
    { value: "stormwater", label: "Pluvial", color: "#00BCD4", custom: false },
    { value: "fire_protection", label: "Protección contra Incendios", color: "#F44336", custom: false },
    { value: "sanitary", label: "Sanitario", color: "#8BC34A", custom: false },
    { value: "custom_1", label: "Personalizada 1", color: "#9C27B0", custom: true },
    { value: "custom_2", label: "Personalizada 2", color: "#E91E63", custom: true },
    { value: "custom_3", label: "Personalizada 3", color: "#607D8B", custom: true },
  ];

  const getUploadUrlMutation = trpc.project.getUploadUrl.useMutation();
  const processUploadedFileMutation = trpc.project.processUploadedFile.useMutation();

  const handleAddFile = useCallback(async (file: File, specialty: string) => {
    if (!file || !specialty) return;
    const MAX_SIZE = 300 * 1024 * 1024; // 300MB
    if (file.size > MAX_SIZE) {
      toast.error(`El archivo ${file.name} excede 300MB. Reduce el tamaño antes de subirlo.`);
      return;
    }

    const fileName = file.name.toLowerCase();
    const isIFC = fileName.endsWith(".ifc");
    const isRVT = fileName.endsWith(".rvt");
    const isGLB = fileName.endsWith(".glb") || fileName.endsWith(".gltf");
    const fileType: "glb" | "ifc" | "rvt" = isIFC ? "ifc" : isRVT ? "rvt" : "glb";

    setAddFileUploading(prev => ({ ...prev, [specialty]: 0 }));

    if (isIFC) {
      toast.info(`Subiendo IFC para conversión → GLB...`, { duration: 8000 });
    } else if (isRVT) {
      toast.info(`Subiendo RVT → conversión automática a GLB (puede tardar varios minutos)...`, { duration: 15000 });
    }

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Step 1: Get presigned upload URL from backend
        const { uploadUrl, fileKey, authToken } = await getUploadUrlMutation.mutateAsync({
          projectId,
          specialty,
          fileType,
          fileName: file.name,
        });

        // Step 2: Upload directly to S3 storage (bypasses Manus proxy size limits)
        const fileUrl = await new Promise<string>((resolve, reject) => {
          const formData = new FormData();
          formData.append("file", file, file.name);

          const xhr = new XMLHttpRequest();
          xhr.open("POST", uploadUrl, true);
          xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * (isIFC ? 50 : isRVT ? 90 : 80));
              setAddFileUploading(prev => ({ ...prev, [specialty]: pct }));
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const resp = JSON.parse(xhr.responseText);
                resolve(resp.url || "");
              } catch {
                reject(new Error("Invalid response from storage"));
              }
            } else {
              reject(new Error(`Storage upload failed (${xhr.status})`));
            }
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.ontimeout = () => reject(new Error("Upload timeout"));
          xhr.timeout = 600000; // 10 min
          xhr.send(formData);
        });

        // Step 3: Process the uploaded file on the backend (optimize GLB, convert IFC, or convert RVT→IFC→GLB)
        if (isIFC || isGLB || isRVT) {
          setAddFileUploading(prev => ({ ...prev, [specialty]: isIFC ? 55 : isRVT ? 30 : 85 }));
          if (isIFC) toast.info("Convirtiendo IFC → GLB en servidor...", { duration: 10000 });
          if (isRVT) toast.info("Convirtiendo RVT → IFC → GLB via Autodesk Cloud (esto puede tardar 5-15 min)...", { duration: 30000 });
        }

        const result = await processUploadedFileMutation.mutateAsync({
          projectId,
          specialty,
          fileKey,
          fileType,
          fileSize: file.size,
          fileUrl,
        });

        setAddFileUploading(prev => ({ ...prev, [specialty]: 100 }));

        // Get specialty label and color
        const specOpt = SPECIALTY_OPTIONS.find(s => s.value === specialty);
        const specLabel = specOpt?.custom ? (customSpecialtyNames[specialty]?.trim() || specialty) : (specOpt?.label || specialty);
        const specColor = specOpt?.color || "#9CA3AF";
        const isArchOrStruct = ["architecture", "structure"].includes(specialty);

        // RVT conversion now returns a GLB (converted via APS pipeline)
        // No more "rvtStored" response — RVT files are fully converted server-side

        // Register GLB/IFC file in DB
        try {
          await addFileMutation.mutateAsync({
            projectId,
            specialty,
            label: specLabel,
            url: (result as any).url,
            fileKey: (result as any).fileKey,
            color: specColor,
            transparent: isArchOrStruct,
            opacity: isArchOrStruct ? 30 : 100,
            showEdges: true,
            fileSize: (result as any).fileSize || file.size,
            lodUrl: (result as any).lodUrl ?? undefined,
            conversionStatus: "ready",
            originalFormat: isRVT ? "rvt" : isIFC ? "ifc" : "glb",
          });
        } catch (e) {
          console.warn("Error registering file in DB:", e);
        }

        setAddFileSuccess(prev => [...prev, specialty]);
        setAddFileUploading(prev => { const n = { ...prev }; delete n[specialty]; return n; });
        toast.success(`${file.name} subido correctamente`);
        projectQuery.refetch();
        return; // Success, exit retry loop
      } catch (err) {
        console.error(`Upload attempt ${attempt} error:`, err);
        if (attempt < MAX_RETRIES) {
          toast.info(`Reintentando ${file.name} (${attempt + 1}/${MAX_RETRIES})...`, { duration: 3000 });
          await new Promise(r => setTimeout(r, attempt * 2000));
        } else {
          setAddFileUploading(prev => { const n = { ...prev }; delete n[specialty]; return n; });
          toast.error(`Error subiendo ${file.name}: ${err instanceof Error ? err.message : "Error desconocido"}`);
        }
      }
    }
  }, [projectId, projectQuery, getUploadUrlMutation, processUploadedFileMutation, addFileMutation, customSpecialtyNames]);

  /* ═══════════════════════════════════════════════════
     Thumbnail Capture
     ═══════════════════════════════════════════════════ */
  const captureThumbnail = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return null;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/jpeg", 0.7);
  }, []);

  // Auto-capture thumbnail 3 seconds after first model loads
  const thumbnailCaptured = useRef(false);
  useEffect(() => {
    if (thumbnailCaptured.current) return;
    const hasLoaded = Object.values(layers).some(l => l.loaded);
    if (!hasLoaded) return;
    const timer = setTimeout(() => {
      const dataUrl = captureThumbnail();
      if (dataUrl && project?.id) {
        localStorage.setItem(`project-thumb-${project.id}`, dataUrl);
        thumbnailCaptured.current = true;
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [layers, captureThumbnail, project?.id]);

  /* ═══════════════════════════════════════════════════
     MEP Collision Detection
     ═══════════════════════════════════════════════════ */
  interface CollisionResult {
    id: string;
    specialtyA: string;
    specialtyB: string;
    position: THREE.Vector3;
    severity: "high" | "medium" | "low";
    description: string;
  }
  const [collisions, setCollisions] = useState<CollisionResult[]>([]);
  const [collisionRunning, setCollisionRunning] = useState(false);
  const collisionMarkersRef = useRef<THREE.Mesh[]>([]);

  const runCollisionDetection = useCallback(() => {
    setCollisionRunning(true);
    const results: CollisionResult[] = [];

    // Gather all loaded specialty groups
    const specialtyGroups: { name: string; meshes: THREE.Mesh[]; box: THREE.Box3 }[] = [];
    Object.entries(layersRef.current).forEach(([name, layer]) => {
      if (!layer.group || !layer.loaded || ARCH_SPECIALTIES.includes(name)) return;
      const meshes: THREE.Mesh[] = [];
      layer.group.traverse(c => { if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh); });
      if (meshes.length === 0) return;
      const box = new THREE.Box3();
      meshes.forEach(m => { m.geometry.computeBoundingBox(); box.expandByObject(m); });
      specialtyGroups.push({ name, meshes, box });
    });

    // Pairwise bounding box intersection (first pass)
    for (let i = 0; i < specialtyGroups.length; i++) {
      for (let j = i + 1; j < specialtyGroups.length; j++) {
        const a = specialtyGroups[i];
        const b = specialtyGroups[j];
        if (!a.box.intersectsBox(b.box)) continue;

        // Second pass: mesh-level bounding box check
        let collisionCount = 0;
        const collisionPositions: THREE.Vector3[] = [];

        for (const meshA of a.meshes) {
          if (collisionCount >= 10) break; // Cap per pair
          const boxA = new THREE.Box3().setFromObject(meshA);
          for (const meshB of b.meshes) {
            if (collisionCount >= 10) break;
            const boxB = new THREE.Box3().setFromObject(meshB);
            if (boxA.intersectsBox(boxB)) {
              collisionCount++;
              const center = new THREE.Vector3();
              const intersection = boxA.clone().intersect(boxB);
              intersection.getCenter(center);
              collisionPositions.push(center);
            }
          }
        }

        if (collisionCount > 0) {
          // Aggregate: report centroid of all collision points
          const centroid = new THREE.Vector3();
          collisionPositions.forEach(p => centroid.add(p));
          centroid.divideScalar(collisionPositions.length);

          const severity = collisionCount >= 5 ? "high" : collisionCount >= 2 ? "medium" : "low";
          results.push({
            id: `${a.name}-${b.name}-${results.length}`,
            specialtyA: a.name,
            specialtyB: b.name,
            position: centroid,
            severity,
            description: `${collisionCount} interferencia${collisionCount > 1 ? "s" : ""} entre ${a.name} y ${b.name}`,
          });
        }
      }
    }

    // Clear old markers
    const scene = sceneRef.current;
    if (scene) {
      collisionMarkersRef.current.forEach(m => { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
      collisionMarkersRef.current = [];

      // Add visual markers at collision points
      results.forEach(r => {
        const markerGeo = new THREE.SphereGeometry(0.25, 12, 12);
        const color = r.severity === "high" ? 0xff2222 : r.severity === "medium" ? 0xff8800 : 0xffcc00;
        const markerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false });
        const marker = new THREE.Mesh(markerGeo, markerMat);
        marker.position.copy(r.position);
        marker.renderOrder = 999;
        marker.name = "__collision_marker";
        scene.add(marker);
        collisionMarkersRef.current.push(marker);
      });
    }

    setCollisions(results);
    setCollisionRunning(false);
  }, []);

  const clearCollisions = useCallback(() => {
    const scene = sceneRef.current;
    if (scene) {
      collisionMarkersRef.current.forEach(m => { scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); });
      collisionMarkersRef.current = [];
    }
    setCollisions([]);
  }, []);

  const flyToCollision = useCallback((position: THREE.Vector3) => {
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!cam || !controls || walkModeRef.current) return;
    const target = position.clone();
    controls.target.copy(target);
    cam.position.set(target.x + 3, target.y + 2, target.z + 3);
    controls.update();
  }, []);

  /* ═══════════════════════════════════════════════════
     Render Tab Content
     ═══════════════════════════════════════════════════ */

  const renderTabContent = () => {
    switch (activeTab) {
      case "layers":
        return (
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto px-3 lg:px-4 py-3">
              <h2 className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: BRAND.textMuted }}>Especialidades</h2>
              <div className="space-y-0.5">
                {files.map((f) => {
                  const layer = layers[f.specialty];
                  if (!layer) return null;
                  const vs = visualSettings[f.specialty];
                  const currentOpacity = vs ? vs.opacity : f.opacity;
                  return (
                    <div key={f.specialty} className="rounded-lg transition-colors" style={{ backgroundColor: layer.visible && layer.loaded ? `${BRAND.bg}` : "transparent" }}>
                      <button
                        className={`w-full flex items-center gap-2.5 py-3 lg:py-2.5 px-3 text-left ${
                          layer.visible && layer.loaded
                            ? "hover:bg-gray-100"
                            : "hover:bg-gray-50 opacity-60"
                        }`}
                        onClick={() => layer.loaded && toggleLayer(f.specialty)}
                        disabled={!layer.loaded}
                      >
                        <div className="relative flex-shrink-0">
                          <div
                            className="w-7 h-7 lg:w-5 lg:h-5 rounded-md border-2 transition-all cursor-pointer hover:scale-110 hover:shadow-md active:scale-95 relative"
                            style={{
                              backgroundColor: layer.visible && layer.loaded ? (customColors[f.specialty] || f.color) : "transparent",
                              borderColor: customColors[f.specialty] || f.color,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (layer.loaded) setShowColorPicker(showColorPicker === f.specialty ? null : f.specialty);
                            }}
                            title="Cambiar color de esta especialidad"
                          >
                            {layer.loaded && (
                              <Pipette className="w-2.5 h-2.5 lg:w-2 lg:h-2 absolute bottom-0 right-0 text-white drop-shadow-sm" />
                            )}
                          </div>
                          {showColorPicker === f.specialty && (
                            <div
                              className="absolute top-9 left-0 z-50 rounded-xl shadow-2xl p-3 min-w-[200px]"
                              style={{ backgroundColor: BRAND.cardBg, border: `1px solid ${BRAND.border}`, boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <p className="text-[10px] font-semibold mb-2" style={{ color: BRAND.textSecondary }}>Color de especialidad</p>
                              <div className="grid grid-cols-6 gap-2 lg:gap-1.5 mb-2">
                                {["#FF6B6B", "#FF8E53", "#FFC107", "#4CAF50", "#00BCD4", "#2196F3",
                                  "#9C27B0", "#E91E63", "#795548", "#607D8B", "#00A89D", "#1B2A4A",
                                  "#F44336", "#FF9800", "#CDDC39", "#009688", "#3F51B5", "#673AB7"].map(c => (
                                  <button
                                    key={c}
                                    className="w-8 h-8 lg:w-6 lg:h-6 rounded-full border-2 transition-transform hover:scale-110 active:scale-95"
                                    style={{
                                      backgroundColor: c,
                                      borderColor: (customColors[f.specialty] || f.color) === c ? "#fff" : "transparent",
                                      boxShadow: (customColors[f.specialty] || f.color) === c ? `0 0 0 2px ${c}` : "none",
                                    }}
                                    onClick={() => {
                                      applyCustomColor(f.specialty, c);
                                      setShowColorPicker(null);
                                    }}
                                  />
                                ))}
                              </div>
                              <div className="flex items-center gap-2">
                                <input
                                  type="color"
                                  value={customColors[f.specialty] || f.color}
                                  onChange={(e) => applyCustomColor(f.specialty, e.target.value)}
                                  className="w-7 h-7 rounded cursor-pointer border-0 p-0"
                                  title="Color personalizado"
                                />
                                <span className="text-[9px] font-mono" style={{ color: BRAND.textMuted }}>{(customColors[f.specialty] || f.color).toUpperCase()}</span>
                                {customColors[f.specialty] && (
                                  <button
                                    className="text-[9px] ml-auto px-1.5 py-0.5 rounded"
                                    style={{ backgroundColor: BRAND.bg, color: BRAND.textMuted }}
                                    onClick={() => {
                                      applyCustomColor(f.specialty, f.color);
                                      setCustomColors(prev => { const n = { ...prev }; delete n[f.specialty]; return n; });
                                      setShowColorPicker(null);
                                    }}
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm lg:text-xs font-medium truncate" style={{ color: BRAND.textPrimary }}>{f.label}</span>
                            {/* Pending conversion badge for RVT files */}
                            {(f as any).conversionStatus === "pending_conversion" && (
                              <span
                                className="flex-shrink-0 text-[8px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wider"
                                style={{ backgroundColor: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b40" }}
                                title="Archivo RVT almacenado. Exporta como GLB o IFC desde Revit y reemplázalo."
                              >
                                RVT pendiente
                              </span>
                            )}
                            {/* Inspection status icon */}
                            {(() => {
                              const status = (f as any).inspectionStatus || "pending";
                              const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; title: string }> = {
                                pending: { icon: CircleDot, color: BRAND.textMuted, title: "Pendiente de inspección" },
                                in_progress: { icon: Clock, color: "#f59e0b", title: "Inspección en proceso" },
                                accepted: { icon: CheckCircle2, color: "#22C55E", title: "Inspección aceptada" },
                                rejected: { icon: XCircle, color: "#EF4444", title: "Inspección rechazada" },
                              };
                              const cfg = statusConfig[status] || statusConfig.pending;
                              const Icon = cfg.icon;
                              return (
                                <button
                                  className="flex-shrink-0 hover:scale-125 transition-transform"
                                  title={`${cfg.title} — Clic para cambiar estado`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    // Cycle: pending → in_progress → accepted → rejected → pending
                                    const cycle: string[] = ["pending", "in_progress", "accepted", "rejected"];
                                    const nextIdx = (cycle.indexOf(status) + 1) % cycle.length;
                                    updateFileStatusMutation.mutate({ fileId: (f as any).id, inspectionStatus: cycle[nextIdx] as any });
                                  }}
                                >
                                  <Icon className="w-3.5 h-3.5" style={{ color: cfg.color }} />
                                </button>
                              );
                            })()}
                          </div>
                          {layer.loading && (
                            <>
                              <div className="w-full h-1 bg-gray-200 rounded-full mt-1 overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all duration-300"
                                  style={{ width: `${layer.progress}%`, backgroundColor: f.color }}
                                />
                              </div>
                              <span className="text-[9px] mt-0.5 block" style={{ color: BRAND.textMuted }}>
                                {(layer as any).fromCache ? "⚡ Caché local" : `${layer.progress}% descargando...`}
                              </span>
                            </>
                          )}
                          {layer.loaded && (layer as any).fromCache && !(layer as any).lodLoaded && (
                            <span className="text-[9px] block" style={{ color: BRAND.teal }}>⚡ Caché</span>
                          )}
                          {layer.loaded && (layer as any).lodLoaded && (
                            <>
                              <span className="text-[9px] block" style={{ color: "#f59e0b" }}>⚡ Vista rápida (LOD)</span>
                              {(layer as any).fullResLoading && (
                                <div className="w-full h-0.5 bg-gray-200 rounded-full mt-0.5 overflow-hidden">
                                  <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{ width: `${Math.max(0, (layer.progress - 50) * 2)}%`, backgroundColor: BRAND.teal }}
                                  />
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {layer.loaded ? (
                          layer.visible ? (
                            <Eye className="w-4 h-4 lg:w-3.5 lg:h-3.5 flex-shrink-0" style={{ color: BRAND.teal }} />
                          ) : (
                            <EyeOff className="w-4 h-4 lg:w-3.5 lg:h-3.5 text-gray-300 flex-shrink-0" />
                          )
                        ) : layer.loading ? (
                          <Loader2 className="w-4 h-4 lg:w-3.5 lg:h-3.5 animate-spin flex-shrink-0" style={{ color: BRAND.teal }} />
                        ) : (layer as any).loadError ? (
                          <AlertTriangle className="w-4 h-4 lg:w-3.5 lg:h-3.5 text-red-500 flex-shrink-0" />
                        ) : (f as any).conversionStatus === "pending_conversion" ? (
                          <Upload className="w-4 h-4 lg:w-3.5 lg:h-3.5 flex-shrink-0" style={{ color: "#f59e0b" }} />
                        ) : null}
                      </button>
                      {/* Retry button for failed loads */}
                      {!layer.loaded && !layer.loading && (layer as any).loadError && (
                        <div className="px-3 pb-2">
                          <button
                            className="w-full text-xs py-1.5 px-3 rounded-md text-white font-medium"
                            style={{ backgroundColor: BRAND.teal }}
                            onClick={(e) => {
                              e.stopPropagation();
                              // Clear error and retry
                              setLayers(prev => ({
                                ...prev,
                                [f.specialty]: { ...prev[f.specialty], loadError: undefined } as any,
                              }));
                              loadFile(f);
                            }}
                          >
                            Reintentar carga
                          </button>
                          <span className="text-[8px] block mt-1 text-red-400 truncate">{(layer as any).loadError}</span>
                        </div>
                      )}
                      {/* Opacity slider - always visible when layer is loaded */}
                      {layer.loaded && layer.visible && (
                        <div className="px-3 pb-2 flex items-center gap-2">
                          <span className="text-[9px] font-medium w-6 text-right" style={{ color: BRAND.textMuted }}>{Math.round(currentOpacity)}%</span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={currentOpacity}
                            onChange={(e) => updateVisualSetting(f.specialty, "opacity", parseInt(e.target.value))}
                            className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${customColors[f.specialty] || f.color} ${currentOpacity}%, ${BRAND.border} ${currentOpacity}%)`,
                              accentColor: customColors[f.specialty] || f.color,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <button title="Cambiar color de esta capa" onClick={(e) => { e.stopPropagation(); setShowColorPicker(showColorPicker === f.specialty ? null : f.specialty); }} className="cursor-pointer hover:opacity-70 flex-shrink-0 px-1.5 py-0.5 rounded text-[8px] flex items-center gap-0.5" style={{ backgroundColor: `${customColors[f.specialty] || f.color}20`, color: customColors[f.specialty] || f.color }}><Pipette className="w-3 h-3" />Color</button>
                        </div>
                      )}
                      {/* Replace button for pending_conversion (RVT) files */}
                      {(f as any).conversionStatus === "pending_conversion" && (
                        <div className="px-3 pb-2 space-y-1.5">
                          <div className="rounded-md p-2" style={{ backgroundColor: "#f59e0b10", border: "1px solid #f59e0b30" }}>
                            <p className="text-[9px] font-medium" style={{ color: "#f59e0b" }}>Archivo RVT almacenado</p>
                            <p className="text-[8px] mt-0.5" style={{ color: BRAND.textMuted }}>Exporta como .glb o .ifc desde Revit y súbelo aquí para visualizar en 3D.</p>
                          </div>
                          <label
                            className="w-full text-[10px] py-1.5 px-2 rounded-md font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80 cursor-pointer"
                            style={{ backgroundColor: `${BRAND.teal}15`, color: BRAND.teal, border: `1px solid ${BRAND.teal}30` }}
                          >
                            <FileUp className="w-3 h-3" /> Reemplazar con GLB/IFC
                            <input
                              type="file"
                              accept=".glb,.gltf,.ifc"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleAddFile(file, f.specialty);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                      )}
                      {/* Delete layer button */}
                      <div className="px-3 pb-1.5">
                        <button
                          className="w-full text-[10px] py-1.5 px-2 rounded-md font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80 disabled:opacity-50"
                          style={{ backgroundColor: "#ef444415", color: "#ef4444", border: "1px solid #ef444430" }}
                          disabled={deletingFileId === (f as any).id || deleteFileMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`¿Eliminar la capa "${f.label}"? Esta acción no se puede deshacer.`)) {
                              setDeletingFileId((f as any).id);
                              // Remove from scene
                              if (layer.group) {
                                sceneRef.current?.remove(layer.group);
                                layer.group.traverse((child: any) => {
                                  if (child.geometry) child.geometry.dispose();
                                  if (child.material) {
                                    if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose());
                                    else child.material.dispose();
                                  }
                                });
                              }
                              // Remove from layers state
                              setLayers(prev => {
                                const next = { ...prev };
                                delete next[f.url];
                                return next;
                              });
                              deleteFileMutation.mutate({ fileId: (f as any).id }, {
                                onSettled: () => setDeletingFileId(null),
                              });
                            }
                          }}
                        >
                          {deletingFileId === (f as any).id ? (
                            <><Loader2 className="w-3 h-3 animate-spin" /> Eliminando...</>
                          ) : (
                            <><Trash2 className="w-3 h-3" /> Eliminar Capa</>
                          )}
                        </button>
                      </div>
                      {/* Re-process button for MEP files */}
                      {layer.loaded && ["electrical", "mechanical", "plumbing", "hvac", "fire", "fire_protection"].includes(f.specialty) && (
                        <div className="px-3 pb-2">
                          <button
                            className="w-full text-[10px] py-1.5 px-2 rounded-md font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80 disabled:opacity-50"
                            style={{ backgroundColor: `${BRAND.teal}15`, color: BRAND.teal, border: `1px solid ${BRAND.teal}30` }}
                            disabled={reprocessingFileId === (f as any).id || reprocessMutation.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              setReprocessingFileId((f as any).id);
                              reprocessMutation.mutate({ fileId: (f as any).id }, {
                                onSettled: () => setReprocessingFileId(null),
                              });
                            }}
                          >
                            {reprocessingFileId === (f as any).id ? (
                              <><Loader2 className="w-3 h-3 animate-spin" /> Re-procesando...</>
                            ) : (
                              <><RefreshCw className="w-3 h-3" /> Re-procesar (sin Draco)</>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="px-3 lg:px-4 py-3 space-y-1.5 shrink-0" style={{ borderTop: `1px solid ${BRAND.border}` }}>
              <button
                onClick={fitAll}
                className="w-full px-3 py-2.5 lg:py-2 text-xs rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80"
                style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
                title="Centrar vista en todo el modelo"
              >
                <Maximize className="w-3.5 h-3.5" />
                Centrar Vista
              </button>
              <div className="flex gap-1.5">
                <button
                  onClick={() => toggleAllLayers(true)}
                  className="flex-1 px-3 py-2.5 lg:py-2 text-xs rounded-lg font-medium flex items-center justify-center gap-1 transition-colors hover:opacity-80"
                  style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
                  title="Mostrar todas las capas"
                >
                  <Eye className="w-3 h-3" />
                  Mostrar Todo
                </button>
                <button
                  onClick={() => toggleAllLayers(false)}
                  className="flex-1 px-3 py-2.5 lg:py-2 text-xs rounded-lg font-medium flex items-center justify-center gap-1 transition-colors hover:opacity-80"
                  style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
                  title="Ocultar todas las capas"
                >
                  <EyeOff className="w-3 h-3" />
                  Ocultar Todo
                </button>
              </div>
              <button
                onClick={toggleFurniture}
                className="w-full px-3 py-2.5 lg:py-2 text-xs rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80"
                style={{
                  backgroundColor: hideFurniture ? BRAND.teal : BRAND.bg,
                  color: hideFurniture ? "#fff" : BRAND.textSecondary,
                  border: `1px solid ${hideFurniture ? BRAND.teal : BRAND.border}`,
                }}
              >
                <Scissors className="w-3.5 h-3.5" />
                {hideFurniture ? "Mostrar Mobiliario" : "Ocultar Mobiliario"}
              </button>
              {/* Wall independent control */}
              <div className="mt-2 rounded-lg p-2.5" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <BrickWall className="w-3.5 h-3.5" style={{ color: BRAND.navy }} />
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Muros</span>
                  </div>
                  <button
                    onClick={() => toggleWalls(!wallsVisible)}
                    className="px-2 py-1 text-[10px] font-semibold rounded-md transition-colors"
                    style={{
                      backgroundColor: wallsVisible ? BRAND.teal : `${BRAND.textMuted}30`,
                      color: wallsVisible ? "#fff" : BRAND.textMuted,
                    }}
                  >
                    {wallsVisible ? "Visible" : "Oculto"}
                  </button>
                </div>
                {wallsVisible && (
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-medium w-6 text-right" style={{ color: BRAND.textMuted }}>{wallOpacity}%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={wallOpacity}
                      onChange={(e) => applyWallOpacity(parseInt(e.target.value))}
                      className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, ${BRAND.navy} ${wallOpacity}%, ${BRAND.border} ${wallOpacity}%)`,
                        accentColor: BRAND.navy,
                      }}
                    />
                    <span title={`Transparencia: ${wallOpacity}%`}><Ghost className="w-3 h-3" style={{ color: wallOpacity < 50 ? BRAND.teal : BRAND.textMuted }} /></span>
                  </div>
                )}
              </div>
              {/* Export visible layers as GLB */}
              <button
                onClick={async () => {
                  const visibleFiles = files.filter((f: any) => layers[f.specialty]?.visible && layers[f.specialty]?.loaded);
                  if (visibleFiles.length === 0) {
                    toast.error("No hay capas visibles para exportar");
                    return;
                  }
                  toast.info(`Descargando ${visibleFiles.length} capa(s) visibles...`);
                  for (const f of visibleFiles) {
                    try {
                      const resp = await fetch((f as any).url);
                      if (!resp.ok) throw new Error("Error descargando");
                      const blob = await resp.blob();
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = `${(f as any).label || f.specialty}.glb`;
                      a.click();
                      URL.revokeObjectURL(a.href);
                    } catch {
                      toast.error(`Error descargando ${(f as any).label || f.specialty}`);
                    }
                  }
                  toast.success(`${visibleFiles.length} archivo(s) descargado(s)`);
                }}
                className="w-full px-3 py-2.5 lg:py-2 text-xs rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80"
                style={{ backgroundColor: BRAND.navyLight, color: "#fff" }}
              >
                <Download className="w-3.5 h-3.5" />
                Exportar Capas Visibles
              </button>
            </div>
          </div>
        );

      case "coords":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: BRAND.textMuted }}>Coordenadas en Obra</h2>
              <p className="text-[10px]" style={{ color: BRAND.textMuted }}>Punto de referencia en sitio (metros)</p>
            </div>
            {(["x", "y", "z"] as const).map((axis) => (
              <div key={axis} className="flex items-center gap-3">
                <label className="text-sm font-bold w-6 uppercase text-center" style={{ color: BRAND.textSecondary }}>{axis}</label>
                <input
                  type="number"
                  step="0.01"
                  value={coords[axis]}
                  onChange={(e) => {
                    setCoords((prev) => ({ ...prev, [axis]: parseFloat(e.target.value) || 0 }));
                    setCoordsApplied(false);
                  }}
                  className="flex-1 px-3 py-2.5 text-sm rounded-lg font-mono focus:outline-none focus:ring-2"
                  style={{
                    backgroundColor: BRAND.bg,
                    border: `1px solid ${BRAND.border}`,
                    color: BRAND.textPrimary,
                    "--tw-ring-color": BRAND.teal,
                  } as any}
                  inputMode="decimal"
                />
                <span className="text-[10px]" style={{ color: BRAND.textMuted }}>m</span>
              </div>
            ))}
            <div className="flex gap-2">
              <button
                onClick={applyCoords}
                className="flex-1 px-3 py-2.5 text-sm rounded-lg font-medium transition-colors"
                style={{
                  backgroundColor: coordsApplied ? "#ECFDF5" : BRAND.teal,
                  color: coordsApplied ? "#047857" : "#fff",
                  border: coordsApplied ? "1px solid #A7F3D0" : "none",
                }}
              >
                {coordsApplied ? "✓" : "Aplicar"}
              </button>
              <button
                onClick={resetCoords}
                className="px-3 py-2.5 text-sm rounded-lg font-medium transition-colors hover:opacity-80"
                style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
              >
                <RotateCcw className="w-4 h-4 inline" />
              </button>
            </div>
            {/* UTM Calibration Info */}
            {utmCalibration && (
              <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: `${BRAND.teal}10`, border: `1px solid ${BRAND.teal}30` }}>
                <h3 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.teal }}>Calibración UTM Activa</h3>
                <div className="grid grid-cols-2 gap-1 text-[10px] font-mono" style={{ color: BRAND.textSecondary }}>
                  <span>Este:</span><span>{utmCalibration.utmRef.easting.toFixed(2)}</span>
                  <span>Norte:</span><span>{utmCalibration.utmRef.northing.toFixed(2)}</span>
                  <span>Zona:</span><span>{utmCalibration.utmRef.zone}{utmCalibration.utmRef.hemisphere}</span>
                  <span>Elev:</span><span>{utmCalibration.utmRef.elevation.toFixed(1)} m</span>
                </div>
                <button
                  onClick={() => navigate(`/project/${projectId}/utm`)}
                  className="w-full text-[10px] py-1.5 rounded font-medium transition-colors hover:opacity-80"
                  style={{ backgroundColor: BRAND.teal, color: "#fff" }}
                >
                  Editar Calibración UTM
                </button>
              </div>
            )}
            {!utmCalibration && (
              <button
                onClick={() => navigate(`/project/${projectId}/utm`)}
                className="w-full text-xs py-2.5 rounded-lg font-medium transition-colors hover:opacity-80"
                style={{ backgroundColor: BRAND.bg, color: BRAND.teal, border: `1px dashed ${BRAND.teal}` }}
              >
                Configurar UTM / GPS
              </button>
            )}
          </div>
        );

      case "clip":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            <h2 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Plano de Corte</h2>
            {floorIsolation && isolatedFloorIdx !== null && (
              <div className="rounded-lg p-2.5" style={{ backgroundColor: "#F59E0B15", border: "1px solid #F59E0B40" }}>
                <p className="text-[10px] leading-relaxed" style={{ color: "#92400E" }}>
                  <strong>Aislamiento de nivel activo:</strong> {FLOOR_LEVELS[isolatedFloorIdx].label}. El corte manual está desactivado mientras se aísla un nivel.
                </p>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: BRAND.textSecondary }}>Activar corte</span>
              <button
                onClick={() => setClippingEnabled(!clippingEnabled)}
                className="w-11 h-6 rounded-full transition-colors relative"
                style={{ backgroundColor: clippingEnabled ? BRAND.teal : "#D1D5DB" }}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${clippingEnabled ? "left-5.5" : "left-0.5"}`} />
              </button>
            </div>
            {clippingEnabled && (
              <>
                <div>
                  <label className="text-xs mb-1.5 block" style={{ color: BRAND.textSecondary }}>Eje</label>
                  <div className="flex gap-1">
                    {(["x", "y", "z"] as const).map((axis) => (
                      <button
                        key={axis}
                        onClick={() => setClippingAxis(axis)}
                        className="flex-1 py-2.5 lg:py-2 text-xs rounded-lg font-medium transition-colors"
                        style={{
                          backgroundColor: clippingAxis === axis ? BRAND.teal : BRAND.bg,
                          color: clippingAxis === axis ? "#fff" : BRAND.textSecondary,
                        }}
                      >
                        {axis.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1" style={{ color: BRAND.textSecondary }}>
                    <span>Posición</span>
                    <span className="font-mono font-medium">{clippingHeight.toFixed(1)} m</span>
                  </div>
                  <input
                    type="range"
                    min={modelBounds.min}
                    max={modelBounds.max}
                    step={0.5}
                    value={clippingHeight}
                    onChange={(e) => setClippingHeight(parseFloat(e.target.value))}
                    className="w-full"
                    style={{ accentColor: BRAND.teal }}
                  />
                  <div className="flex justify-between text-[10px] mt-0.5" style={{ color: BRAND.textMuted }}>
                    <span>{modelBounds.min} m</span>
                    <span>{modelBounds.max} m</span>
                  </div>
                </div>
                {/* Drag instructions */}
                <div className="rounded-lg p-2.5" style={{ backgroundColor: `${BRAND.teal}10`, border: `1px solid ${BRAND.teal}25` }}>
                  <div className="flex items-center gap-2">
                    <ArrowUpDown className="w-3.5 h-3.5 flex-shrink-0" style={{ color: BRAND.teal }} />
                    <p className="text-[10px] leading-relaxed" style={{ color: BRAND.textSecondary }}>
                      <strong>Arrastre directo:</strong> {isMobile ? "Mantén presionado con dos dedos y arrastra verticalmente" : "Shift + clic izquierdo o clic medio y arrastra verticalmente"} en el viewport para mover el plano.
                    </p>
                  </div>
                  {clipDragging && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: BRAND.teal }} />
                      <span className="text-[10px] font-medium" style={{ color: BRAND.teal }}>Arrastrando...</span>
                    </div>
                  )}
                </div>

                {/* Element Type Filter */}
                <div className="pt-2 border-t" style={{ borderColor: `${BRAND.navy}10` }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Filtrar por Tipo</span>
                    <button
                      onClick={() => {
                        const allOn = Object.values(elementTypeFilter).every(v => v);
                        const newFilter = Object.fromEntries(ELEMENT_TYPES.map(t => [t.key, !allOn]));
                        setElementTypeFilter(newFilter);
                      }}
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                      style={{ color: BRAND.teal }}
                    >
                      {Object.values(elementTypeFilter).every(v => v) ? "Ninguno" : "Todos"}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {ELEMENT_TYPES.map((type) => (
                      <button
                        key={type.key}
                        onClick={() => setElementTypeFilter(prev => ({ ...prev, [type.key]: !prev[type.key] }))}
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] transition-all"
                        style={{
                          backgroundColor: elementTypeFilter[type.key] ? `${BRAND.teal}15` : BRAND.bg,
                          color: elementTypeFilter[type.key] ? BRAND.navy : BRAND.textMuted,
                          border: `1px solid ${elementTypeFilter[type.key] ? BRAND.teal + '40' : 'transparent'}`,
                        }}
                      >
                        <span className="text-sm">{type.icon}</span>
                        <span className="truncate">{type.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );

      case "info":
        return (
          <div className="px-3 lg:px-4 py-4">
            <h2 className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: BRAND.textMuted }}>Elemento Seleccionado</h2>
            {selectedInfo ? (
              <div className="space-y-3">
                <div className="rounded-lg p-3" style={{ backgroundColor: `${BRAND.teal}15`, border: `1px solid ${BRAND.teal}30` }}>
                  <p className="text-sm font-medium" style={{ color: BRAND.navy }}>{selectedInfo.name}</p>
                  <p className="text-[11px] mt-0.5" style={{ color: BRAND.teal }}>{selectedInfo.specialty}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: BRAND.textMuted }}>Centro</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(["x", "y", "z"] as const).map((axis) => (
                      <div key={axis} className="rounded-lg px-2 py-2 text-center" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                        <span className="text-[10px] uppercase block" style={{ color: BRAND.textMuted }}>{axis}</span>
                        <p className="text-xs font-mono font-medium" style={{ color: BRAND.textPrimary }}>{selectedInfo.position[axis]}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: BRAND.textMuted }}>Dimensiones</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(["x", "y", "z"] as const).map((axis) => (
                      <div key={axis} className="rounded-lg px-2 py-2 text-center" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                        <span className="text-[10px] uppercase block" style={{ color: BRAND.textMuted }}>{axis === "x" ? "ancho" : axis === "y" ? "alto" : "prof"}</span>
                        <p className="text-xs font-mono font-medium" style={{ color: BRAND.textPrimary }}>{selectedInfo.size[axis]} m</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <MousePointer className="w-8 h-8 mx-auto mb-3" style={{ color: BRAND.border }} />
                <p className="text-xs" style={{ color: BRAND.textMuted }}>
                  {isMobile ? "Toca un elemento" : "Clic en un elemento"}
                </p>
              </div>
            )}
          </div>
        );

      case "measure":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            <h2 className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: BRAND.textMuted }}>Herramienta de Medición</h2>

            {/* Toggle measure mode */}
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: BRAND.textSecondary }}>Modo medición</span>
              <button
                onClick={() => {
                  if (measureMode) { clearMeasurement(); setMeasureMode(false); setMeasureChainMode(false); }
                  else setMeasureMode(true);
                }}
                className="w-11 h-6 rounded-full transition-colors relative"
                style={{ backgroundColor: measureMode ? BRAND.teal : "#D1D5DB" }}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${measureMode ? "left-5.5" : "left-0.5"}`} />
              </button>
            </div>

            {/* Measure type selector */}
            {measureMode && (
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(false); setMeasureAreaMode(false); }}
                  className="px-2 py-2 text-[10px] rounded-lg font-medium transition-all"
                  style={{
                    backgroundColor: !measureChainMode && !measureAreaMode ? BRAND.teal : BRAND.bg,
                    color: !measureChainMode && !measureAreaMode ? "#fff" : BRAND.textSecondary,
                    border: `1px solid ${!measureChainMode && !measureAreaMode ? BRAND.teal : BRAND.border}`,
                  }}
                >
                  <Ruler className="w-3 h-3 inline mr-0.5" /> A→B
                </button>
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(true); setMeasureAreaMode(false); }}
                  className="px-2 py-2 text-[10px] rounded-lg font-medium transition-all"
                  style={{
                    backgroundColor: measureChainMode ? BRAND.teal : BRAND.bg,
                    color: measureChainMode ? "#fff" : BRAND.textSecondary,
                    border: `1px solid ${measureChainMode ? BRAND.teal : BRAND.border}`,
                  }}
                >
                  <GitBranch className="w-3 h-3 inline mr-0.5" /> Cadena
                </button>
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(false); setMeasureAreaMode(true); }}
                  className="px-2 py-2 text-[10px] rounded-lg font-medium transition-all"
                  style={{
                    backgroundColor: measureAreaMode ? '#4fc3f7' : BRAND.bg,
                    color: measureAreaMode ? "#fff" : BRAND.textSecondary,
                    border: `1px solid ${measureAreaMode ? '#4fc3f7' : BRAND.border}`,
                  }}
                >
                  <Pentagon className="w-3 h-3 inline mr-0.5" /> Área
                </button>
              </div>
            )}

            {/* Instructions */}
            {measureMode && (
              <div className="rounded-lg p-3 text-[11px] space-y-1" style={{ backgroundColor: measureAreaMode ? '#4fc3f710' : `${BRAND.teal}10`, color: BRAND.textSecondary }}>
                {measureAreaMode ? (
                  <>
                    <p><strong>Área:</strong> Clic en 3 o más vértices para definir un polígono.</p>
                    <p>Se calcula el área y perímetro automáticamente.</p>
                  </>
                ) : measureChainMode ? (
                  <>
                    <p><strong>Cadena:</strong> Clic en puntos sucesivos para medir segmentos acumulativos.</p>
                    <p>Cada segmento muestra su distancia individual. El total se acumula abajo.</p>
                  </>
                ) : (
                  <>
                    <p><strong>Paso 1:</strong> Clic en el primer punto</p>
                    <p><strong>Paso 2:</strong> Clic en el segundo punto</p>
                    <p>Snap automático a aristas del modelo.</p>
                  </>
                )}
              </div>
            )}

            {/* Single measurement result */}
            {!measureChainMode && !measureAreaMode && measureDistance !== null && (
              <div className="rounded-lg p-4 text-center" style={{ backgroundColor: `${BRAND.teal}15`, border: `1px solid ${BRAND.teal}30` }}>
                <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: BRAND.textMuted }}>Distancia</p>
                <p className="text-2xl font-bold font-mono" style={{ color: BRAND.navy }}>
                  {measureDistance >= 1.0 ? measureDistance.toFixed(3) : (measureDistance * 100).toFixed(1)}
                </p>
                <p className="text-xs" style={{ color: BRAND.teal }}>{measureDistance >= 1.0 ? "metros" : "centímetros"}</p>
                {measurePoints.length === 2 && (
                  <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] font-mono" style={{ color: BRAND.textMuted }}>
                    <span>ΔX: {Math.abs(measurePoints[1].x - measurePoints[0].x).toFixed(3)}m</span>
                    <span>ΔY: {Math.abs(measurePoints[1].y - measurePoints[0].y).toFixed(3)}m</span>
                    <span>ΔZ: {Math.abs(measurePoints[1].z - measurePoints[0].z).toFixed(3)}m</span>
                  </div>
                )}
                <button
                  onClick={saveMeasurement}
                  className="mt-2 px-3 py-1.5 text-[10px] rounded-md font-medium transition-colors"
                  style={{ backgroundColor: BRAND.navy, color: "#fff" }}
                >
                  Guardar medición
                </button>
              </div>
            )}

            {/* Chain measurement result */}
            {measureChainMode && measureChainPoints.length >= 2 && (
              <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: `${BRAND.teal}15`, border: `1px solid ${BRAND.teal}30` }}>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Cadena ({measureChainDistances.length} segmentos)</p>
                  <span className="text-[10px] font-mono" style={{ color: BRAND.teal }}>{measureChainPoints.length} pts</span>
                </div>
                {measureChainDistances.map((d, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] px-2 py-1 rounded" style={{ backgroundColor: `${BRAND.navy}08` }}>
                    <span style={{ color: BRAND.textSecondary }}>Seg. {i + 1}</span>
                    <span className="font-mono font-medium" style={{ color: BRAND.navy }}>
                      {d >= 1.0 ? `${d.toFixed(3)} m` : `${(d * 100).toFixed(1)} cm`}
                    </span>
                  </div>
                ))}
                <div className="pt-2 border-t flex items-center justify-between" style={{ borderColor: `${BRAND.teal}30` }}>
                  <span className="text-xs font-bold" style={{ color: BRAND.navy }}>Total</span>
                  <span className="text-lg font-bold font-mono" style={{ color: BRAND.teal }}>
                    {(() => { const t = measureChainDistances.reduce((a, b) => a + b, 0); return t >= 1.0 ? `${t.toFixed(3)} m` : `${(t * 100).toFixed(1)} cm`; })()}
                  </span>
                </div>
                <button
                  onClick={saveMeasurement}
                  className="w-full px-3 py-1.5 text-[10px] rounded-md font-medium transition-colors"
                  style={{ backgroundColor: BRAND.navy, color: "#fff" }}
                >
                  Guardar cadena
                </button>
              </div>
            )}

            {/* Area measurement result */}
            {measureAreaMode && measureAreaResult && measureAreaPoints.length >= 3 && (
              <div className="rounded-lg p-4 text-center" style={{ backgroundColor: '#4fc3f715', border: '1px solid #4fc3f730' }}>
                <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: '#4fc3f7' }}>Área</p>
                <p className="text-2xl font-bold font-mono" style={{ color: BRAND.navy }}>
                  {measureAreaResult.area >= 1.0 ? measureAreaResult.area.toFixed(2) : (measureAreaResult.area * 10000).toFixed(0)}
                </p>
                <p className="text-xs" style={{ color: '#4fc3f7' }}>{measureAreaResult.area >= 1.0 ? 'm\u00b2' : 'cm\u00b2'}</p>
                <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] font-mono" style={{ color: BRAND.textMuted }}>
                  <span>Per\u00edmetro: {measureAreaResult.perimeter >= 1.0 ? `${measureAreaResult.perimeter.toFixed(2)} m` : `${(measureAreaResult.perimeter * 100).toFixed(0)} cm`}</span>
                  <span>{measureAreaPoints.length} v\u00e9rtices</span>
                </div>
                <button
                  onClick={saveMeasurement}
                  className="mt-2 px-3 py-1.5 text-[10px] rounded-md font-medium transition-colors"
                  style={{ backgroundColor: '#4fc3f7', color: "#fff" }}
                >
                  Guardar \u00e1rea
                </button>
              </div>
            )}

            {/* Clear button */}
            {(measurePoints.length > 0 || measureDistance !== null || measureChainPoints.length > 0 || measureAreaPoints.length > 0) && (
              <button
                onClick={clearMeasurement}
                className="w-full px-3 py-2.5 text-xs rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors hover:opacity-80"
                style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Limpiar medición actual
              </button>
            )}

            {/* Measurement history */}
            {measureHistory.length > 0 && (
              <div className="pt-3 border-t space-y-2" style={{ borderColor: `${BRAND.navy}10` }}>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Historial ({measureHistory.length})</p>
                  <div className="flex gap-1">
                    <button
                      onClick={exportMeasurements}
                      className="px-2 py-1 text-[10px] rounded font-medium transition-colors"
                      style={{ color: BRAND.teal, border: `1px solid ${BRAND.teal}40` }}
                    >
                      <Download className="w-3 h-3 inline mr-0.5" /> CSV
                    </button>
                    <button
                      onClick={() => setMeasureHistory([])}
                      className="px-2 py-1 text-[10px] rounded font-medium transition-colors"
                      style={{ color: "#ef4444", border: "1px solid #ef444440" }}
                    >
                      <Trash2 className="w-3 h-3 inline" />
                    </button>
                  </div>
                </div>
                {measureHistory.map(m => (
                  <div key={m.id} className="rounded-lg p-2.5 flex items-center justify-between" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {m.type === "chain" ? <GitBranch className="w-3 h-3" style={{ color: BRAND.teal }} /> : <Ruler className="w-3 h-3" style={{ color: BRAND.teal }} />}
                        <span className="text-xs font-bold font-mono" style={{ color: BRAND.navy }}>
                          {m.total >= 1.0 ? `${m.total.toFixed(3)} m` : `${(m.total * 100).toFixed(1)} cm`}
                        </span>
                        {m.type === "chain" && <span className="text-[9px]" style={{ color: BRAND.textMuted }}>({m.distances.length} seg.)</span>}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        {m.floorLabel && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${BRAND.teal}15`, color: BRAND.teal }}>{m.floorLabel}</span>}
                        <span className="text-[9px]" style={{ color: BRAND.textMuted }}>{new Date(m.timestamp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => setMeasureHistory(prev => prev.filter(x => x.id !== m.id))}
                      className="p-1 rounded hover:bg-gray-200 transition-colors flex-shrink-0"
                    >
                      <X className="w-3 h-3" style={{ color: BRAND.textMuted }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case "visual": {
        const VISUAL_MODES: { id: VisualMode; label: string; icon: React.ReactNode; desc: string }[] = [
          { id: "normal", label: "Normal", icon: <Box className="w-4 h-4" />, desc: "Colores originales" },
          { id: "crystal", label: "Cristal", icon: <Glasses className="w-4 h-4" />, desc: "Muros transparentes" },
          { id: "solid", label: "Sólido", icon: <Box className="w-4 h-4" />, desc: "Todo opaco, aristas marcadas" },
          { id: "dark", label: "Oscuro", icon: <Moon className="w-4 h-4" />, desc: "Fondo oscuro, aristas neón" },
          { id: "translucent", label: "Translúcido", icon: <Ghost className="w-4 h-4" />, desc: "Todo semitransparente" },
          { id: "xray", label: "Rayos X", icon: <Zap className="w-4 h-4" />, desc: "Estructura + tuberías" },
        ];
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            {/* Mode Presets */}
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: BRAND.textMuted }}>Modo Visual</h2>
              <div className="grid grid-cols-3 gap-1.5">
                {VISUAL_MODES.map(m => (
                  <button key={m.id} onClick={() => applyVisualMode(m.id)}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg transition-all text-[10px]"
                    style={{
                      backgroundColor: visualMode === m.id ? BRAND.teal : BRAND.bg,
                      color: visualMode === m.id ? "#fff" : BRAND.textSecondary,
                      border: `1px solid ${visualMode === m.id ? BRAND.teal : BRAND.border}`,
                    }}>
                    {m.icon}
                    <span className="font-medium">{m.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Walk Height */}
            {walkMode && (
              <div className="rounded-lg p-3" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                <div className="flex justify-between text-[10px] mb-1" style={{ color: BRAND.textMuted }}>
                  <span className="flex items-center gap-1"><ArrowUpDown className="w-3 h-3" /> Altura cámara</span>
                  <span className="font-mono">{walkHeight.toFixed(2)}m</span>
                </div>
                <input type="range" min={0.5} max={3.0} step={0.05} value={walkHeight}
                  onChange={e => setWalkHeight(parseFloat(e.target.value))}
                  className="w-full h-1.5" style={{ accentColor: BRAND.teal }} />
                <div className="flex justify-between text-[8px] mt-0.5" style={{ color: BRAND.textMuted }}>
                  <span>0.5m (agachado)</span><span>1.65m (normal)</span><span>3.0m (elevado)</span>
                </div>
              </div>
            )}

            {/* Per-layer controls */}
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: BRAND.textMuted }}>Ajuste por Capa</h2>
              {files.map(f => {
                const vs = visualSettings[f.specialty] || { hueShift: 0, saturation: 1, opacity: 100, edgeThickness: 1, edgeColor: "#999999" };
                const layer = layers[f.specialty];
                if (!layer?.loaded) return null;
                return (
                  <div key={f.specialty} className="rounded-lg p-3 space-y-3 mb-2" style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: f.color }} />
                      <span className="text-xs font-medium flex-1 truncate" style={{ color: BRAND.textPrimary }}>{f.label}</span>
                    </div>
                    {/* Opacity */}
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: BRAND.textMuted }}>
                        <span className="flex items-center gap-1"><SunMedium className="w-3 h-3" /> Opacidad</span>
                        <span className="font-mono">{vs.opacity}%</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} value={vs.opacity}
                        onChange={e => updateVisualSetting(f.specialty, "opacity", parseInt(e.target.value))}
                        className="w-full h-1.5" style={{ accentColor: f.color }} />
                    </div>
                    {/* Hue Shift */}
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: BRAND.textMuted }}>
                        <span className="flex items-center gap-1"><Palette className="w-3 h-3" /> Tono</span>
                        <span className="font-mono">{vs.hueShift > 0 ? "+" : ""}{vs.hueShift}°</span>
                      </div>
                      <input type="range" min={-180} max={180} step={5} value={vs.hueShift}
                        onChange={e => updateVisualSetting(f.specialty, "hueShift", parseInt(e.target.value))}
                        className="w-full h-1.5" style={{ accentColor: f.color }} />
                    </div>
                    {/* Saturation */}
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: BRAND.textMuted }}>
                        <span className="flex items-center gap-1"><Contrast className="w-3 h-3" /> Saturación</span>
                        <span className="font-mono">{vs.saturation.toFixed(1)}x</span>
                      </div>
                      <input type="range" min={0} max={2} step={0.1} value={vs.saturation}
                        onChange={e => updateVisualSetting(f.specialty, "saturation", parseFloat(e.target.value))}
                        className="w-full h-1.5" style={{ accentColor: f.color }} />
                    </div>
                    {/* Edge Thickness */}
                    <div>
                      <div className="flex justify-between text-[10px] mb-1" style={{ color: BRAND.textMuted }}>
                        <span className="flex items-center gap-1"><Scan className="w-3 h-3" /> Aristas</span>
                        <span className="font-mono">{vs.edgeThickness.toFixed(1)}</span>
                      </div>
                      <input type="range" min={0} max={4} step={0.5} value={vs.edgeThickness}
                        onChange={e => updateVisualSetting(f.specialty, "edgeThickness", parseFloat(e.target.value))}
                        className="w-full h-1.5" style={{ accentColor: f.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      }

      case "annotate": {
        const annCounts = { observacion: 0, defecto: 0, aprobado: 0, informativo: 0, resolved: 0 };
        annotations.forEach(a => { annCounts[a.category]++; if (a.resolved) annCounts.resolved++; });
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            <h2 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Anotaciones en Campo</h2>

            {/* Toggle annotation mode */}
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: BRAND.textSecondary }}>Modo anotación</span>
              <button
                onClick={() => setAnnotationMode(!annotationMode)}
                className="w-11 h-6 rounded-full transition-colors relative"
                style={{ backgroundColor: annotationMode ? BRAND.teal : "#D1D5DB" }}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${annotationMode ? "left-5.5" : "left-0.5"}`} />
              </button>
            </div>

            {/* Category summary chips */}
            {annotations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(["observacion", "defecto", "aprobado", "informativo"] as AnnotationCategory[]).map(cat => (
                  <span key={cat} className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white" style={{ backgroundColor: ANNOTATION_COLORS[cat], opacity: annCounts[cat] > 0 ? 1 : 0.3 }}>
                    {ANNOTATION_LABELS[cat]} ({annCounts[cat]})
                  </span>
                ))}
                {annCounts.resolved > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ backgroundColor: '#6B7280', color: '#fff' }}>
                    Resueltas ({annCounts.resolved})
                  </span>
                )}
              </div>
            )}

            {annotationMode && !pendingAnnotationPoint && (
              <div className="rounded-lg p-3 text-[11px]" style={{ backgroundColor: `${BRAND.teal}10`, color: BRAND.textSecondary }}>
                <p>Haz clic en el modelo para colocar un pin de anotación.</p>
              </div>
            )}

            {/* Pending annotation input with category selector */}
            {pendingAnnotationPoint && (
              <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: `${BRAND.teal}15`, border: `1px solid ${BRAND.teal}30` }}>
                <p className="text-[10px] uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Nueva nota</p>
                {/* Category selector */}
                <div className="flex gap-1">
                  {(["observacion", "defecto", "aprobado", "informativo"] as AnnotationCategory[]).map(cat => (
                    <button
                      key={cat}
                      onClick={() => setAnnotationCategory(cat)}
                      className="px-2 py-1 rounded text-[10px] font-medium transition-all"
                      style={{
                        backgroundColor: annotationCategory === cat ? ANNOTATION_COLORS[cat] : 'transparent',
                        color: annotationCategory === cat ? '#fff' : BRAND.textSecondary,
                        border: `1px solid ${annotationCategory === cat ? ANNOTATION_COLORS[cat] : BRAND.border}`,
                      }}
                    >
                      {ANNOTATION_LABELS[cat]}
                    </button>
                  ))}
                </div>
                <textarea
                  value={annotationText}
                  onChange={e => setAnnotationText(e.target.value)}
                  placeholder="Escribe la anotación..."
                  className="w-full px-3 py-2 text-xs rounded-lg focus:outline-none focus:ring-2 resize-none"
                  style={{ backgroundColor: BRAND.cardBg, border: `1px solid ${BRAND.border}`, color: BRAND.textPrimary, "--tw-ring-color": BRAND.teal } as any}
                  rows={3}
                  autoFocus
                />
                {/* Show detected floor */}
                {(() => {
                  const fl = getFloorLabelFromY(pendingAnnotationPoint.y);
                  return fl ? (
                    <p className="text-[10px]" style={{ color: BRAND.textMuted }}>
                      <Building2 className="w-3 h-3 inline mr-1" />Nivel detectado: <strong>{fl}</strong>
                    </p>
                  ) : null;
                })()}
                <div className="flex gap-2">
                  <button
                    onClick={addAnnotation}
                    disabled={!annotationText.trim()}
                    className="flex-1 px-3 py-2 text-xs rounded-lg font-medium transition-colors disabled:opacity-40"
                    style={{ backgroundColor: ANNOTATION_COLORS[annotationCategory], color: "#fff" }}
                  >
                    Guardar {ANNOTATION_LABELS[annotationCategory]}
                  </button>
                  <button
                    onClick={() => { setPendingAnnotationPoint(null); setAnnotationText(""); }}
                    className="px-3 py-2 text-xs rounded-lg font-medium transition-colors"
                    style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Annotation list with categories */}
            {annotations.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Notas ({annotations.length})</p>
                {annotations.map(ann => (
                  <div
                    key={ann.id}
                    className="rounded-lg p-3 space-y-1.5"
                    style={{
                      backgroundColor: BRAND.bg,
                      border: `1px solid ${BRAND.border}`,
                      borderLeft: `3px solid ${ANNOTATION_COLORS[ann.category]}`,
                      opacity: ann.resolved ? 0.6 : 1,
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white" style={{ backgroundColor: ANNOTATION_COLORS[ann.category] }}>
                            {ANNOTATION_LABELS[ann.category].toUpperCase()}
                          </span>
                          {ann.floorLabel && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${BRAND.teal}15`, color: BRAND.teal }}>
                              {ann.floorLabel}
                            </span>
                          )}
                          {ann.resolved && (
                            <CheckCircle2 className="w-3 h-3" style={{ color: '#22C55E' }} />
                          )}
                        </div>
                        <p className={`text-xs ${ann.resolved ? 'line-through' : ''}`} style={{ color: BRAND.textPrimary }}>{ann.text}</p>
                        <p className="text-[10px] mt-0.5" style={{ color: BRAND.textMuted }}>
                          {new Date(ann.timestamp).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex flex-col gap-1 flex-shrink-0">
                        <button
                          onClick={() => toggleAnnotationResolved(ann.id)}
                          className="p-1 rounded hover:bg-gray-200 transition-colors"
                          title={ann.resolved ? "Reabrir" : "Marcar resuelta"}
                        >
                          {ann.resolved ? <RefreshCw className="w-3 h-3" style={{ color: BRAND.textMuted }} /> : <Check className="w-3 h-3" style={{ color: '#22C55E' }} />}
                        </button>
                        <button
                          onClick={() => {
                            // Navigate camera to annotation position
                            const cam = cameraRef.current;
                            const controls = controlsRef.current;
                            if (cam && controls) {
                              const target = ann.position.clone();
                              const offset = new THREE.Vector3(5, 3, 5);
                              cam.position.copy(target).add(offset);
                              controls.target.copy(target);
                              controls.update();
                            }
                          }}
                          className="p-1 rounded hover:bg-gray-200 transition-colors"
                          title="Ir a ubicación"
                        >
                          <Crosshair className="w-3 h-3" style={{ color: BRAND.textMuted }} />
                        </button>
                        <button
                          onClick={() => removeAnnotation(ann.id)}
                          className="p-1 rounded hover:bg-red-100 transition-colors"
                          title="Eliminar"
                        >
                          <Trash2 className="w-3 h-3" style={{ color: '#EF4444' }} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {annotations.length === 0 && !annotationMode && (
              <div className="text-center py-6">
                <MessageSquarePlus className="w-8 h-8 mx-auto mb-2" style={{ color: BRAND.border }} />
                <p className="text-xs" style={{ color: BRAND.textMuted }}>Activa el modo anotación para agregar notas al modelo</p>
              </div>
            )}
          </div>
        );
      }

      case "collisions":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4">
            <h2 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Detección de Colisiones MEP</h2>

            <div className="rounded-lg p-3 text-[11px]" style={{ backgroundColor: `${BRAND.teal}08`, color: BRAND.textSecondary }}>
              <p>Detecta interferencias entre especialidades MEP (plomería, HVAC, eléctrica, mecánica) usando intersecciones de bounding box a nivel de mesh.</p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={runCollisionDetection}
                disabled={collisionRunning}
                className="flex-1 px-3 py-2.5 text-xs rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                style={{ backgroundColor: BRAND.teal, color: "#fff" }}
              >
                {collisionRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                {collisionRunning ? "Analizando..." : "Ejecutar Análisis"}
              </button>
              {collisions.length > 0 && (
                <button
                  onClick={clearCollisions}
                  className="px-3 py-2.5 text-xs rounded-lg font-medium transition-colors"
                  style={{ backgroundColor: BRAND.bg, color: BRAND.textSecondary, border: `1px solid ${BRAND.border}` }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {collisions.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wider" style={{ color: BRAND.textMuted }}>
                    {collisions.length} interferencia{collisions.length > 1 ? "s" : ""} detectada{collisions.length > 1 ? "s" : ""}
                  </p>
                  <div className="flex gap-1">
                    {["high", "medium", "low"].map(sev => {
                      const count = collisions.filter(c => c.severity === sev).length;
                      if (count === 0) return null;
                      const color = sev === "high" ? "#EF4444" : sev === "medium" ? "#F97316" : "#EAB308";
                      return (
                        <span key={sev} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${color}20`, color }}>
                          {count}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {collisions.map(c => {
                  const severityColor = c.severity === "high" ? "#EF4444" : c.severity === "medium" ? "#F97316" : "#EAB308";
                  return (
                    <button
                      key={c.id}
                      onClick={() => flyToCollision(c.position)}
                      className="w-full rounded-lg p-3 text-left transition-all hover:scale-[1.01]"
                      style={{ backgroundColor: BRAND.cardBg, border: `1px solid ${BRAND.border}` }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="w-2.5 h-2.5 rounded-full mt-0.5 flex-shrink-0" style={{ backgroundColor: severityColor }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate" style={{ color: BRAND.textPrimary }}>{c.description}</p>
                          <p className="text-[10px] font-mono mt-0.5" style={{ color: BRAND.textMuted }}>
                            Pos: ({c.position.x.toFixed(1)}, {c.position.y.toFixed(1)}, {c.position.z.toFixed(1)})
                          </p>
                        </div>
                        <Crosshair className="w-3.5 h-3.5 flex-shrink-0" style={{ color: BRAND.teal }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {collisions.length === 0 && !collisionRunning && (
              <div className="text-center py-6">
                <Shield className="w-8 h-8 mx-auto mb-2" style={{ color: BRAND.border }} />
                <p className="text-xs" style={{ color: BRAND.textMuted }}>Sin resultados aún. Ejecuta el análisis para detectar interferencias.</p>
              </div>
            )}
          </div>
        );

      case "align":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-4 overflow-y-auto">
            <h2 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Alineación de Modelos</h2>
            <p className="text-[10px]" style={{ color: BRAND.textMuted }}>Ajusta rotación, posición y escala de cada especialidad para alinearlas correctamente.</p>
            <div className="space-y-2">
              {files.map((f: any) => {
                const isEditing = alignEditing === f.specialty;
                const vals = alignValues[f.specialty] || { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1 };
                return (
                  <div key={f.specialty} className="rounded-lg p-2.5" style={{ backgroundColor: `${BRAND.navy}08`, border: isEditing ? `1px solid ${BRAND.teal}` : `1px solid ${BRAND.border}` }}>
                    <button
                      className="w-full flex items-center justify-between text-left"
                      onClick={() => setAlignEditing(isEditing ? null : f.specialty)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: f.color }} />
                        <span className="text-xs font-medium" style={{ color: BRAND.textPrimary }}>{f.label || f.specialty}</span>
                      </div>
                      <span className="text-[10px]" style={{ color: BRAND.textMuted }}>
                        {vals.rotX !== 0 || vals.rotY !== 0 || vals.rotZ !== 0 || vals.posX !== 0 || vals.posY !== 0 || vals.posZ !== 0 || vals.modelScale !== 1 ? "• modificado" : ""}
                      </span>
                    </button>
                    {isEditing && (
                      <div className="mt-2.5 space-y-2">
                        {/* Rotation */}
                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Rotación (°)</span>
                          <div className="grid grid-cols-3 gap-1.5 mt-1">
                            {(["rotX", "rotY", "rotZ"] as const).map((axis) => (
                              <div key={axis}>
                                <label className="text-[9px]" style={{ color: BRAND.textMuted }}>{axis.replace("rot", "")}</label>
                                <input
                                  type="number"
                                  step="1"
                                  value={vals[axis]}
                                  onChange={(e) => {
                                    const newVals = { ...vals, [axis]: parseFloat(e.target.value) || 0 };
                                    setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                                    applyAlignmentLive(f.specialty, newVals);
                                  }}
                                  className="w-full px-1.5 py-1 text-[11px] font-mono rounded border text-center"
                                  style={{ backgroundColor: BRAND.bg, borderColor: BRAND.border, color: BRAND.textPrimary }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                        {/* Position */}
                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Posición (m)</span>
                          <div className="grid grid-cols-3 gap-1.5 mt-1">
                            {(["posX", "posY", "posZ"] as const).map((axis) => (
                              <div key={axis}>
                                <label className="text-[9px]" style={{ color: BRAND.textMuted }}>{axis.replace("pos", "")}</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={vals[axis]}
                                  onChange={(e) => {
                                    const newVals = { ...vals, [axis]: parseFloat(e.target.value) || 0 };
                                    setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                                    applyAlignmentLive(f.specialty, newVals);
                                  }}
                                  className="w-full px-1.5 py-1 text-[11px] font-mono rounded border text-center"
                                  style={{ backgroundColor: BRAND.bg, borderColor: BRAND.border, color: BRAND.textPrimary }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                        {/* Scale */}
                        <div>
                          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Escala</span>
                          <div className="mt-1">
                            <input
                              type="number"
                              step="0.001"
                              min="0.001"
                              value={vals.modelScale}
                              onChange={(e) => {
                                const newVals = { ...vals, modelScale: parseFloat(e.target.value) || 1 };
                                setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                                applyAlignmentLive(f.specialty, newVals);
                              }}
                              className="w-20 px-1.5 py-1 text-[11px] font-mono rounded border text-center"
                              style={{ backgroundColor: BRAND.bg, borderColor: BRAND.border, color: BRAND.textPrimary }}
                            />
                          </div>
                        </div>
                        {/* Quick presets */}
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => {
                              const newVals = { ...vals, rotX: -90 };
                              setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                              applyAlignmentLive(f.specialty, newVals);
                            }}
                            className="px-2 py-0.5 text-[9px] rounded"
                            style={{ backgroundColor: `${BRAND.teal}20`, color: BRAND.teal }}
                          >Z-up → Y-up</button>
                          <button
                            onClick={() => {
                              const newVals = { ...vals, modelScale: 0.3048 };
                              setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                              applyAlignmentLive(f.specialty, newVals);
                            }}
                            className="px-2 py-0.5 text-[9px] rounded"
                            style={{ backgroundColor: `${BRAND.teal}20`, color: BRAND.teal }}
                          >Pies → Metros</button>
                          <button
                            onClick={() => {
                              const newVals = { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1 };
                              setAlignValues(prev => ({ ...prev, [f.specialty]: newVals }));
                              applyAlignmentLive(f.specialty, newVals);
                            }}
                            className="px-2 py-0.5 text-[9px] rounded"
                            style={{ backgroundColor: `${BRAND.navy}20`, color: BRAND.textMuted }}
                          >Reset</button>
                        </div>
                        {/* Save button */}
                        <button
                          onClick={async () => {
                            await updateFileTransformMutation.mutateAsync({
                              fileId: f.id,
                              ...vals,
                            });
                            setAlignEditing(null);
                          }}
                          disabled={updateFileTransformMutation.isPending}
                          className="w-full py-2 rounded-lg text-xs font-semibold text-white transition-colors"
                          style={{ backgroundColor: BRAND.teal }}
                        >
                          {updateFileTransformMutation.isPending ? "Guardando..." : "Guardar transformación"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );

      case "settings":
        return (
          <div className="px-3 lg:px-4 py-4 space-y-5">
            <h2 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Ajustes</h2>

            {/* Walk speed */}
            <div>
              <div className="flex justify-between text-xs mb-1.5" style={{ color: BRAND.textSecondary }}>
                <span>Velocidad caminar</span>
                <span className="font-mono">{walkSpeed.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={1.0}
                step={0.05}
                value={walkSpeed}
                onChange={(e) => setWalkSpeed(parseFloat(e.target.value))}
                className="w-full"
                style={{ accentColor: BRAND.teal }}
              />
            </div>

            {/* Look sensitivity */}
            <div>
              <div className="flex justify-between text-xs mb-1.5" style={{ color: BRAND.textSecondary }}>
                <span>Sensibilidad mirada</span>
                <span className="font-mono">{lookSensitivity.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={3.0}
                step={0.1}
                value={lookSensitivity}
                onChange={(e) => setLookSensitivity(parseFloat(e.target.value))}
                className="w-full"
                style={{ accentColor: BRAND.teal }}
              />
            </div>

            {/* Gyro sensitivity */}
            <div>
              <div className="flex justify-between text-xs mb-1.5" style={{ color: BRAND.textSecondary }}>
                <span>Sensibilidad giroscopio</span>
                <span className="font-mono">{gyroSensitivity.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={3.0}
                step={0.1}
                value={gyroSensitivity}
                onChange={(e) => setGyroSensitivity(parseFloat(e.target.value))}
                className="w-full"
                style={{ accentColor: BRAND.teal }}
              />
            </div>

            {/* Grid toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MapIcon className="w-4 h-4" style={{ color: BRAND.textSecondary }} />
                <span className="text-xs" style={{ color: BRAND.textSecondary }}>Rejilla adaptativa</span>
              </div>
              <button
                onClick={() => setShowGrid(prev => !prev)}
                className="w-11 h-6 rounded-full transition-colors relative"
                style={{ backgroundColor: showGrid ? BRAND.teal : "#D1D5DB" }}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${showGrid ? "left-5.5" : "left-0.5"}`} />
              </button>
            </div>
            {showGrid && (
              <div className="rounded-lg p-2.5 text-[10px]" style={{ backgroundColor: `${BRAND.teal}08`, color: BRAND.textMuted }}>
                <p>La rejilla cambia resolución automáticamente:</p>
                <p className="mt-1"><strong style={{ color: BRAND.textSecondary }}>Cerca (&lt;10m)</strong>: celdas de 10cm</p>
                <p><strong style={{ color: BRAND.textSecondary }}>Media (10-60m)</strong>: celdas de 1m</p>
                <p><strong style={{ color: BRAND.textSecondary }}>Lejos (&gt;40m)</strong>: celdas de 10m</p>
              </div>
            )}

            {/* Floor labels toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4" style={{ color: BRAND.textSecondary }} />
                <span className="text-xs" style={{ color: BRAND.textSecondary }}>Niveles de piso (3D)</span>
              </div>
              <button
                onClick={() => setShowFloorLabels(prev => !prev)}
                className="w-11 h-6 rounded-full transition-colors relative"
                style={{ backgroundColor: showFloorLabels ? BRAND.teal : "#D1D5DB" }}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${showFloorLabels ? "left-5.5" : "left-0.5"}`} />
              </button>
            </div>

            {/* Add files to project */}
            <div>
              <button
                onClick={() => { setShowAddFileDialog(true); setAddFileSuccess([]); }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-colors"
                style={{ backgroundColor: BRAND.teal, color: "#fff" }}
              >
                <FolderPlus className="w-4 h-4" />
                Agregar Archivos GLB
              </button>
              <p className="text-[10px] mt-1.5" style={{ color: BRAND.textMuted }}>Sube nuevas especialidades o reemplaza existentes</p>
            </div>

            {/* Cache management */}
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: BRAND.textMuted }}>Caché de modelos</h3>
              <div className="rounded-lg p-3 space-y-2" style={{ backgroundColor: `${BRAND.navy}08` }}>
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: BRAND.textSecondary }}>Almacenamiento local</span>
                  <CacheInfo />
                </div>
                <p className="text-[10px]" style={{ color: BRAND.textMuted }}>Los modelos se guardan en tu dispositivo para carga instantánea.</p>
                <button
                  onClick={async () => {
                    await clearCache();
                    setCacheVersion(v => v + 1);
                  }}
                  className="w-full py-2 rounded-lg text-xs font-medium border transition-colors hover:bg-red-50"
                  style={{ borderColor: "#EF4444", color: "#EF4444" }}
                >
                  Limpiar caché
                </button>
              </div>
            </div>

            {/* Offline Mode */}
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: BRAND.textMuted }}>Descargar para Offline</h3>
              <div className="rounded-lg p-3 space-y-2.5" style={{ backgroundColor: `${BRAND.navy}08` }}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${navigator.onLine ? "bg-green-400" : "bg-red-400 animate-pulse"}`} />
                  <span className="text-xs" style={{ color: BRAND.textSecondary }}>
                    {navigator.onLine ? "Conectado" : "Sin conexi\u00f3n"}
                  </span>
                </div>
                <p className="text-[10px]" style={{ color: BRAND.textMuted }}>
                  Pre-descarga todos los modelos 3D para usar sin internet en obra. Los archivos se guardan en el cach\u00e9 local del dispositivo.
                </p>
                {offlineDownloading ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span style={{ color: BRAND.textSecondary }}>
                        <Loader2 className="w-3 h-3 animate-spin inline mr-1" style={{ color: BRAND.teal }} />
                        {offlineProgress.currentFile}
                      </span>
                      <span className="font-mono" style={{ color: BRAND.teal }}>
                        {offlineProgress.current}/{offlineProgress.total}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: `${BRAND.teal}20` }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${offlineProgress.pct}%`, backgroundColor: BRAND.teal }} />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={downloadAllForOffline}
                    disabled={!navigator.onLine}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-colors text-white disabled:opacity-50"
                    style={{ backgroundColor: BRAND.teal }}
                  >
                    <Download className="w-4 h-4" />
                    Descargar todo ({files.length} archivos)
                  </button>
                )}
              </div>
            </div>

            {/* Tips */}
            <div className="rounded-lg p-3 text-[11px] space-y-2" style={{ backgroundColor: `${BRAND.teal}10`, color: BRAND.textSecondary }}>
              <p><strong>Doble tap</strong>: recentrar vista / reset zoom</p>
              <p><strong>Pinch</strong>: zoom con dos dedos (modo órbita)</p>
              <p><strong>Giroscopio</strong>: orientación automática del teléfono</p>
            </div>
          </div>
        );
    }
  };

  const tabs = [
    { id: "layers" as const, icon: Layers, label: "Capas" },
    { id: "visual" as const, icon: Palette, label: "Visual" },
    { id: "measure" as const, icon: Ruler, label: "Medir" },
    { id: "collisions" as const, icon: AlertTriangle, label: "Clash" },
    { id: "annotate" as const, icon: Pin, label: "Notas" },
    { id: "coords" as const, icon: Move3D, label: "Coords" },
    { id: "clip" as const, icon: Scissors, label: "Corte" },
    { id: "info" as const, icon: MousePointer, label: "Info" },
    { id: "align" as const, icon: Crosshair, label: "Alinear" },
    { id: "settings" as const, icon: Settings2, label: "Ajustes" },
  ];

  const renderTabBar = () => (
    <div className="flex shrink-0" style={{ borderBottom: `1px solid ${BRAND.border}` }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className="flex-1 py-3 lg:py-2.5 text-[11px] font-medium flex flex-col items-center gap-1 transition-colors"
          style={{
            color: activeTab === tab.id ? BRAND.teal : BRAND.textMuted,
            borderBottom: activeTab === tab.id ? `2px solid ${BRAND.teal}` : "2px solid transparent",
            backgroundColor: activeTab === tab.id ? `${BRAND.teal}08` : "transparent",
          }}
        >
          <tab.icon className="w-4 h-4" />
          {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-full h-[100dvh] flex flex-col lg:flex-row relative overflow-hidden" style={{ backgroundColor: BRAND.bg }}>
      {/* ═══ 3D Viewport ═══ */}
      <div
        ref={containerRef}
        className="flex-1 relative"
        onClick={(e) => { if (measureMode && measureAreaMode) handleAreaMeasureClick(e); else if (measureMode && measureChainMode) handleChainMeasureClick(e); else if (measureMode) handleMeasureClick(e); else handleClick(e); }}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{ cursor: clipDragging ? "ns-resize" : walkMode ? "crosshair" : inspectionMode ? "pointer" : measureMode || annotationMode ? "crosshair" : "default", touchAction: "none" }}
      >
        {/* Drag & drop overlay */}
        {isDraggingOver && (
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none" style={{ backgroundColor: `${BRAND.teal}20`, border: `3px dashed ${BRAND.teal}`, borderRadius: 12 }}>
            <div className="text-center p-6 rounded-xl" style={{ backgroundColor: `${BRAND.bg}E0` }}>
              <FileUp className="w-12 h-12 mx-auto mb-3" style={{ color: BRAND.teal }} />
              <p className="text-lg font-semibold" style={{ color: BRAND.textPrimary }}>Soltar archivo aquí</p>
              <p className="text-sm mt-1" style={{ color: BRAND.textSecondary }}>GLB, IFC o RVT</p>
            </div>
          </div>
        )}
      </div>

      {/* Loading overlay */}
      {projectQuery.isLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: `${BRAND.bg}CC` }}>
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.teal }} />
        </div>
      )}

      {/* Not found overlay */}
      {!projectQuery.isLoading && !project && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: BRAND.bg }}>
          <div className="text-center">
            <p className="text-lg mb-4" style={{ color: BRAND.textPrimary }}>Proyecto no encontrado</p>
            <Button onClick={() => navigate("/")} style={{ backgroundColor: BRAND.teal }}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Volver
            </Button>
          </div>
        </div>
      )}

      {/* ═══ Top Header Bar ═══ */}
      <div className="absolute top-3 left-3 right-3 z-30 flex items-center justify-between pointer-events-none">
        {/* Left: back + project name */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => navigate("/")}
            className="shadow-sm rounded-lg p-2 hover:opacity-90 transition-opacity flex-shrink-0"
            style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
            aria-label="Volver"
          >
            <ArrowLeft className="w-4 h-4" style={{ color: BRAND.navy }} />
          </button>
          <span
            className="text-[11px] lg:text-sm font-semibold px-2 py-1.5 rounded-md shadow-sm truncate max-w-[90px] lg:max-w-[200px]"
            style={{ color: BRAND.navy, backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
            title={project?.name}
          >
            {project?.name}
          </span>
          {/* Bitacora + RFI + Report + UTM — hidden on mobile, visible on tablet/desktop */}
          <div className="hidden md:flex items-center gap-1.5">
            <button
              onClick={() => navigate(`/project/${projectId}/bitacora`)}
              className="shadow-sm rounded-lg p-2 hover:opacity-90 transition-opacity flex-shrink-0"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="Bitácora"
              title="Bitácora de observaciones"
            >
              <ClipboardList className="w-4 h-4" style={{ color: BRAND.navy }} />
            </button>
            <button
              onClick={() => navigate(`/project/${projectId}/rfi`)}
              className="shadow-sm rounded-lg p-2 hover:opacity-90 transition-opacity flex-shrink-0"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="RFI"
              title="Solicitudes de información"
            >
              <FileQuestion className="w-4 h-4" style={{ color: BRAND.navy }} />
            </button>
            <button
              onClick={() => navigate(`/project/${projectId}/report`)}
              className="shadow-sm rounded-lg p-2 hover:opacity-90 transition-opacity flex-shrink-0"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="Reporte"
              title="Exportar reporte PDF"
            >
              <FileBarChart className="w-4 h-4" style={{ color: BRAND.navy }} />
            </button>
            <button
              onClick={() => navigate(`/project/${projectId}/utm`)}
              className="shadow-sm rounded-lg p-2 hover:opacity-90 transition-opacity flex-shrink-0"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="UTM"
              title="Calibración UTM / GPS"
            >
              <MapPinned className="w-4 h-4" style={{ color: BRAND.navy }} />
            </button>
          </div>
        </div>
        {/* Right: navigation mode selector + AR */}
        <div className="pointer-events-auto flex gap-1.5 items-center">
          {/* AR Button - always visible */}
          {!arActive && (
            <button
              onClick={arStarting ? undefined : arSupported ? enterARMode : enterImmersiveWalk}
              disabled={arStarting}
              className={`rounded-xl px-3 py-2 shadow-md transition-all active:scale-95 flex-shrink-0 flex items-center gap-1.5 hover:opacity-90`}
              style={{ backgroundColor: BRAND.teal, border: `1px solid ${BRAND.teal}` }}
              aria-label="Modo Inmersivo"
              title={arSupported ? 'Ver en Realidad Aumentada' : 'Modo inmersivo con giroscopio'}
            >
              <Scan className="w-4 h-4" style={{ color: '#fff' }} />
              <span className="text-xs font-bold" style={{ color: '#fff' }}>{arSupported ? 'AR' : 'Inmersivo'}</span>
            </button>
          )}
          {/* Navigation Mode Selector: Orbit / Walk */}
          <div className="flex rounded-xl shadow-md overflow-hidden" style={{ border: `1px solid ${BRAND.border}` }}>
            {/* Orbit mode button */}
            <button
              onClick={() => { if (walkMode) exitWalkMode(); }}
              className="p-2.5 transition-all active:scale-95 flex-shrink-0"
              style={{
                backgroundColor: !walkMode ? BRAND.teal : `${BRAND.cardBg}F2`,
              }}
              aria-label="Modo órbita"
              title="Navegación orbital (rotar/zoom)"
            >
              <Orbit className="w-5 h-5" style={{ color: !walkMode ? "#fff" : BRAND.navy }} />
            </button>
            {/* Walk mode button */}
            <button
              onClick={() => { if (!walkMode) enterWalkMode(); }}
              className="p-2.5 transition-all active:scale-95 flex-shrink-0"
              style={{
                backgroundColor: walkMode ? BRAND.teal : `${BRAND.cardBg}F2`,
                borderLeft: `1px solid ${BRAND.border}`,
              }}
              aria-label="Modo caminar"
              title="Caminar por el edificio (primera persona)"
            >
              <Footprints className="w-5 h-5" style={{ color: walkMode ? "#fff" : BRAND.navy }} />
            </button>
          </div>
          {/* Floor picker — available in both orbit and walk mode */}
          <div className="relative">
            <button
              onClick={() => setShowFloorPicker(!showFloorPicker)}
              className="flex items-center gap-1 rounded-xl px-3 py-2.5 shadow-md text-xs font-semibold transition-all active:scale-95"
              style={{
                backgroundColor: floorIsolation ? "#F59E0B" : BRAND.teal,
                color: "#fff",
              }}
              title="Seleccionar nivel"
            >
              <Building2 className="w-4 h-4" />
              {floorIsolation && isolatedFloorIdx !== null
                ? FLOOR_LEVELS[isolatedFloorIdx].short
                : walkMode ? (currentFloor || "PB") : "Niveles"}
              <ChevronDown className="w-3 h-3" />
            </button>
            {/* Floor dropdown menu */}
            {showFloorPicker && (
              <div
                className="absolute top-full right-0 mt-1 rounded-2xl shadow-2xl overflow-hidden z-50"
                style={{ backgroundColor: BRAND.cardBg, border: `1px solid ${BRAND.border}`, minWidth: "220px", maxHeight: "70vh" }}
              >
                {/* Floor isolation toggle */}
                <div className="px-3 pt-3 pb-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                  <div className="flex flex-col">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Aislar Nivel</span>
                    <span className="text-[9px]" style={{ color: BRAND.textMuted }}>Corta todo lo de arriba</span>
                  </div>
                  <button
                    onClick={() => {
                      if (floorIsolation) {
                        setFloorIsolation(false);
                        setIsolatedFloorIdx(null);
                      } else {
                        setFloorIsolation(true);
                        // Default to PB (index 2) if nothing selected
                        if (isolatedFloorIdx === null) setIsolatedFloorIdx(2);
                      }
                    }}
                    className="w-11 h-6 rounded-full transition-colors relative flex-shrink-0"
                    style={{ backgroundColor: floorIsolation ? "#F59E0B" : "#D1D5DB" }}
                  >
                    <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition-all ${floorIsolation ? "left-5.5" : "left-0.5"}`} />
                  </button>
                </div>
                {/* "Ver todo" button when isolation is active */}
                {floorIsolation && (
                  <button
                    onClick={() => {
                      setFloorIsolation(false);
                      setIsolatedFloorIdx(null);
                      setShowFloorPicker(false);
                    }}
                    className="w-full px-3 py-2 text-xs font-semibold text-center transition-colors hover:bg-gray-50"
                    style={{ color: BRAND.teal, borderBottom: `1px solid ${BRAND.border}` }}
                  >
                    ← Ver edificio completo
                  </button>
                )}
                {/* Discipline filter chips — shown when floor isolation is active */}
                {floorIsolation && isolatedFloorIdx !== null && (
                  <div className="px-3 py-2" style={{ borderBottom: `1px solid ${BRAND.border}` }}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Disciplinas visibles</span>
                      <button
                        onClick={() => {
                          // Toggle all on/off
                          const allVisible = files.every((f: any) => layers[f.specialty]?.visible);
                          files.forEach((f: any) => {
                            const layer = layers[f.specialty];
                            if (layer?.loaded && layer.group) {
                              layer.group.visible = !allVisible;
                              if (layer.edgeGroup) layer.edgeGroup.visible = !allVisible;
                            }
                          });
                          setLayers(prev => {
                            const next = { ...prev };
                            files.forEach((f: any) => {
                              if (next[f.specialty]?.loaded) {
                                next[f.specialty] = { ...next[f.specialty], visible: !allVisible };
                              }
                            });
                            return next;
                          });
                        }}
                        className="text-[9px] font-semibold px-1.5 py-0.5 rounded hover:bg-gray-100 transition-colors"
                        style={{ color: BRAND.teal }}
                      >
                        {files.every((f: any) => layers[f.specialty]?.visible) ? "Ocultar todo" : "Mostrar todo"}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {files.map((f: any) => {
                        const layer = layers[f.specialty];
                        if (!layer?.loaded) return null;
                        const chipColor = customColors[f.specialty] || f.color || "#888";
                        return (
                          <button
                            key={f.specialty}
                            onClick={() => toggleLayer(f.specialty)}
                            onDoubleClick={() => {
                              // Double-click: isolate this discipline only
                              files.forEach((ff: any) => {
                                const l = layers[ff.specialty];
                                if (l?.loaded && l.group) {
                                  const show = ff.specialty === f.specialty;
                                  l.group.visible = show;
                                  if (l.edgeGroup) l.edgeGroup.visible = show;
                                }
                              });
                              setLayers(prev => {
                                const next = { ...prev };
                                files.forEach((ff: any) => {
                                  if (next[ff.specialty]?.loaded) {
                                    next[ff.specialty] = { ...next[ff.specialty], visible: ff.specialty === f.specialty };
                                  }
                                });
                                return next;
                              });
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold transition-all active:scale-95"
                            style={{
                              backgroundColor: layer.visible ? chipColor : "#E5E7EB",
                              color: layer.visible ? "#fff" : "#6B7280",
                              border: `1px solid ${layer.visible ? chipColor : "#D1D5DB"}`,
                            }}
                            title={`${f.specialty} — clic: mostrar/ocultar • doble clic: solo esta`}
                          >
                            <div
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: layer.visible ? "#fff" : chipColor }}
                            />
                            {f.specialty.length > 12 ? f.specialty.slice(0, 10) + "…" : f.specialty}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[8px] mt-1 opacity-50" style={{ color: BRAND.textMuted }}>Doble clic para aislar una disciplina</p>
                  </div>
                )}
                <div className="overflow-y-auto" style={{ maxHeight: floorIsolation ? "40vh" : "55vh" }}>
                  {/* Section header: Sótanos */}
                  <div className="px-3 pt-2 pb-1">
                    <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Sótanos</span>
                  </div>
                  {FLOOR_LEVELS.filter(f => f.y < 0).map((floor, _, arr) => {
                    const globalIdx = FLOOR_LEVELS.findIndex(fl => fl.short === floor.short);
                    const isIsolated = floorIsolation && isolatedFloorIdx === globalIdx;
                    const isActive = walkMode ? currentFloor === floor.short : isIsolated;
                    return (
                      <button
                        key={floor.short}
                        onClick={() => {
                          if (walkMode) teleportToFloor(floor.y);
                          if (floorIsolation) setIsolatedFloorIdx(globalIdx);
                          if (!walkMode && !floorIsolation) {
                            // In orbit mode without isolation, enable isolation on click
                            setFloorIsolation(true);
                            setIsolatedFloorIdx(globalIdx);
                          }
                          setShowFloorPicker(false);
                        }}
                        className="w-full px-3 py-2.5 text-sm font-medium text-left hover:bg-gray-50 transition-colors flex items-center justify-between gap-3"
                        style={{
                          color: isActive ? "#fff" : BRAND.textPrimary,
                          backgroundColor: isActive ? (floorIsolation ? "#F59E0B" : BRAND.teal) : "transparent",
                        }}
                      >
                        <span className="font-semibold">{floor.label}</span>
                        <span className="font-mono text-[10px] opacity-50">{floor.y.toFixed(1)}m</span>
                      </button>
                    );
                  })}
                  {/* Divider */}
                  <div className="mx-3 my-1" style={{ borderTop: `1px solid ${BRAND.border}` }} />
                  {/* Section header: Planta Baja */}
                  <div className="px-3 pt-1 pb-1">
                    <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Planta Baja</span>
                  </div>
                  {FLOOR_LEVELS.filter(f => f.y === 0).map((floor) => {
                    const globalIdx = FLOOR_LEVELS.findIndex(fl => fl.short === floor.short);
                    const isIsolated = floorIsolation && isolatedFloorIdx === globalIdx;
                    const isActive = walkMode ? currentFloor === floor.short : isIsolated;
                    return (
                      <button
                        key={floor.short}
                        onClick={() => {
                          if (walkMode) teleportToFloor(floor.y);
                          if (floorIsolation) setIsolatedFloorIdx(globalIdx);
                          if (!walkMode && !floorIsolation) {
                            setFloorIsolation(true);
                            setIsolatedFloorIdx(globalIdx);
                          }
                          setShowFloorPicker(false);
                        }}
                        className="w-full px-3 py-3 text-sm font-bold text-left hover:bg-gray-50 transition-colors flex items-center justify-between gap-3"
                        style={{
                          color: isActive ? "#fff" : BRAND.navy,
                          backgroundColor: isActive ? (floorIsolation ? "#F59E0B" : BRAND.teal) : `${BRAND.teal}08`,
                        }}
                      >
                        <span>{floor.label}</span>
                        <span className="font-mono text-[10px] opacity-50">0.0m</span>
                      </button>
                    );
                  })}
                  {/* Divider */}
                  <div className="mx-3 my-1" style={{ borderTop: `1px solid ${BRAND.border}` }} />
                  {/* Section header: Niveles */}
                  <div className="px-3 pt-1 pb-1">
                    <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: BRAND.textMuted }}>Niveles</span>
                  </div>
                  {FLOOR_LEVELS.filter(f => f.y > 0).map((floor) => {
                    const globalIdx = FLOOR_LEVELS.findIndex(fl => fl.short === floor.short);
                    const isIsolated = floorIsolation && isolatedFloorIdx === globalIdx;
                    const isActive = walkMode ? currentFloor === floor.short : isIsolated;
                    return (
                      <button
                        key={floor.short}
                        onClick={() => {
                          if (walkMode) teleportToFloor(floor.y);
                          if (floorIsolation) setIsolatedFloorIdx(globalIdx);
                          if (!walkMode && !floorIsolation) {
                            setFloorIsolation(true);
                            setIsolatedFloorIdx(globalIdx);
                          }
                          setShowFloorPicker(false);
                        }}
                        className="w-full px-3 py-2.5 text-sm font-medium text-left hover:bg-gray-50 transition-colors flex items-center justify-between gap-3"
                        style={{
                          color: isActive ? "#fff" : BRAND.textPrimary,
                          backgroundColor: isActive ? (floorIsolation ? "#F59E0B" : BRAND.teal) : "transparent",
                        }}
                      >
                        <span className="font-semibold">{floor.label}</span>
                        <span className="font-mono text-[10px] opacity-50">+{floor.y.toFixed(1)}m</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ Panel Toggle ═══ */}
      {!isMobile && (
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className="absolute top-3 z-30 rounded-lg p-2 shadow-md hover:opacity-90 transition-opacity"
          style={{
            right: panelOpen ? "324px" : "12px",
            backgroundColor: `${BRAND.cardBg}F2`,
            border: `1px solid ${BRAND.border}`,
          }}
          aria-label={panelOpen ? "Cerrar panel" : "Abrir panel"}
        >
          <Layers className="w-4 h-4" style={{ color: BRAND.navy }} />
        </button>
      )}

      {isMobile && (
        <button
          onClick={() => {
            setPanelOpen(!panelOpen);
            if (!panelOpen) setBottomSheetExpanded(true);
          }}
          className="absolute z-30 rounded-lg p-2.5 shadow-md hover:opacity-90 transition-opacity flex items-center gap-1"
          style={{
            backgroundColor: panelOpen ? BRAND.teal : `${BRAND.cardBg}F2`,
            border: `1px solid ${panelOpen ? BRAND.teal : BRAND.border}`,
            top: '56px',
            right: '12px',
          }}
          aria-label={panelOpen ? "Cerrar capas" : "Capas"}
          title={panelOpen ? "Cerrar panel de capas" : "Abrir panel de capas"}
        >
          {panelOpen
            ? <X className="w-5 h-5" style={{ color: '#fff' }} />
            : <>
                <Layers className="w-5 h-5" style={{ color: BRAND.navy }} />
                <span className="text-[10px] font-semibold" style={{ color: BRAND.navy }}>Capas</span>
              </>
          }
        </button>
      )}

      {/* ═══ Walk Position HUD + Large Floor Indicator ═══ */}
      {walkMode && (
        <div className={`absolute z-30 flex items-end gap-2 ${
          isMobile ? "top-28 left-14" : "bottom-4 left-4"
        }`}>
          {/* Large floor indicator */}
          <div
            className="rounded-2xl px-4 py-3 shadow-lg flex flex-col items-center justify-center"
            style={{
              backgroundColor: currentFloor?.startsWith("S") ? "#1B2A4A" : currentFloor === "PB" ? BRAND.teal : "#2A3F6A",
              minWidth: isMobile ? "70px" : "80px",
              border: "2px solid rgba(255,255,255,0.3)",
            }}
          >
            <span className="text-white/60 text-[9px] font-semibold uppercase tracking-wider">Nivel</span>
            <span className="text-white font-bold" style={{ fontSize: isMobile ? "22px" : "28px", lineHeight: 1.1 }}>
              {currentFloor || "PB"}
            </span>
          </div>
          {/* Coordinates */}
          <div className="text-white rounded-lg px-2.5 py-1.5 font-mono text-[9px]" style={{ backgroundColor: `${BRAND.navy}B3` }}>
            <p>X:{walkPos.x} Y:{walkPos.y} Z:{walkPos.z}</p>
          </div>
        </div>
      )}

      {/* ═══ Axis Gizmo (always visible) ═══ */}
      <div
        className={`absolute z-30 pointer-events-none ${
          walkMode
            ? (isMobile ? "top-14 left-3" : "top-4 left-4")
            : (isMobile ? "bottom-20 left-3" : "bottom-4 left-4")
        }`}
        style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.25))" }}
      >
        <canvas
          ref={gizmoCanvasRef}
          width={isMobile ? 80 : 100}
          height={isMobile ? 80 : 100}
          className="pointer-events-auto cursor-pointer"
          onClick={(e) => {
            const canvas = gizmoCanvasRef.current;
            const cam = cameraRef.current;
            const controls = controlsRef.current;
            if (!canvas || !cam || !controls || walkMode) return;

            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const size = canvas.width;
            const half = size / 2;
            const axisLen = size * 0.32;

            const rotMatrix = new THREE.Matrix4();
            rotMatrix.extractRotation(cam.matrixWorldInverse);

            const axesDef = [
              { dir: new THREE.Vector3(1, 0, 0), label: "X" },
              { dir: new THREE.Vector3(0, 1, 0), label: "Y" },
              { dir: new THREE.Vector3(0, 0, 1), label: "Z" },
            ];

            // Find which axis tip was clicked (within 14px radius)
            let clicked: string | null = null;
            for (const axis of axesDef) {
              const v = axis.dir.clone().applyMatrix4(rotMatrix);
              const sx = half + v.x * axisLen;
              const sy = half - v.y * axisLen;
              const dist = Math.sqrt((cx - sx) ** 2 + (cy - sy) ** 2);
              if (dist < 14) { clicked = axis.label; break; }
            }
            if (!clicked) return;

            // Calculate target-relative camera position for axis-aligned view
            const target = controls.target.clone();
            const box = new THREE.Box3();
            Object.values(layersRef.current).forEach((layer) => {
              if (layer.group && layer.visible) box.expandByObject(layer.group);
            });
            const modelSize = box.isEmpty() ? new THREE.Vector3(10, 10, 10) : box.getSize(new THREE.Vector3());
            const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);
            const dist2 = maxDim * 0.9;

            let newPos: THREE.Vector3;
            switch (clicked) {
              case "X": // Right view (looking along -X)
                newPos = new THREE.Vector3(target.x + dist2, target.y, target.z);
                break;
              case "Y": // Top/plan view (looking down -Y)
                newPos = new THREE.Vector3(target.x, target.y + dist2, target.z + 0.01);
                break;
              case "Z": // Front view (looking along -Z)
                newPos = new THREE.Vector3(target.x, target.y, target.z + dist2);
                break;
              default: return;
            }

            // Smooth animation to new position
            const startPos = cam.position.clone();
            const startTime = performance.now();
            const duration = 500;
            const animateView = (now: number) => {
              const t = Math.min((now - startTime) / duration, 1);
              const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
              cam.position.lerpVectors(startPos, newPos, ease);
              cam.lookAt(target);
              controls.update();
              if (t < 1) requestAnimationFrame(animateView);
            };
            requestAnimationFrame(animateView);
          }}
        />
      </div>

      {/* ═══ Minimap (walk mode) — Architectural floor plan ═══ */}
      {walkMode && showMinimap && (
        <div
          className={`absolute z-30 ${isMobile ? "top-14 right-2" : "top-4 right-4"}`}
          style={{ filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.4))" }}
        >
          <div className="relative">
            <canvas
              ref={minimapCanvasRef}
              width={isMobile ? 160 : 220}
              height={isMobile ? 130 : 180}
              className="rounded-lg"
              onWheel={(e) => {
                e.preventDefault();
                minimapZoomRef.current = Math.max(0.5, Math.min(10, minimapZoomRef.current + e.deltaY * 0.005));
                drawMinimap();
              }}
            />
            {/* Floor label overlay */}
            <div
              className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider"
              style={{
                backgroundColor: currentFloor?.startsWith("S") ? "rgba(27, 42, 74, 0.9)" : "rgba(0, 168, 157, 0.9)",
                color: "#fff",
              }}
            >
              {currentFloor || "PB"}
            </div>
            {/* Zoom controls */}
            <div className="absolute bottom-1.5 right-1.5 flex gap-0.5">
              <button
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold"
                style={{ backgroundColor: "rgba(15, 23, 42, 0.7)", color: "#94A3B8" }}
                onClick={() => { minimapZoomRef.current = Math.max(0.5, minimapZoomRef.current - 0.5); drawMinimap(); }}
              >+</button>
              <button
                className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold"
                style={{ backgroundColor: "rgba(15, 23, 42, 0.7)", color: "#94A3B8" }}
                onClick={() => { minimapZoomRef.current = Math.min(10, minimapZoomRef.current + 0.5); drawMinimap(); }}
              >−</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Minimap toggle ═══ */}
      {walkMode && (
        <button
          onClick={() => setShowMinimap(!showMinimap)}
          className={`absolute z-30 rounded-xl p-2 shadow-md transition-colors ${
            isMobile ? "top-14 right-[170px]" : "top-[200px] right-4"
          }`}
          style={{
            backgroundColor: showMinimap ? BRAND.teal : `${BRAND.cardBg}F2`,
            color: showMinimap ? "#fff" : BRAND.navy,
            border: showMinimap ? "none" : `1px solid ${BRAND.border}`,
          }}
          aria-label={showMinimap ? "Ocultar mapa" : "Mostrar mapa"}
          title="Minimapa"
        >
          <MapIcon className="w-4 h-4" />
        </button>
      )}

      {/* ═══ Recenter Button (walk mode) ═══ */}
      {walkMode && (
        <button
          onClick={recenterCamera}
          className={`absolute z-30 rounded-xl p-2.5 shadow-md transition-colors hover:opacity-90 ${
            isMobile ? "top-28 left-3" : "bottom-4 left-[140px]"
          }`}
          style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
          aria-label="Recentrar vista"
          title="Recentrar"
        >
          <Crosshair className="w-5 h-5" style={{ color: BRAND.navy }} />
        </button>
      )}

      {/* ═══ Loading Bar ═══ */}
      {anyLoading && (
        <div className={`absolute top-14 z-20 ${isMobile ? 'left-2 right-2' : 'left-1/2 -translate-x-1/2 min-w-[300px] max-w-[380px]'}`}
          style={{ backgroundColor: BRAND.cardBg, border: `1px solid ${BRAND.border}`, backdropFilter: 'blur(12px)', borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3.5 pt-2.5 pb-1.5">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: BRAND.teal }} />
              <span className="text-[11px] font-semibold" style={{ color: BRAND.textPrimary }}>
                Cargando modelo
              </span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color: BRAND.teal, backgroundColor: `${BRAND.teal}15` }}>
              {loadedCount}/{layerCount} · {overallProgress}%
            </span>
          </div>

          {/* Overall progress bar */}
          <div className="mx-3.5 mb-2 h-1 rounded-full overflow-hidden" style={{ backgroundColor: `${BRAND.teal}20` }}>
            <div className="h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${overallProgress}%`, backgroundColor: BRAND.teal }} />
          </div>

          {/* Individual specialty rows */}
          <div className="px-3.5 pb-2.5 flex flex-col gap-1" style={{ maxHeight: isMobile ? '35vh' : '45vh', overflowY: 'auto' }}>
            {files.map((f) => {
              const layer = layers[f.specialty];
              if (!layer) return null;
              const isLoading = layer.loading;
              const isLoaded = layer.loaded && !layer.loading;
              const isWaiting = !layer.loaded && !layer.loading;
              const pct = isLoaded ? 100 : layer.progress;
              // Format ETA
              const formatEta = (sec?: number) => {
                if (sec === undefined || sec <= 0) return '';
                if (sec < 60) return `${sec}s`;
                const m = Math.floor(sec / 60);
                const s = sec % 60;
                return `${m}m${s > 0 ? ` ${s}s` : ''}`;
              };
              const formatSpeed = (bps?: number) => {
                if (!bps || bps <= 0) return '';
                if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
                return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
              };
              const etaStr = isLoading ? formatEta(layer.etaSeconds) : '';
              const speedStr = isLoading ? formatSpeed(layer.speedBps) : '';
              return (
                <div key={f.specialty} className="flex flex-col gap-0.5 py-0.5" style={{ opacity: isWaiting ? 0.45 : 1 }}>
                  <div className="flex items-center gap-2">
                    {/* Color dot */}
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                    {/* Label */}
                    <span className="text-[10px] font-medium truncate flex-1 min-w-0" style={{ color: isLoaded ? BRAND.textSecondary : BRAND.textPrimary }}>
                      {f.label || f.specialty}
                    </span>
                    {/* Status icon + size */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {f.fileSize ? (
                        <span className="text-[9px] font-mono" style={{ color: BRAND.textMuted }}>
                          {formatSize(f.fileSize)}
                        </span>
                      ) : null}
                      {isLoaded && <CheckCircle2 className="w-3 h-3" style={{ color: '#22c55e' }} />}
                      {isLoading && <Loader2 className="w-3 h-3 animate-spin" style={{ color: f.color }} />}
                      {isWaiting && <Clock className="w-3 h-3" style={{ color: BRAND.textMuted }} />}
                    </div>
                  </div>
                  {/* Progress bar + ETA row */}
                  {isLoading && (
                    <div className="flex items-center gap-1.5 pl-[18px]">
                      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ backgroundColor: `${f.color}20` }}>
                        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: f.color }} />
                      </div>
                      <span className="text-[8px] font-mono shrink-0 tabular-nums" style={{ color: BRAND.textMuted, minWidth: 28 }}>
                        {pct}%
                      </span>
                      {(speedStr || etaStr) && (
                        <span className="text-[8px] font-mono shrink-0" style={{ color: BRAND.teal }}>
                          {speedStr}{etaStr ? ` · ${etaStr}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                  {/* Cache indicator */}
                  {isLoaded && layer.fromCache && (
                    <span className="text-[8px] pl-[18px]" style={{ color: '#22c55e' }}>Desde caché</span>
                  )}
                  {/* Gzip compression indicator */}
                  {isLoading && (f as any).gzFileKey && (
                    <span className="text-[8px] pl-[18px]" style={{ color: BRAND.teal }}>Descarga comprimida (gzip)</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ Zoom Buttons ═══ */}
      <div className={`absolute z-30 flex flex-col gap-1.5 ${
        isMobile && walkMode
          ? "bottom-44 right-16"
          : isMobile
            ? "bottom-6 right-3"
            : "bottom-4 right-4"
      }`}>
        <button
          onClick={() => handleZoom("in")}
          className="w-11 h-11 lg:w-10 lg:h-10 rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform hover:opacity-90"
          style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
          aria-label="Acercar"
        >
          <ZoomIn className="w-5 h-5" style={{ color: BRAND.navy }} />
        </button>
        <button
          onClick={() => handleZoom("out")}
          className="w-11 h-11 lg:w-10 lg:h-10 rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform hover:opacity-90"
          style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
          aria-label="Alejar"
        >
          <ZoomOut className="w-5 h-5" style={{ color: BRAND.navy }} />
        </button>
        {!walkMode && (
          <>
            <button
              onClick={fitAll}
              className="w-11 h-11 lg:w-10 lg:h-10 rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform hover:opacity-90"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="Ajustar vista"
              title="Ajustar vista completa"
            >
              <Maximize className="w-5 h-5" style={{ color: BRAND.navy }} />
            </button>
            <button
              onClick={() => {
                // Recentrar target al centro del modelo
                const controls = controlsRef.current;
                const box = new THREE.Box3();
                Object.values(layersRef.current).forEach((layer) => {
                  if (layer.group && layer.visible) box.expandByObject(layer.group);
                });
                if (!box.isEmpty() && controls) {
                  const center = box.getCenter(new THREE.Vector3());
                  const startTarget = controls.target.clone();
                  const startTime = performance.now();
                  const duration = 400;
                  const animateTarget = () => {
                    const elapsed = performance.now() - startTime;
                    const t = Math.min(elapsed / duration, 1);
                    const ease = 1 - Math.pow(1 - t, 3);
                    controls.target.lerpVectors(startTarget, center, ease);
                    controls.update();
                    if (t < 1) requestAnimationFrame(animateTarget);
                  };
                  animateTarget();
                }
              }}
              className="w-11 h-11 lg:w-10 lg:h-10 rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform hover:opacity-90"
              style={{ backgroundColor: `${BRAND.cardBg}F2`, border: `1px solid ${BRAND.border}` }}
              aria-label="Recentrar giro"
              title="Recentrar punto de giro"
            >
              <Crosshair className="w-5 h-5" style={{ color: BRAND.teal }} />
            </button>
          </>
        )}
      </div>

      {/* ═══ Footer Cut Line Bar ═══ */}
      {(clippingEnabled || (floorIsolation && isolatedFloorIdx !== null)) && (
        <div
          className={`absolute z-30 left-0 right-0 flex items-center gap-2 px-3 ${
            isMobile
              ? "bottom-0 pb-[env(safe-area-inset-bottom,4px)] pt-2"
              : "bottom-0 py-2"
          }`}
          style={{
            backgroundColor: `${BRAND.cardBg}F0`,
            borderTop: `1px solid ${BRAND.border}`,
            backdropFilter: "blur(8px)",
          }}
        >
          {/* Floor isolation indicator or axis label */}
          {floorIsolation && isolatedFloorIdx !== null ? (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#F59E0B" }} />
              <span className="text-[10px] font-bold" style={{ color: "#F59E0B" }}>
                {FLOOR_LEVELS[isolatedFloorIdx].label}
              </span>
              <span className="text-[9px] opacity-60" style={{ color: BRAND.textMuted }}>
                {(() => {
                  const visCount = files.filter((f: any) => layers[f.specialty]?.visible && layers[f.specialty]?.loaded).length;
                  const totalCount = files.filter((f: any) => layers[f.specialty]?.loaded).length;
                  return visCount === totalCount ? `${totalCount} disc.` : `${visCount}/${totalCount} disc.`;
                })()}
              </span>
            </div>
          ) : (
            <span
              className="text-[10px] font-bold uppercase flex-shrink-0 w-5 text-center"
              style={{ color: clippingAxis === "x" ? "#EF4444" : clippingAxis === "y" ? "#22C55E" : "#3B82F6" }}
            >
              {clippingAxis.toUpperCase()}
            </span>
          )}

          {/* Double arrow + height indicator */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <svg width="16" height="24" viewBox="0 0 16 24" fill="none" className="flex-shrink-0">
              <path d="M8 2L4 6H12L8 2Z" fill={BRAND.teal} />
              <path d="M8 22L4 18H12L8 22Z" fill={BRAND.teal} />
              <line x1="8" y1="6" x2="8" y2="18" stroke={BRAND.teal} strokeWidth="1.5" />
            </svg>
            <span
              className="text-xs font-mono font-semibold tabular-nums min-w-[4rem] text-center"
              style={{ color: BRAND.navy }}
            >
              {clippingHeight.toFixed(2)} m
            </span>
          </div>

          {/* Interactive slider (the cut line) */}
          <div className="flex-1 relative flex items-center">
            {/* Track line */}
            <div
              className="absolute left-0 right-0 h-[2px] rounded-full"
              style={{ backgroundColor: clippingAxis === "x" ? "#EF444440" : clippingAxis === "y" ? "#22C55E40" : "#3B82F640" }}
            />
            {/* Filled portion */}
            <div
              className="absolute left-0 h-[2px] rounded-full"
              style={{
                width: `${((clippingHeight - modelBounds.min) / (modelBounds.max - modelBounds.min)) * 100}%`,
                backgroundColor: clippingAxis === "x" ? "#EF4444" : clippingAxis === "y" ? "#22C55E" : "#3B82F6",
              }}
            />
            <input
              type="range"
              min={modelBounds.min}
              max={modelBounds.max}
              step={0.01}
              value={clippingHeight}
              onChange={(e) => setClippingHeight(parseFloat(e.target.value))}
              className="w-full relative z-10 appearance-none bg-transparent cursor-pointer"
              style={{
                height: "24px",
                // Custom thumb styling via CSS
              }}
            />
          </div>

          {/* Min/Max labels */}
          <div className="flex flex-col items-center flex-shrink-0 text-[8px] leading-tight" style={{ color: BRAND.textMuted }}>
            <span>{modelBounds.max.toFixed(0)}</span>
            <span>{modelBounds.min.toFixed(0)}</span>
          </div>
        </div>
      )}

      {/* ═══ Screenshot Button ═══ */}
      <button
        onClick={takeScreenshot}
        className={`absolute z-30 rounded-xl p-2.5 shadow-md transition-all hover:opacity-90 active:scale-95 ${
          clippingEnabled
            ? (isMobile ? "bottom-16 left-3" : "bottom-12 left-4")
            : (isMobile ? "bottom-6 left-3" : "bottom-4 left-4")
        } ${screenshotting ? "ring-2" : ""}`}
        style={{
          backgroundColor: screenshotting ? BRAND.teal : `${BRAND.cardBg}F2`,
          border: screenshotting ? "none" : `1px solid ${BRAND.border}`,
          color: screenshotting ? "#fff" : BRAND.navy,
          ...(screenshotting ? { "--tw-ring-color": BRAND.teal } as any : {}),
        }}
        aria-label="Captura de pantalla"
        title="Captura de pantalla"
      >
        <Camera className="w-5 h-5" />
      </button>

      {/* ═══ Share Button ═══ */}
      <button
        onClick={generateShareUrl}
        className={`absolute z-30 rounded-xl p-2.5 shadow-md transition-all hover:opacity-90 active:scale-95 ${
          clippingEnabled
            ? (isMobile ? "bottom-16 left-16" : "bottom-12 left-16")
            : (isMobile ? "bottom-6 left-16" : "bottom-4 left-16")
        }`}
        style={{
          backgroundColor: `${BRAND.cardBg}F2`,
          border: `1px solid ${BRAND.border}`,
          color: BRAND.navy,
        }}
        aria-label="Compartir vista"
        title="Compartir vista"
      >
        <Share2 className="w-5 h-5" />
      </button>

      {/* ═══ Share Dialog ═══ */}
      {showShareDialog && shareUrl && (
        <>
          <div className="absolute inset-0 z-50 bg-black/30" onClick={() => setShowShareDialog(false)} />
          <div
            className="absolute z-50 rounded-xl shadow-2xl p-4 w-80 max-w-[90vw]"
            style={{
              backgroundColor: BRAND.cardBg,
              border: `1px solid ${BRAND.border}`,
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: BRAND.navy }}>
                <Link2 className="w-4 h-4" style={{ color: BRAND.teal }} />
                Compartir Vista
              </h3>
              <button onClick={() => setShowShareDialog(false)} className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4" style={{ color: BRAND.textMuted }} />
              </button>
            </div>
            <p className="text-[11px] mb-3" style={{ color: BRAND.textMuted }}>
              Comparte este enlace para que otros vean exactamente esta vista del modelo.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={shareUrl}
                readOnly
                className="flex-1 px-3 py-2 text-[11px] rounded-lg font-mono truncate focus:outline-none"
                style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}`, color: BRAND.textPrimary }}
              />
              <button
                onClick={() => { copyShareUrl(); setShowShareDialog(false); }}
                className="px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors hover:opacity-90"
                style={{ backgroundColor: BRAND.teal, color: "#fff" }}
              >
                <Copy className="w-3.5 h-3.5" />
                Copiar
              </button>
            </div>
          </div>
        </>
      )}

      {/* ═══ Annotation mode indicator ═══ */}
      {annotationMode && !panelOpen && (
        <div
          className={`absolute z-30 rounded-lg px-3 py-2 shadow-md ${
            isMobile ? "bottom-20 left-3" : "bottom-4 left-28"
          }`}
          style={{ backgroundColor: `${BRAND.teal}E6`, color: "#fff" }}
        >
          <div className="flex items-center gap-2">
            <Pin className="w-4 h-4" />
            <span className="text-xs font-medium">Toca para anotar</span>
            <button onClick={() => setAnnotationMode(false)} className="ml-1 bg-white/20 rounded p-0.5 hover:bg-white/30">
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* ═══ Floating Action Buttons: Inspect + Measure (always accessible) ═══ */}
      {!walkMode && !arActive && (
        <div className={`absolute z-30 flex flex-col gap-2 ${
          isMobile ? "bottom-5 right-3" : "bottom-4 right-4"
        }`}
        style={{ right: panelOpen && !isMobile ? '332px' : undefined }}
        >
          {/* Inspection paint mode button */}
          <button
            onClick={() => {
              setInspectionMode(!inspectionMode);
              if (!inspectionMode) { setMeasureMode(false); setAnnotationMode(false); }
            }}
            className={`rounded-2xl shadow-lg flex items-center gap-2 transition-all active:scale-95 ${
              isMobile ? "px-3 py-2.5" : "px-4 py-3"
            }`}
            style={{
              backgroundColor: inspectionMode ? BRAND.teal : BRAND.cardBg,
              color: inspectionMode ? "#fff" : BRAND.navy,
              border: `2px solid ${inspectionMode ? BRAND.teal : BRAND.border}`,
              boxShadow: inspectionMode ? `0 0 16px ${BRAND.teal}60` : "0 2px 12px rgba(0,0,0,0.15)",
            }}
            title="Modo Avance: toca elementos para marcarlos como inspeccionados (verde)"
          >
            <Stamp className={isMobile ? "w-5 h-5" : "w-5 h-5"} />
            <span className={`font-semibold ${isMobile ? "text-xs" : "text-sm"}`}>Avance</span>
          </button>
          {/* Measure button */}
          <button
            onClick={() => {
              if (measureMode) { clearMeasurement(); setMeasureMode(false); }
              else { setMeasureMode(true); setInspectionMode(false); setAnnotationMode(false); }
            }}
            className={`rounded-2xl shadow-lg flex items-center gap-2 transition-all active:scale-95 ${
              isMobile ? "px-3 py-2.5" : "px-4 py-3"
            }`}
            style={{
              backgroundColor: measureMode ? BRAND.teal : BRAND.cardBg,
              color: measureMode ? "#fff" : BRAND.navy,
              border: `2px solid ${measureMode ? BRAND.teal : BRAND.border}`,
              boxShadow: measureMode ? `0 0 16px ${BRAND.teal}60` : "0 2px 12px rgba(0,0,0,0.15)",
            }}
            title="Medir distancias entre dos puntos del modelo"
          >
            <Ruler className={isMobile ? "w-5 h-5" : "w-5 h-5"} />
            <span className={`font-semibold ${isMobile ? "text-xs" : "text-sm"}`}>Medir</span>
          </button>
          {/* Upload files button */}
          <button
            onClick={() => { setShowAddFileDialog(true); setAddFileSuccess([]); }}
            className={`rounded-2xl shadow-lg flex items-center gap-2 transition-all active:scale-95 ${
              isMobile ? "px-3 py-2.5" : "px-4 py-3"
            }`}
            style={{
              backgroundColor: BRAND.cardBg,
              color: BRAND.navy,
              border: `2px solid ${BRAND.border}`,
              boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
            }}
            title="Subir archivos GLB/IFC/RVT por especialidad"
          >
            <FileUp className={isMobile ? "w-5 h-5" : "w-5 h-5"} />
            <span className={`font-semibold ${isMobile ? "text-xs" : "text-sm"}`}>Subir</span>
          </button>
        </div>
      )}

      {/* ═══ Inspection mode indicator ═══ */}
      {inspectionMode && (
        <div
          className={`absolute z-30 rounded-xl px-4 py-2.5 shadow-lg ${
            isMobile ? "bottom-28 left-3 right-16" : "bottom-4 left-28"
          }`}
          style={{ backgroundColor: `${BRAND.teal}F0`, color: "#fff" }}
        >
          <div className="flex items-center gap-2">
            <Stamp className="w-4 h-4" />
            <span className="text-xs font-semibold">Modo Avance: toca elementos para marcar como inspeccionados</span>
            <span className="text-[10px] bg-white/20 rounded px-1.5 py-0.5 font-mono">{paintedMeshesRef.current.size}</span>
          </div>
        </div>
      )}

      {/* ═══ Measurement indicator (when active) ═══ */}
      {/* ═══ Measurement HUD - Guided Flow ═══ */}
      {measureMode && (
        <div className={`absolute z-40 ${isMobile ? "bottom-28 left-3 right-3" : "bottom-6 left-1/2 -translate-x-1/2"}`}>
          <div
            className={`rounded-2xl shadow-2xl overflow-hidden ${isMobile ? "" : "min-w-[380px] max-w-[440px]"}`}
            style={{
              backgroundColor: "rgba(27,42,74,0.96)",
              backdropFilter: "blur(16px)",
              border: `2px solid ${BRAND.teal}60`,
              boxShadow: `0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,168,157,0.15)`,
            }}
          >
            {/* Header bar with mode toggle */}
            <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: `1px solid rgba(255,255,255,0.1)` }}>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${BRAND.teal}30` }}>
                  <Ruler className="w-4 h-4" style={{ color: BRAND.teal }} />
                </div>
                <div>
                  <span className="text-white text-sm font-bold">Medir</span>
                  <span className="text-[10px] ml-2 px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: measureAreaMode ? '#4fc3f720' : `${BRAND.teal}25`, color: measureAreaMode ? '#4fc3f7' : BRAND.tealLight }}>
                    {measureAreaMode ? "Área" : measureChainMode ? "Cadena" : "Punto a punto"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {/* Mode toggle pills */}
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(false); setMeasureAreaMode(false); }}
                  className="px-2 py-1 text-[10px] rounded-full font-semibold transition-all"
                  style={{
                    backgroundColor: !measureChainMode && !measureAreaMode ? BRAND.teal : "rgba(255,255,255,0.08)",
                    color: !measureChainMode && !measureAreaMode ? "#fff" : "rgba(255,255,255,0.5)",
                  }}
                >
                  A→B
                </button>
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(true); setMeasureAreaMode(false); }}
                  className="px-2 py-1 text-[10px] rounded-full font-semibold transition-all"
                  style={{
                    backgroundColor: measureChainMode ? BRAND.teal : "rgba(255,255,255,0.08)",
                    color: measureChainMode ? "#fff" : "rgba(255,255,255,0.5)",
                  }}
                >
                  A→B→C
                </button>
                <button
                  onClick={() => { clearMeasurement(); setMeasureChainMode(false); setMeasureAreaMode(true); }}
                  className="px-2 py-1 text-[10px] rounded-full font-semibold transition-all flex items-center gap-1"
                  style={{
                    backgroundColor: measureAreaMode ? '#4fc3f7' : "rgba(255,255,255,0.08)",
                    color: measureAreaMode ? "#fff" : "rgba(255,255,255,0.5)",
                  }}
                >
                  <Pentagon className="w-3 h-3" /> Área
                </button>
                {/* Close */}
                <button
                  onClick={() => { clearMeasurement(); setMeasureMode(false); setMeasureChainMode(false); setMeasureAreaMode(false); }}
                  className="ml-1 w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4 text-white/50" />
                </button>
              </div>
            </div>

            {/* ─── STEP INDICATOR (Point-to-point mode) ─── */}
            {!measureChainMode && !measureAreaMode && measureDistance === null && (
              <div className="px-4 py-4">
                <div className="flex items-center gap-3">
                  {/* Step 1 */}
                  <div className="flex items-center gap-2 flex-1">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
                        measurePoints.length === 0 ? "animate-pulse" : ""
                      }`}
                      style={{
                        backgroundColor: measurePoints.length >= 1 ? BRAND.teal : `${BRAND.teal}30`,
                        color: measurePoints.length >= 1 ? "#fff" : BRAND.tealLight,
                        boxShadow: measurePoints.length === 0 ? `0 0 12px ${BRAND.teal}60` : "none",
                      }}
                    >
                      {measurePoints.length >= 1 ? <Check className="w-4 h-4" /> : "1"}
                    </div>
                    <div className="flex-1">
                      <p className="text-white text-xs font-semibold">{measurePoints.length >= 1 ? "Punto A marcado" : "Toca el punto A"}</p>
                      <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.45)" }}>
                        {measurePoints.length >= 1 ? "Primer punto fijado" : "Toca en el modelo 3D"}
                      </p>
                    </div>
                  </div>

                  {/* Arrow */}
                  <CornerDownRight className="w-4 h-4 flex-shrink-0" style={{ color: "rgba(255,255,255,0.2)" }} />

                  {/* Step 2 */}
                  <div className="flex items-center gap-2 flex-1">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm transition-all ${
                        measurePoints.length === 1 ? "animate-pulse" : ""
                      }`}
                      style={{
                        backgroundColor: measurePoints.length >= 2 ? BRAND.teal : measurePoints.length === 1 ? `${BRAND.teal}30` : "rgba(255,255,255,0.06)",
                        color: measurePoints.length >= 2 ? "#fff" : measurePoints.length === 1 ? BRAND.tealLight : "rgba(255,255,255,0.2)",
                        boxShadow: measurePoints.length === 1 ? `0 0 12px ${BRAND.teal}60` : "none",
                      }}
                    >
                      {measurePoints.length >= 2 ? <Check className="w-4 h-4" /> : "2"}
                    </div>
                    <div className="flex-1">
                      <p className={`text-xs font-semibold ${measurePoints.length >= 1 ? "text-white" : "text-white/30"}`}>
                        {measurePoints.length >= 2 ? "Punto B marcado" : "Toca el punto B"}
                      </p>
                      <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.3)" }}>
                        {measurePoints.length >= 1 ? "Toca en el modelo 3D" : "Después del punto A"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Snap hint */}
                <div className="mt-3 flex items-center gap-1.5 px-2 py-1.5 rounded-lg" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
                  <Target className="w-3 h-3 flex-shrink-0" style={{ color: BRAND.tealLight }} />
                  <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                    Se ajusta automáticamente a aristas cercanas (snap)
                  </span>
                </div>
              </div>
            )}

            {/* ─── RESULT (Point-to-point mode) ─── */}
            {!measureChainMode && !measureAreaMode && measureDistance !== null && (
              <div className="px-4 py-4">
                <div className="text-center">
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: BRAND.tealLight }}>Distancia</p>
                  <p className="text-3xl font-black font-mono text-white tracking-tight">
                    {measureDistance >= 1.0 ? measureDistance.toFixed(3) : (measureDistance * 100).toFixed(1)}
                    <span className="text-lg font-semibold ml-1" style={{ color: BRAND.tealLight }}>
                      {measureDistance >= 1.0 ? "m" : "cm"}
                    </span>
                  </p>
                  {measurePoints.length === 2 && (
                    <div className="mt-2 flex items-center justify-center gap-3 text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.45)" }}>
                      <span>ΔX: {Math.abs(measurePoints[1].x - measurePoints[0].x).toFixed(2)}m</span>
                      <span>ΔY: {Math.abs(measurePoints[1].y - measurePoints[0].y).toFixed(2)}m</span>
                      <span>ΔZ: {Math.abs(measurePoints[1].z - measurePoints[0].z).toFixed(2)}m</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={saveMeasurement}
                    className="flex-1 px-3 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: BRAND.teal, color: "#fff" }}
                  >
                    <Download className="w-3.5 h-3.5" /> Guardar
                  </button>
                  <button
                    onClick={clearMeasurement}
                    className="flex-1 px-3 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Nueva medición
                  </button>
                </div>
              </div>
            )}

            {/* ─── CHAIN MODE GUIDE ─── */}
            {measureChainMode && measureChainPoints.length < 2 && (
              <div className="px-4 py-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center animate-pulse"
                    style={{ backgroundColor: `${BRAND.teal}30`, color: BRAND.tealLight, boxShadow: `0 0 12px ${BRAND.teal}60` }}
                  >
                    <MousePointerClick className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-white text-xs font-semibold">
                      {measureChainPoints.length === 0 ? "Toca el primer punto" : "Toca el siguiente punto"}
                    </p>
                    <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.45)" }}>
                      Sigue tocando puntos para medir segmentos consecutivos
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1.5 px-2 py-1.5 rounded-lg" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
                  <GitBranch className="w-3 h-3 flex-shrink-0" style={{ color: BRAND.tealLight }} />
                  <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                    Cada segmento muestra su distancia. El total se acumula.
                  </span>
                </div>
              </div>
            )}

            {/* ─── CHAIN MODE RESULT ─── */}
            {measureChainMode && measureChainPoints.length >= 2 && (
              <div className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-3.5 h-3.5" style={{ color: BRAND.tealLight }} />
                    <span className="text-[10px] font-semibold" style={{ color: "rgba(255,255,255,0.6)" }}>
                      {measureChainDistances.length} segmento{measureChainDistances.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.35)" }}>
                    Toca para agregar más puntos
                  </span>
                </div>
                {/* Segments list (compact, max 3 visible) */}
                <div className={`space-y-1 ${measureChainDistances.length > 3 ? "max-h-[72px] overflow-y-auto" : ""}`}>
                  {measureChainDistances.map((d, i) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1 rounded-lg text-[10px]" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
                      <span style={{ color: "rgba(255,255,255,0.5)" }}>Seg. {i + 1}</span>
                      <span className="font-mono font-bold text-white">
                        {d >= 1.0 ? `${d.toFixed(3)} m` : `${(d * 100).toFixed(1)} cm`}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Total */}
                <div className="mt-2 pt-2 flex items-center justify-between" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                  <span className="text-xs font-bold text-white">Total</span>
                  <span className="text-xl font-black font-mono" style={{ color: BRAND.tealLight }}>
                    {(() => { const t = measureChainDistances.reduce((a, b) => a + b, 0); return t >= 1.0 ? `${t.toFixed(3)} m` : `${(t * 100).toFixed(1)} cm`; })()}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={saveMeasurement}
                    className="flex-1 px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: BRAND.teal, color: "#fff" }}
                  >
                    <Download className="w-3 h-3" /> Guardar
                  </button>
                  <button
                    onClick={clearMeasurement}
                    className="flex-1 px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    <RotateCcw className="w-3 h-3" /> Limpiar
                  </button>
                </div>
              </div>
            )}

            {/* ─── AREA MODE GUIDE ─── */}
            {measureAreaMode && measureAreaPoints.length < 3 && (
              <div className="px-4 py-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center animate-pulse"
                    style={{ backgroundColor: '#4fc3f730', color: '#4fc3f7', boxShadow: '0 0 12px #4fc3f760' }}
                  >
                    <Pentagon className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-white text-xs font-semibold">
                      {measureAreaPoints.length === 0 ? "Toca el primer v\u00e9rtice" : measureAreaPoints.length === 1 ? "Toca el segundo v\u00e9rtice" : "Toca el tercer v\u00e9rtice"}
                    </p>
                    <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.45)" }}>
                      M\u00ednimo 3 puntos para calcular \u00e1rea. {measureAreaPoints.length}/3 marcados.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1.5 px-2 py-1.5 rounded-lg" style={{ backgroundColor: "rgba(255,255,255,0.05)" }}>
                  <Pentagon className="w-3 h-3 flex-shrink-0" style={{ color: '#4fc3f7' }} />
                  <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                    Marca los v\u00e9rtices del pol\u00edgono. Se calcula el \u00e1rea autom\u00e1ticamente.
                  </span>
                </div>
              </div>
            )}

            {/* ─── AREA MODE RESULT ─── */}
            {measureAreaMode && measureAreaPoints.length >= 3 && (
              <div className="px-4 py-3">
                <div className="text-center mb-3">
                  <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: '#4fc3f7' }}>\u00c1rea</p>
                  <p className="text-3xl font-black font-mono text-white tracking-tight">
                    {measureAreaResult ? (
                      measureAreaResult.area >= 1.0
                        ? measureAreaResult.area.toFixed(2)
                        : (measureAreaResult.area * 10000).toFixed(0)
                    ) : '...'}
                    <span className="text-lg font-semibold ml-1" style={{ color: '#4fc3f7' }}>
                      {measureAreaResult && measureAreaResult.area >= 1.0 ? 'm\u00b2' : 'cm\u00b2'}
                    </span>
                  </p>
                  {measureAreaResult && (
                    <div className="mt-1 flex items-center justify-center gap-3 text-[10px] font-mono" style={{ color: "rgba(255,255,255,0.45)" }}>
                      <span>Per\u00edmetro: {measureAreaResult.perimeter >= 1.0 ? `${measureAreaResult.perimeter.toFixed(2)} m` : `${(measureAreaResult.perimeter * 100).toFixed(0)} cm`}</span>
                      <span>{measureAreaPoints.length} v\u00e9rtices</span>
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-center mb-2" style={{ color: "rgba(255,255,255,0.35)" }}>
                  Toca m\u00e1s puntos para refinar el pol\u00edgono
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={saveMeasurement}
                    className="flex-1 px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: '#4fc3f7', color: "#fff" }}
                  >
                    <Download className="w-3 h-3" /> Guardar
                  </button>
                  <button
                    onClick={clearMeasurement}
                    className="flex-1 px-3 py-2 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)", color: "#fff" }}
                  >
                    <RotateCcw className="w-3 h-3" /> Limpiar
                  </button>
                </div>
              </div>
            )}

            {/* History count badge */}
            {measureHistory.length > 0 && (
              <div className="px-4 py-2 flex items-center justify-between" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.4)" }}>
                  {measureHistory.length} medición{measureHistory.length !== 1 ? "es" : ""} guardada{measureHistory.length !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={exportMeasurements}
                  className="text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors hover:bg-white/10"
                  style={{ color: BRAND.tealLight }}
                >
                  Exportar CSV
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floor picker is now integrated in the walk mode header badge */}

      {/* ═══ Gyroscope Toggle (walk mode) ═══ */}
      {walkMode && (
        <button
          onClick={toggleGyro}
          className={`absolute z-40 rounded-2xl shadow-lg transition-all active:scale-95 flex items-center gap-2 ${
            isMobile ? "top-[4.5rem] right-3 px-3 py-2.5" : "top-16 right-4 px-3 py-2"
          } ${
            gyroEnabled ? "animate-pulse" : ""
          }`}
          style={{
            backgroundColor: gyroEnabled ? BRAND.teal : `${BRAND.cardBg}`,
            color: gyroEnabled ? "#fff" : BRAND.navy,
            border: gyroEnabled ? `2px solid ${BRAND.tealLight || BRAND.teal}` : `2px solid ${BRAND.border}`,
            boxShadow: gyroEnabled ? `0 0 12px ${BRAND.teal}80` : "0 2px 8px rgba(0,0,0,0.15)",
          }}
          aria-label={gyroEnabled ? "Desactivar giroscopio" : "Activar giroscopio"}
          title="Giroscopio"
        >
          <Smartphone className={`${isMobile ? "w-5 h-5" : "w-4 h-4"}`} />
          <span className={`font-semibold ${isMobile ? "text-xs" : "text-[11px]"}`}>
            {gyroEnabled ? "Gyro ON" : "Gyro"}
          </span>
        </button>
      )}

      {/* ═══ Up/Down buttons (walk mode, mobile) ═══ */}
      {walkMode && isMobile && (
        <div className="absolute bottom-44 right-3 z-30 flex flex-col gap-1.5">
          <button
            onTouchStart={() => keysRef.current.add("q")}
            onTouchEnd={() => keysRef.current.delete("q")}
            className="w-11 h-11 text-white rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform"
            style={{ backgroundColor: `${BRAND.teal}CC` }}
            aria-label="Subir"
          >
            <ChevronUp className="w-5 h-5" />
          </button>
          <button
            onTouchStart={() => keysRef.current.add("e")}
            onTouchEnd={() => keysRef.current.delete("e")}
            className="w-11 h-11 text-white rounded-xl shadow-md flex items-center justify-center active:scale-95 transition-transform"
            style={{ backgroundColor: `${BRAND.teal}CC` }}
            aria-label="Bajar"
          >
            <ChevronDown className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* ═══ Mobile Joystick (walk mode only) ═══ */}
      {walkMode && isMobile && (
        <div
          ref={joystickContainerRef}
          className="absolute bottom-8 left-6 z-30 w-[140px] h-[140px]"
          style={{ touchAction: "none" }}
        />
      )}

      {/* ═══ Desktop Side Panel ═══ */}
      {!isMobile && panelOpen && (
        <div className="w-80 flex flex-col overflow-hidden z-20" style={{ backgroundColor: BRAND.cardBg, borderLeft: `1px solid ${BRAND.border}` }}>
          {renderTabBar()}
          <div className="flex-1 overflow-y-auto">
            {renderTabContent()}
          </div>
        </div>
      )}

      {/* ═══ Mobile Bottom Sheet ═══ */}
      {isMobile && panelOpen && (
        <>
          <div
            className="absolute inset-0 z-30 bg-black/20"
            onClick={() => {
              setPanelOpen(false);
              setBottomSheetExpanded(false);
            }}
          />
          <div
            className={`absolute left-0 right-0 bottom-0 z-40 rounded-t-2xl shadow-2xl transition-all duration-300 ease-out ${
              bottomSheetExpanded ? "max-h-[75dvh]" : "max-h-[45dvh]"
            } flex flex-col`}
            style={{ backgroundColor: BRAND.cardBg }}
          >
            <div className="flex justify-center py-2 shrink-0">
              <button
                onClick={() => setBottomSheetExpanded(!bottomSheetExpanded)}
                className="w-10 h-1.5 rounded-full"
                style={{ backgroundColor: BRAND.border }}
              />
            </div>
            {renderTabBar()}
            <div className="flex-1 overflow-y-auto">
              {renderTabContent()}
            </div>
          </div>
        </>
      )}
      {/* ═══ AR Overlay ═══ */}
      <div
        id="ar-overlay"
        className={arActive ? "absolute inset-0 z-[60] pointer-events-auto" : "hidden"}
        onTouchStart={(e) => {
          if (e.touches.length === 2 && arModelPlaced.current) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            arPinchStartRef.current = Math.hypot(dx, dy);
            arPinchScaleRef.current = arScaleRef.current;
          }
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 2 && arPinchStartRef.current !== null && arModelPlaced.current) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy);
            const ratio = dist / arPinchStartRef.current;
            arScaleRef.current = arPinchScaleRef.current * ratio;
            if (arModelGroup.current) arModelGroup.current.scale.setScalar(arScaleRef.current);
          }
        }}
        onTouchEnd={() => { arPinchStartRef.current = null; }}
      >
        {arActive && (
          <>
            {/* AR Header - Immersive mode */}
            <div className="absolute top-4 left-0 right-0 z-10 flex justify-center px-4">
              <div className="bg-black/70 backdrop-blur-md text-white rounded-2xl px-5 py-3 max-w-sm w-full">
                <div className="flex items-center gap-3 mb-2">
                  <Scan className="w-5 h-5 flex-shrink-0" style={{ color: BRAND.tealLight }} />
                  <span className="text-sm font-semibold">
                    AR — {FLOOR_LEVELS.find(f => f.short === arCurrentFloor)?.label || arCurrentFloor}
                  </span>
                  <button
                    onClick={exitARMode}
                    className="ml-auto bg-red-500/80 hover:bg-red-500 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                  >
                    Salir
                  </button>
                </div>
                <p className="text-xs text-white/70 leading-relaxed">
                  {arStep === "scanning"
                    ? "Apunta la cámara al piso y mueve el teléfono lentamente para detectar la superficie."
                    : arStep === "placed"
                    ? "Modelo anclado al piso real a escala 1:1. Camina alrededor para verificarlo."
                    : "Camina físicamente para recorrer. Toca un piso para teletransportarte."}
                </p>
              </div>
            </div>

            {/* AR Scanning / placement panel (Gamma-AR-style tap-to-place) */}
            {arStep === "scanning" && (
              <div className="absolute bottom-8 left-0 right-0 z-10 flex flex-col items-center gap-3 px-4">
                <div className="bg-black/70 backdrop-blur-md text-white rounded-2xl px-5 py-4 max-w-sm w-full text-center">
                  <div className="flex justify-center mb-2">
                    <span className="w-12 h-12 rounded-full border-2 border-dashed flex items-center justify-center animate-pulse" style={{ borderColor: BRAND.tealLight }}>
                      <Scan className="w-6 h-6" style={{ color: BRAND.tealLight }} />
                    </span>
                  </div>
                  <p className="text-sm font-semibold mb-1">Escaneando el piso…</p>
                  <p className="text-[11px] text-white/70 mb-3 leading-relaxed">
                    Cuando veas el círculo sobre el suelo, toca la pantalla o el botón para colocar el modelo a tamaño real.
                  </p>
                  <button
                    onClick={() => arPlaceFnRef.current?.()}
                    className="w-full rounded-xl px-4 py-3 text-white text-sm font-semibold transition-colors shadow-lg"
                    style={{ backgroundColor: BRAND.teal }}
                  >
                    📍 Colocar aquí
                  </button>
                  <button
                    onClick={() => arEnterImmersiveFnRef.current?.()}
                    className="w-full mt-2 rounded-xl px-4 py-2.5 bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors"
                  >
                    Entrar al modelo sin escanear
                  </button>
                </div>
              </div>
            )}

            {/* AR Floor Selector - right side vertical strip */}
            {arStep !== "scanning" && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center">
              {/* Toggle button */}
              <button
                onClick={() => setArFloorPickerOpen(!arFloorPickerOpen)}
                className="bg-black/70 backdrop-blur-sm text-white rounded-xl px-3 py-2.5 mb-1 flex items-center gap-1.5 shadow-lg"
              >
                <Building2 className="w-4 h-4" />
                <span className="text-xs font-bold">{arCurrentFloor}</span>
                {arFloorPickerOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>

              {/* Floor list */}
              {arFloorPickerOpen && (
                <div className="bg-black/80 backdrop-blur-md rounded-xl shadow-2xl max-h-[60vh] overflow-y-auto py-1 w-16">
                  {[...FLOOR_LEVELS].reverse().map((floor) => (
                    <button
                      key={floor.short}
                      onClick={() => teleportARToFloor(floor.short)}
                      className={`w-full px-2 py-2 text-center text-xs font-medium transition-colors ${
                        arCurrentFloor === floor.short
                          ? "text-white"
                          : "text-white/60 hover:text-white hover:bg-white/10"
                      }`}
                      style={arCurrentFloor === floor.short ? { backgroundColor: `${BRAND.teal}CC` } : {}}
                    >
                      {floor.short}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}

            {/* AR Controls - placed / walk mode */}
            {(arStep === "placed" || arStep === "walking") && (
              <div className="absolute bottom-6 left-0 right-0 z-10 flex flex-col items-center gap-3 px-4">
                {/* Global transparency — x-ray vs. the real site */}
                <div className="bg-black/60 backdrop-blur-sm rounded-2xl px-4 py-2.5 flex items-center gap-3 w-full max-w-sm">
                  <Eye className="w-4 h-4 text-white/80 flex-shrink-0" />
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={arOpacity}
                    onChange={(e) => applyAROpacity(Number(e.target.value))}
                    className="flex-1 accent-teal-400"
                    aria-label="Transparencia del modelo"
                  />
                  <span className="text-white text-xs font-mono w-10 text-right">{arOpacity}%</span>
                </div>

                {arStep === "placed" && (
                  <button
                    onClick={enterImmersiveFromAR}
                    className="rounded-xl px-4 py-2.5 text-white text-xs font-semibold transition-colors shadow-lg"
                    style={{ backgroundColor: BRAND.navy }}
                  >
                    🚶 Entrar y caminar dentro (1:1)
                  </button>
                )}

                {/* Rotation fine-tune */}
                <div className="bg-black/60 backdrop-blur-sm rounded-2xl px-4 py-2.5 flex items-center gap-3">
                  <button
                    onClick={() => rotateARModel(-15)}
                    className="bg-white/20 hover:bg-white/30 rounded-lg w-10 h-10 flex items-center justify-center text-white text-lg transition-colors"
                    title="Rotar modelo -15°"
                  >
                    ↶
                  </button>
                  <button
                    onClick={() => rotateARModel(-5)}
                    className="bg-white/15 hover:bg-white/25 rounded-lg w-8 h-8 flex items-center justify-center text-white text-sm transition-colors"
                  >
                    ↺
                  </button>
                  <span className="text-white text-xs font-mono min-w-[3rem] text-center">
                    {Math.round((arRotationRef.current * 180) / Math.PI % 360)}°
                  </span>
                  <button
                    onClick={() => rotateARModel(5)}
                    className="bg-white/15 hover:bg-white/25 rounded-lg w-8 h-8 flex items-center justify-center text-white text-sm transition-colors"
                  >
                    ↻
                  </button>
                  <button
                    onClick={() => rotateARModel(15)}
                    className="bg-white/20 hover:bg-white/30 rounded-lg w-10 h-10 flex items-center justify-center text-white text-lg transition-colors"
                    title="Rotar modelo +15°"
                  >
                    ↷
                  </button>
                </div>

                {/* Georeferencing panel */}
                {arGeoMode && (
                  <div className="bg-black/70 backdrop-blur-md rounded-2xl px-4 py-3 w-full max-w-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-white text-xs font-semibold">🌍 Georeferenciación</span>
                      <button
                        onClick={stopARGeoref}
                        className="ml-auto text-white/60 hover:text-white text-xs"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${arGpsStatus === "ready" ? "bg-green-400" : arGpsStatus === "acquiring" ? "bg-yellow-400 animate-pulse" : "bg-red-400"}`} />
                        <span className="text-white/80 text-[10px]">
                          GPS: {arGpsStatus === "ready" ? `±${arGpsPosition?.accuracy.toFixed(0)}m` : arGpsStatus === "acquiring" ? "Adquiriendo..." : arGpsStatus === "error" ? "Error" : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${arCompassHeading !== null ? "bg-green-400" : "bg-yellow-400 animate-pulse"}`} />
                        <span className="text-white/80 text-[10px]">
                          Brújula: {arCompassHeading !== null ? `${arCompassHeading.toFixed(0)}°` : "Calibrando..."}
                        </span>
                      </div>
                      {arGpsPosition && (
                        <div className="text-white/50 text-[9px] font-mono">
                          {arGpsPosition.lat.toFixed(6)}, {arGpsPosition.lng.toFixed(6)}
                        </div>
                      )}
                      {!utmCalibration && (
                        <div className="text-yellow-300/80 text-[9px]">
                          ⚠ Sin calibración UTM. Ve a Coords → Calibración UTM primero.
                        </div>
                      )}
                    </div>
                    <button
                      onClick={applyARGeoref}
                      disabled={arGpsStatus !== "ready" || arCompassHeading === null || !utmCalibration}
                      className="mt-2 w-full rounded-lg px-3 py-2 text-white text-xs font-medium transition-colors disabled:opacity-40"
                      style={{ backgroundColor: `${BRAND.teal}CC` }}
                    >
                      🧭 Alinear con Norte Real
                    </button>
                  </div>
                )}

                {/* Action buttons */}
                <div className="bg-black/60 backdrop-blur-sm rounded-2xl px-4 py-2.5 flex items-center gap-2 flex-wrap justify-center">
                  <button
                    onClick={resetARPlacement}
                    className="bg-white/20 hover:bg-white/30 rounded-lg px-3 py-2 text-white text-xs font-medium transition-colors"
                  >
                    ↩ Reposicionar
                  </button>
                  {!arGeoMode && (
                    <button
                      onClick={startARGeoref}
                      className="bg-blue-500/60 hover:bg-blue-500/80 rounded-lg px-3 py-2 text-white text-xs font-medium transition-colors"
                    >
                      🌍 Georef
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══ Add File Dialog ═══ */}
      {showAddFileDialog && (
        <>
          <div className="absolute inset-0 z-50 bg-black/40" onClick={() => setShowAddFileDialog(false)} />
          <div
            className="absolute z-50 rounded-xl shadow-2xl p-5 w-96 max-w-[92vw] max-h-[80vh] overflow-y-auto"
            style={{
              backgroundColor: BRAND.cardBg,
              border: `1px solid ${BRAND.border}`,
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: BRAND.navy }}>
                <FolderPlus className="w-4 h-4" style={{ color: BRAND.teal }} />
                Agregar Archivos GLB
              </h3>
              <button onClick={() => setShowAddFileDialog(false)} className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4" style={{ color: BRAND.textMuted }} />
              </button>
            </div>
            <p className="text-[11px] mb-4" style={{ color: BRAND.textMuted }}>
              Selecciona la especialidad y sube el archivo GLB, IFC o RVT. Máximo 300MB por archivo.
            </p>
            <div className="space-y-3">
              {SPECIALTY_OPTIONS.map((spec) => {
                const existing = files.find((f: any) => f.specialty === spec.value);
                const uploading = addFileUploading[spec.value];
                const success = addFileSuccess.includes(spec.value);
                return (
                  <div
                    key={spec.value}
                    className="rounded-lg p-3 flex items-center gap-3"
                    style={{ backgroundColor: BRAND.bg, border: `1px solid ${BRAND.border}` }}
                  >
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: spec.color }} />
                    <div className="flex-1 min-w-0">
                      {spec.custom ? (
                        <input
                          type="text"
                          placeholder="Nombre de especialidad..."
                          value={customSpecialtyNames[spec.value] || ""}
                          onChange={(e) => setCustomSpecialtyNames(prev => ({ ...prev, [spec.value]: e.target.value }))}
                          className="text-xs font-medium w-full bg-transparent border-b border-dashed outline-none py-0.5 placeholder:text-gray-400"
                          style={{ color: BRAND.textPrimary, borderColor: customSpecialtyNames[spec.value] ? BRAND.teal + "60" : BRAND.border }}
                        />
                      ) : (
                        <p className="text-xs font-medium truncate" style={{ color: BRAND.textPrimary }}>{spec.label}</p>
                      )}
                      {existing && !success && (
                        <p className="text-[10px] truncate" style={{ color: BRAND.textMuted }}>Actual: {(existing as any).filename || spec.value}.glb</p>
                      )}
                      {uploading !== undefined && (
                        <div className="mt-1">
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: BRAND.border }}>
                            <div className="h-full rounded-full transition-all" style={{ width: `${uploading}%`, backgroundColor: BRAND.teal }} />
                          </div>
                          <p className="text-[9px] mt-0.5" style={{ color: BRAND.teal }}>{uploading}%</p>
                        </div>
                      )}
                      {success && (
                        <p className="text-[10px] flex items-center gap-1 mt-0.5" style={{ color: "#22C55E" }}>
                          <Check className="w-3 h-3" /> Subido exitosamente
                        </p>
                      )}
                    </div>
                    {uploading === undefined && !success && (
                      <label
                        className="shrink-0 px-2.5 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer transition-colors hover:opacity-90 flex items-center gap-1"
                        style={{ backgroundColor: existing ? BRAND.navyLight : BRAND.teal, color: "#fff" }}
                      >
                        <FileUp className="w-3 h-3" />
                        {existing ? "Reemplazar" : "Subir"}
                        <input
                          type="file"
                          accept=".glb,.gltf,.ifc,.rvt"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) {
                              if (spec.custom && !customSpecialtyNames[spec.value]?.trim()) {
                                toast.error("Escribe el nombre de la especialidad antes de subir");
                                e.target.value = "";
                                return;
                              }
                              handleAddFile(f, spec.value);
                            }
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            {addFileSuccess.length > 0 && (
              <div className="mt-4 rounded-lg p-3 text-[11px]" style={{ backgroundColor: "#22C55E10", color: "#22C55E" }}>
                <p className="font-medium">{addFileSuccess.length} archivo(s) subido(s). Recarga la página para ver los cambios en el visor.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
