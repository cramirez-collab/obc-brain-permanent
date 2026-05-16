/**
 * IFC Viewer - Loads pre-processed GLB files by specialty
 * Design: White background, architecture/structure in glass (85% transparent + edges),
 * MEP systems in solid colors with toggles
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// CDN URLs for pre-processed GLBs
const SPECIALTIES: Record<string, {
  label: string;
  url: string;
  color: string;
  transparent: boolean;
  opacity: number;
  showEdges: boolean;
}> = {
  arch_struct: {
    label: 'Arquitectura / Estructura',
    url: import.meta.env.DEV ? '/glb/arch_struct.glb' : 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663201051818/vQmSaBQElWcnnvcM.glb',
    color: '#b0b0b0',
    transparent: true,
    opacity: 0.15,
    showEdges: true,
  },
  hvac: {
    label: 'HVAC / Ductos',
    url: import.meta.env.DEV ? '/glb/hvac.glb' : 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663201051818/vSxsFDDQKFoCDrHC.glb',
    color: '#2196F3',
    transparent: false,
    opacity: 1,
    showEdges: false,
  },
  plumbing: {
    label: 'Tuberías / Plomería',
    url: import.meta.env.DEV ? '/glb/plumbing.glb' : 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663201051818/UYooHKMfxnrMdwEr.glb',
    color: '#4CAF50',
    transparent: false,
    opacity: 1,
    showEdges: false,
  },
  electrical: {
    label: 'Eléctrico',
    url: import.meta.env.DEV ? '/glb/electrical.glb' : 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663201051818/upFTlQIpMFbRVkUr.glb',
    color: '#FF9800',
    transparent: false,
    opacity: 1,
    showEdges: false,
  },
  mechanical: {
    label: 'Equipos Mecánicos',
    url: import.meta.env.DEV ? '/glb/mechanical.glb' : 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663201051818/sZEsWyIZtrCsdmlL.glb',
    color: '#9C27B0',
    transparent: false,
    opacity: 1,
    showEdges: false,
  },
};

interface LayerState {
  visible: boolean;
  loaded: boolean;
  loading: boolean;
  progress: number;
  group: THREE.Group | null;
  edgeGroup: THREE.Group | null;
}

export default function IFCViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number>(0);
  const firstFitDone = useRef(false);

  const [layers, setLayers] = useState<Record<string, LayerState>>(() => {
    const init: Record<string, LayerState> = {};
    for (const key of Object.keys(SPECIALTIES)) {
      init[key] = { visible: true, loaded: false, loading: false, progress: 0, group: null, edgeGroup: null };
    }
    return init;
  });

  const [coords, setCoords] = useState({ x: 0, y: 0, z: 0 });
  const [panelOpen, setPanelOpen] = useState(true);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Initialize Three.js scene
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, el.clientWidth / el.clientHeight, 0.1, 10000);
    camera.position.set(50, 50, 50);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI;
    controlsRef.current = controls;

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(100, 200, 100);
    scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-100, 100, -100);
    scene.add(dirLight2);

    // Grid
    const grid = new THREE.GridHelper(200, 40, 0xcccccc, 0xe5e5e5);
    (grid.material as THREE.Material).opacity = 0.5;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // Axes
    scene.add(new THREE.AxesHelper(20));

    // Animate
    function animate() {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    const handleResize = () => {
      if (!el) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animFrameRef.current);
      renderer.dispose();
      if (el && renderer.domElement.parentNode === el) {
        el.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Load a specialty GLB
  const loadSpecialty = useCallback((key: string) => {
    const spec = SPECIALTIES[key];
    const scene = sceneRef.current;
    if (!spec || !scene) return;

    setLayers(prev => ({ ...prev, [key]: { ...prev[key], loading: true, progress: 0 } }));

    const loader = new GLTFLoader();
    loader.load(
      spec.url,
      (gltf) => {
        const group = new THREE.Group();
        group.name = key;
        const edgeGroup = new THREE.Group();
        edgeGroup.name = `${key}_edges`;

        gltf.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            const geo = mesh.geometry;

            const mat = new THREE.MeshPhongMaterial({
              color: new THREE.Color(spec.color),
              transparent: spec.transparent,
              opacity: spec.opacity,
              side: THREE.DoubleSide,
              depthWrite: !spec.transparent,
              shininess: spec.transparent ? 80 : 40,
            });

            const newMesh = new THREE.Mesh(geo, mat);
            newMesh.matrixAutoUpdate = false;
            newMesh.matrix.copy(mesh.matrixWorld);
            group.add(newMesh);

            // Edges for architecture/structure
            if (spec.showEdges) {
              const edges = new THREE.EdgesGeometry(geo, 30);
              const lineMat = new THREE.LineBasicMaterial({
                color: 0x888888,
                transparent: true,
                opacity: 0.35,
              });
              const lineSegments = new THREE.LineSegments(edges, lineMat);
              lineSegments.matrixAutoUpdate = false;
              lineSegments.matrix.copy(mesh.matrixWorld);
              edgeGroup.add(lineSegments);
            }
          }
        });

        scene.add(group);
        if (spec.showEdges) scene.add(edgeGroup);

        // Fit camera on first loaded specialty
        if (!firstFitDone.current) {
          firstFitDone.current = true;
          const box = new THREE.Box3().setFromObject(group);
          if (!box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            if (cameraRef.current && controlsRef.current) {
              cameraRef.current.position.set(
                center.x + maxDim * 0.8,
                center.y + maxDim * 0.6,
                center.z + maxDim * 0.8
              );
              controlsRef.current.target.copy(center);
              controlsRef.current.update();
            }
          }
        }

        setLayers(prev => ({
          ...prev,
          [key]: { ...prev[key], loaded: true, loading: false, progress: 100, group, edgeGroup: spec.showEdges ? edgeGroup : null }
        }));
      },
      (progress) => {
        if (progress.total > 0) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          setLayers(prev => ({ ...prev, [key]: { ...prev[key], progress: pct } }));
        }
      },
      (error) => {
        console.error(`Error loading ${key}:`, error);
        setLayers(prev => ({ ...prev, [key]: { ...prev[key], loading: false, progress: 0 } }));
      }
    );
  }, []);

  // Auto-load all on mount
  useEffect(() => {
    const keys = Object.keys(SPECIALTIES);
    keys.forEach((key, idx) => {
      setTimeout(() => loadSpecialty(key), idx * 300);
    });
  }, [loadSpecialty]);

  // Toggle visibility
  const toggleLayer = useCallback((key: string) => {
    setLayers(prev => {
      const layer = prev[key];
      if (!layer.loaded || !layer.group) return prev;
      const newVisible = !layer.visible;
      layer.group.visible = newVisible;
      if (layer.edgeGroup) layer.edgeGroup.visible = newVisible;
      return { ...prev, [key]: { ...layer, visible: newVisible } };
    });
  }, []);

  // Apply coordinate offset
  const applyCoords = useCallback(() => {
    Object.values(layersRef.current).forEach(layer => {
      if (layer.group) layer.group.position.set(coords.x, coords.z, coords.y);
      if (layer.edgeGroup) layer.edgeGroup.position.set(coords.x, coords.z, coords.y);
    });
  }, [coords]);

  // Fit camera
  const fitAll = useCallback(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    const box = new THREE.Box3();
    Object.values(layersRef.current).forEach(layer => {
      if (layer.group && layer.visible) box.expandByObject(layer.group);
    });
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    camera.position.set(center.x + maxDim * 0.8, center.y + maxDim * 0.6, center.z + maxDim * 0.8);
    controls.target.copy(center);
    controls.update();
  }, []);

  const anyLoading = Object.values(layers).some(l => l.loading);
  const totalProgress = Object.values(layers).reduce((sum, l) => sum + (l.loading ? l.progress : l.loaded ? 100 : 0), 0);
  const overallProgress = Math.round(totalProgress / Object.keys(layers).length);

  return (
    <div className="w-full h-screen flex relative bg-white">
      {/* 3D Viewport */}
      <div ref={containerRef} className="flex-1 relative" />

      {/* Loading bar */}
      {anyLoading && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white border border-gray-200 rounded-lg px-6 py-3 shadow-lg z-20">
          <div className="flex items-center gap-3">
            <div className="w-48 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${overallProgress}%` }} />
            </div>
            <span className="text-sm text-gray-600 font-mono">{overallProgress}%</span>
          </div>
        </div>
      )}

      {/* Panel toggle */}
      <button
        onClick={() => setPanelOpen(!panelOpen)}
        className="absolute top-4 z-30 bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-md hover:bg-gray-50 text-sm text-gray-600"
        style={{ right: panelOpen ? '324px' : '16px' }}
      >
        {panelOpen ? '▶' : '◀ Panel'}
      </button>

      {/* Side panel */}
      {panelOpen && (
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col overflow-y-auto z-20">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
            <h1 className="text-sm font-bold text-gray-800" style={{ fontFamily: "'Outfit', sans-serif" }}>
              HMA-01 OBJETIVA ARQ
            </h1>
            <p className="text-[11px] text-gray-400 mt-0.5">Visor de Especialidades</p>
          </div>

          {/* Layers */}
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Especialidades</h2>
            <div className="space-y-1">
              {Object.entries(SPECIALTIES).map(([key, spec]) => {
                const layer = layers[key];
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2.5 py-2 px-2 rounded hover:bg-gray-50 cursor-pointer select-none"
                    onClick={() => layer.loaded && toggleLayer(key)}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 transition-colors"
                      style={{
                        backgroundColor: layer.visible && layer.loaded ? spec.color : 'transparent',
                        borderColor: spec.color,
                        opacity: layer.loaded ? 1 : 0.3,
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-700 truncate">{spec.label}</div>
                      {layer.loading && (
                        <div className="w-full h-1 bg-gray-100 rounded-full mt-1">
                          <div className="h-full rounded-full transition-all" style={{ width: `${layer.progress}%`, backgroundColor: spec.color }} />
                        </div>
                      )}
                    </div>
                    {layer.loaded && (
                      <span className={`text-[10px] font-medium ${layer.visible ? 'text-green-600' : 'text-gray-300'}`}>
                        {layer.visible ? 'ON' : 'OFF'}
                      </span>
                    )}
                    {layer.loading && <span className="text-[10px] text-gray-400">{layer.progress}%</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Coordinates */}
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Coordenadas en Obra (m)</h2>
            <div className="space-y-1.5">
              {(['x', 'y', 'z'] as const).map((axis) => (
                <div key={axis} className="flex items-center gap-2">
                  <label className="text-xs font-bold text-gray-500 w-5 uppercase">{axis}</label>
                  <input
                    type="number"
                    step="0.1"
                    value={coords[axis]}
                    onChange={(e) => setCoords(prev => ({ ...prev, [axis]: parseFloat(e.target.value) || 0 }))}
                    className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                </div>
              ))}
              <button
                onClick={applyCoords}
                className="w-full mt-1.5 px-3 py-2 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 transition-colors font-medium"
              >
                Aplicar Posición
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="px-4 py-3">
            <h2 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Acciones</h2>
            <div className="space-y-1.5">
              <button onClick={fitAll} className="w-full px-3 py-2 bg-gray-50 text-gray-600 text-xs rounded hover:bg-gray-100 border border-gray-200 font-medium">
                Ajustar Vista
              </button>
              <button
                onClick={() => {
                  Object.keys(SPECIALTIES).forEach(key => {
                    const layer = layersRef.current[key];
                    if (layer.loaded && layer.group) {
                      layer.group.visible = true;
                      if (layer.edgeGroup) layer.edgeGroup.visible = true;
                    }
                  });
                  setLayers(prev => {
                    const next = { ...prev };
                    for (const key of Object.keys(next)) next[key] = { ...next[key], visible: true };
                    return next;
                  });
                }}
                className="w-full px-3 py-2 bg-gray-50 text-gray-600 text-xs rounded hover:bg-gray-100 border border-gray-200 font-medium"
              >
                Mostrar Todo
              </button>
              <button
                onClick={() => {
                  Object.keys(SPECIALTIES).forEach(key => {
                    const layer = layersRef.current[key];
                    if (layer.loaded && layer.group) {
                      layer.group.visible = false;
                      if (layer.edgeGroup) layer.edgeGroup.visible = false;
                    }
                  });
                  setLayers(prev => {
                    const next = { ...prev };
                    for (const key of Object.keys(next)) next[key] = { ...next[key], visible: false };
                    return next;
                  });
                }}
                className="w-full px-3 py-2 bg-gray-50 text-gray-600 text-xs rounded hover:bg-gray-100 border border-gray-200 font-medium"
              >
                Ocultar Todo
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 mt-auto border-t border-gray-100 bg-gray-50/50">
            <p className="text-[10px] text-gray-400">Arq/Estructura: cristal 85% transparencia + aristas</p>
            <p className="text-[10px] text-gray-400 mt-0.5">MEP: colores sólidos por especialidad</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Scroll: Zoom · Drag: Rotar · Click derecho: Pan</p>
          </div>
        </div>
      )}
    </div>
  );
}
