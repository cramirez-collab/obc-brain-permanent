import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getLoginUrl } from "@/const";
import { Plus, FolderOpen, Trash2, Loader2, Box, LogOut, Menu, X, Upload, FileBox, CheckCircle2, AlertCircle, ImageIcon, HardDrive, Download } from "lucide-react";
import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { fetchGLBWithCache, isCached } from "@/lib/glbCache";

/* Objetiva Brand */
const BRAND = {
  navy: "#1B2A4A",
  teal: "#00A89D",
  tealLight: "#00C4B7",
  bg: "#F7F9FC",
};

/* Default specialties with colors */
const DEFAULT_SPECIALTIES = [
  { key: "hvac", label: "Aire Acondicionado y Climatización", color: "#2196F3", transparent: false, opacity: 100, custom: false },
  { key: "architecture", label: "Arquitectura", color: "#B0BEC5", transparent: true, opacity: 30, custom: false },
  { key: "electrical", label: "Eléctrico", color: "#FF9800", transparent: false, opacity: 100, custom: false },
  { key: "structure", label: "Estructuras", color: "#78909C", transparent: true, opacity: 40, custom: false },
  { key: "gas", label: "Gas", color: "#FFC107", transparent: false, opacity: 100, custom: false },
  { key: "plumbing", label: "Hidráulico", color: "#4CAF50", transparent: false, opacity: 100, custom: false },
  { key: "stormwater", label: "Pluvial", color: "#00BCD4", transparent: false, opacity: 100, custom: false },
  { key: "fire_protection", label: "Protección contra Incendios", color: "#F44336", transparent: false, opacity: 100, custom: false },
  { key: "sanitary", label: "Sanitario", color: "#8BC34A", transparent: false, opacity: 100, custom: false },
  { key: "custom_1", label: "", color: "#9C27B0", transparent: false, opacity: 100, custom: true },
  { key: "custom_2", label: "", color: "#E91E63", transparent: false, opacity: 100, custom: true },
  { key: "custom_3", label: "", color: "#607D8B", transparent: false, opacity: 100, custom: true },
] as const;

type FileSlot = {
  key: string;
  label: string;
  color: string;
  transparent: boolean;
  opacity: number;
  file: File | null;
  status: "idle" | "uploading" | "done" | "error";
  progress: number;
  url?: string;
  fileKey?: string;
  fileSize?: number;
  custom?: boolean;
  customLabel?: string;
};

function ObjetivaLogo({ size = "lg" }: { size?: "sm" | "lg" }) {
  const h = size === "lg" ? "h-10 sm:h-12" : "h-7 sm:h-8";
  return (
    <img src="/oar-logo.jpeg" alt="OAR" className={`${h} w-auto object-contain`} />
  );
}

export default function Home() {
  const { user, loading: authLoading, isAuthenticated, logout } = useAuth();
  const [, navigate] = useLocation();
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploadStep, setUploadStep] = useState<"info" | "files" | "uploading">("info");
  const abortRef = useRef(false);

  const [fileSlots, setFileSlots] = useState<FileSlot[]>(
    DEFAULT_SPECIALTIES.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      transparent: s.transparent,
      opacity: s.opacity,
      file: null,
      status: "idle" as const,
      progress: 0,
      custom: s.custom,
      customLabel: "",
    }))
  );

  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});

  const projectsQuery = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });

  // Load thumbnails from localStorage
  useEffect(() => {
    const projects = projectsQuery.data ?? [];
    const thumbs: Record<number, string> = {};
    projects.forEach((p) => {
      const saved = localStorage.getItem(`project-thumb-${p.id}`);
      if (saved) thumbs[p.id] = saved;
    });
    setThumbnails(thumbs);
  }, [projectsQuery.data]);
  const createMutation = trpc.project.create.useMutation();
  const addFileMutation = trpc.project.addFile.useMutation();
  const setReadyMutation = trpc.project.setReady.useMutation();
  const deleteMutation = trpc.project.delete.useMutation({
    onSuccess: () => {
      toast.success("Proyecto eliminado");
      projectsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  // Cache status tracking per project
  const [cacheStatus, setCacheStatus] = useState<Record<number, { cached: number; total: number; downloading: boolean }>>({});

  // Check cache status for all projects on load
  useEffect(() => {
    if (!projectsQuery.data) return;
    const checkAll = async () => {
      const statuses: Record<number, { cached: number; total: number; downloading: boolean }> = {};
      for (const project of projectsQuery.data) {
        try {
          const projectData = await trpcUtils.project.getById.fetch({ id: project.id });
          if (!projectData?.files?.length) continue;
          let cachedCount = 0;
          const total = projectData.files.filter((f: any) => f.url).length;
          for (const file of projectData.files) {
            if (!file.url) continue;
            const cacheKey = (file as any).fileKey || file.url;
            const result = await isCached(cacheKey);
            if (result.cached) cachedCount++;
          }
          statuses[project.id] = { cached: cachedCount, total, downloading: false };
        } catch {
          // skip
        }
      }
      setCacheStatus(statuses);
    };
    checkAll();
  }, [projectsQuery.data]);

  // Prefetch GLB files into IndexedDB cache when hovering a project card
  const prefetchingRef = useRef<Set<number>>(new Set());
  const trpcUtils = trpc.useUtils();
  const prefetchProject = useCallback(async (projectId: number) => {
    if (prefetchingRef.current.has(projectId)) return;
    prefetchingRef.current.add(projectId);
    setCacheStatus(prev => ({ ...prev, [projectId]: { ...prev[projectId], downloading: true } }));
    try {
      const projectData = await trpcUtils.project.getById.fetch({ id: projectId });
      if (!projectData?.files) return;
      let cachedCount = 0;
      const total = projectData.files.filter((f: any) => f.url).length;
      for (const file of projectData.files) {
        if (!file.url) continue;
        const cacheKey = (file as any).fileKey || file.url;
        const result = await isCached(cacheKey);
        if (result.cached) {
          cachedCount++;
        } else {
          // Resolve presigned URL on-demand for download
          // Prefer gzFileKey for large files (85-94% smaller download)
          const gzKey = (file as any).gzFileKey;
          const fKey = (file as any).fileKey;
          let resolvedUrl = file.url;
          if (gzKey || fKey) {
            try {
              const urlResult = await trpcUtils.storage.getFileUrl.fetch({ fileKey: gzKey || fKey });
              resolvedUrl = urlResult.url;
            } catch { /* use stored url */ }
          }
          const proxyUrl = `/api/proxy-glb?url=${encodeURIComponent(resolvedUrl)}`;
          await fetchGLBWithCache(cacheKey, proxyUrl).catch(() => {});
          cachedCount++;
        }
        setCacheStatus(prev => ({ ...prev, [projectId]: { cached: cachedCount, total, downloading: cachedCount < total } }));
      }
      setCacheStatus(prev => ({ ...prev, [projectId]: { cached: cachedCount, total, downloading: false } }));
    } catch {
      setCacheStatus(prev => ({ ...prev, [projectId]: { ...prev[projectId], downloading: false } }));
    }
  }, [trpcUtils]);

  const handleFileSelect = useCallback((slotKey: string, file: File | null) => {
    setFileSlots((prev) =>
      prev.map((s) =>
        s.key === slotKey ? { ...s, file, status: "idle" as const, progress: 0 } : s
      )
    );
  }, []);

  const getUploadUrlMutation = trpc.project.getUploadUrl.useMutation();
  const processUploadedFileMutation = trpc.project.processUploadedFile.useMutation();

  const uploadFile = async (
    projectId: number,
    slot: FileSlot,
    onProgress: (p: number) => void
  ): Promise<{ url: string; fileKey: string; fileSize: number; originalSize?: number; optimized?: boolean; optimizationLevel?: string; compressionRatio?: number; lodUrl?: string; stats?: { verticesBefore: number; verticesAfter: number }; rvtStored?: boolean; needsIFCExport?: boolean }> => {
    const file = slot.file!;
    const fileName = file.name.toLowerCase();
    const isIFC = fileName.endsWith(".ifc");
    const isRVT = fileName.endsWith(".rvt");
    const isGLB = fileName.endsWith(".glb") || fileName.endsWith(".gltf");
    const fileType: "glb" | "ifc" | "rvt" = isIFC ? "ifc" : isRVT ? "rvt" : "glb";
    const needsConversion = isIFC || isRVT;

    onProgress(needsConversion ? 5 : 10);

    if (needsConversion) {
      const format = isIFC ? "IFC" : "RVT";
      toast.info(`Subiendo ${format}... Esto puede tardar unos segundos`, { duration: 8000 });
    }

    // Retry logic: up to 3 attempts with exponential backoff
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Step 1: Get presigned upload URL from backend
        const { uploadUrl, fileKey, authToken } = await getUploadUrlMutation.mutateAsync({
          projectId,
          specialty: slot.key,
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
              onProgress(pct);
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

        // Step 3: Process the uploaded file on the backend
        if (isIFC) {
          onProgress(55);
          toast.info("Convirtiendo IFC → GLB en servidor...", { duration: 10000 });
        } else if (isRVT) {
          onProgress(30);
          toast.info("Convirtiendo RVT → IFC → GLB via Autodesk Cloud (5-15 min)...", { duration: 30000 });
        } else if (isGLB) {
          onProgress(85);
        }

        const processResult = await processUploadedFileMutation.mutateAsync({
          projectId,
          specialty: slot.key,
          fileKey,
          fileType,
          fileSize: file.size,
          fileUrl,
        });

        onProgress(100);
        lastError = null;

        // Success path
        return handleUploadResult(processResult, slot, file);
      } catch (err: any) {
        lastError = err;
        if (err.name === "AbortError") {
          toast.error(`Timeout subiendo ${slot.label}. El archivo puede ser demasiado grande.`, { duration: 8000 });
          throw new Error("Upload timeout");
        }
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 2000;
          toast.info(`Reintentando ${slot.label} (intento ${attempt + 1}/${MAX_RETRIES})...`, { duration: 3000 });
          onProgress(needsConversion ? 5 : 10);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError || new Error("Upload failed after retries");
  };

  const handleUploadResult = (
    result: any,
    slot: FileSlot,
    file: File
  ): { url: string; fileKey: string; fileSize: number; originalSize?: number; optimized?: boolean; optimizationLevel?: string; compressionRatio?: number; lodUrl?: string; stats?: { verticesBefore: number; verticesAfter: number } } => {
    // RVT files are now fully converted server-side via APS pipeline (RVT→IFC→GLB)

    // Show conversion feedback
    if (result.convertedFrom) {
      const glbMB = (result.fileSize / 1024 / 1024).toFixed(1);
      toast.success(`${result.convertedFrom} convertido: ${result.meshCount} meshes, ${result.vertexCount?.toLocaleString()} vértices → ${glbMB}MB GLB`, { duration: 6000 });
    }
    // Show optimization feedback
    if (result.optimized) {
      const origMB = ((result.convertedFrom ? result.fileSize : result.originalSize) / 1024 / 1024).toFixed(1);
      const compMB = (result.fileSize / 1024 / 1024).toFixed(1);
      const pct = ((1 - result.compressionRatio) * 100).toFixed(0);
      const level = result.optimizationLevel === 'aggressive' ? 'Agresivo' : result.optimizationLevel === 'moderate' ? 'Moderado' : 'Ligero';
      const vBefore = result.stats?.verticesBefore?.toLocaleString() ?? '?';
      const vAfter = result.stats?.verticesAfter?.toLocaleString() ?? '?';
      toast.success(`Optimizado (${level}): ${origMB}MB → ${compMB}MB (-${pct}%) | Vértices: ${vBefore} → ${vAfter}`, { duration: 5000 });
    }
    return result;
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const filesToUpload = fileSlots.filter((s) => s.file !== null && (!s.custom || (s.customLabel && s.customLabel.trim())));
    if (filesToUpload.length === 0) {
      toast.error("Agrega al menos un archivo (GLB, IFC o RVT)");
      return;
    }
    // Validate file sizes
    const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB
    const oversized = filesToUpload.filter((s) => s.file!.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      toast.error(`${oversized.map(s => s.label).join(", ")} excede(n) 300MB. Reduce el tamaño del archivo antes de subirlo.`);
      return;
    }

    setCreating(true);
    setUploadStep("uploading");
    abortRef.current = false;

    try {
      // Step 1: Create project
      const { id: projectId } = await createMutation.mutateAsync({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      });

      // Step 2: Upload each file sequentially
      for (const slot of filesToUpload) {
        if (abortRef.current) break;

        setFileSlots((prev) =>
          prev.map((s) =>
            s.key === slot.key ? { ...s, status: "uploading" as const, progress: 5 } : s
          )
        );

        try {
          const result = await uploadFile(projectId, slot, (p) => {
            setFileSlots((prev) =>
              prev.map((s) =>
                s.key === slot.key ? { ...s, progress: p } : s
              )
            );
          });

          // Register file in DB (all files now have GLB after conversion)
          await addFileMutation.mutateAsync({
            projectId,
            specialty: slot.custom ? slot.key : slot.key,
            label: slot.custom ? (slot.customLabel || slot.key) : slot.label,
            url: result.url,
            fileKey: result.fileKey,
            color: slot.color,
            transparent: slot.transparent,
            opacity: slot.opacity,
            showEdges: true,
            fileSize: result.fileSize,
            lodUrl: result.lodUrl ?? undefined,
            originalFormat: slot.file!.name.toLowerCase().endsWith(".rvt") ? "rvt" : slot.file!.name.toLowerCase().endsWith(".ifc") ? "ifc" : "glb",
            conversionStatus: "ready",
          });

          setFileSlots((prev) =>
            prev.map((s) =>
              s.key === slot.key
                ? {
                    ...s,
                    status: "done" as const,
                    progress: 100,
                    url: result.url,
                    fileKey: result.fileKey,
                    fileSize: result.fileSize,
                  }
                : s
            )
          );
        } catch (err: any) {
          setFileSlots((prev) =>
            prev.map((s) =>
              s.key === slot.key ? { ...s, status: "error" as const } : s
            )
          );
          console.error(`Error uploading ${slot.label}:`, err);
        }
      }

      // Step 3: Mark project as ready
      await setReadyMutation.mutateAsync({ id: projectId });

      toast.success("Proyecto creado con archivos");
      setDialogOpen(false);
      resetForm();
      projectsQuery.refetch();
      navigate(`/project/${projectId}`);
    } catch (err: any) {
      toast.error(err.message || "Error al crear proyecto");
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setNewName("");
    setNewDesc("");
    setUploadStep("info");
    setFileSlots(
      DEFAULT_SPECIALTIES.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.color,
        transparent: s.transparent,
        opacity: s.opacity,
        file: null,
        status: "idle" as const,
        progress: 0,
        custom: s.custom,
        customLabel: "",
      }))
    );
  };

  const filesSelected = fileSlots.filter((s) => s.file !== null).length;
  const totalSize = fileSlots.reduce((acc, s) => acc + (s.file?.size || 0), 0);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: BRAND.bg }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.teal }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: BRAND.bg }}>
        <Card className="w-full max-w-sm sm:max-w-md shadow-lg border-0">
          <CardContent className="p-6 sm:p-8 text-center space-y-5 sm:space-y-6">
            <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-xl flex items-center justify-center" style={{ backgroundColor: `${BRAND.teal}15` }}>
              <Box className="w-7 h-7 sm:w-8 sm:h-8" style={{ color: BRAND.teal }} />
            </div>
            <div>
              <ObjetivaLogo size="lg" />
              <p className="text-xs sm:text-sm mt-2" style={{ color: "#64748B" }}>Visor BIM por especialidades</p>
            </div>
            <Button
              className="w-full text-white font-medium py-3"
              style={{ backgroundColor: BRAND.teal }}
              onClick={() => { window.location.href = getLoginUrl(); }}
            >
              Iniciar Sesión
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const projects = projectsQuery.data ?? [];

  return (
    <div className="min-h-screen" style={{ backgroundColor: BRAND.bg }}>
      {/* Header - responsive */}
      <header className="bg-white border-b sticky top-0 z-30" style={{ borderColor: "#E2E8F0" }}>
        <div className="container flex items-center justify-between h-12 sm:h-14 px-3 sm:px-4">
          <div className="flex items-center gap-2 sm:gap-3">
            <ObjetivaLogo size="sm" />
          </div>
          {/* Desktop user info */}
          <div className="hidden sm:flex items-center gap-3">
            <span className="text-sm" style={{ color: "#64748B" }}>{user?.name || user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => logout()}>
              <LogOut className="w-4 h-4" style={{ color: BRAND.navy }} />
            </Button>
          </div>
          {/* Mobile hamburger - RIGHT side */}
          <button
            className="sm:hidden p-2 rounded-lg hover:bg-gray-100"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" style={{ color: BRAND.navy }} /> : <Menu className="w-5 h-5" style={{ color: BRAND.navy }} />}
          </button>
        </div>
        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden border-t px-4 py-3 space-y-2" style={{ borderColor: "#E2E8F0", backgroundColor: "#FFFFFF" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium truncate" style={{ color: BRAND.navy }}>{user?.name || user?.email}</span>
              <Button variant="ghost" size="sm" onClick={() => { logout(); setMobileMenuOpen(false); }}>
                <LogOut className="w-4 h-4 mr-1" style={{ color: BRAND.navy }} />
                <span className="text-xs" style={{ color: BRAND.navy }}>Salir</span>
              </Button>
            </div>
          </div>
        )}
      </header>

      {/* Content - responsive */}
      <main className="container py-4 sm:py-6 lg:py-8 px-3 sm:px-4">
        <div className="flex items-center justify-between mb-4 sm:mb-6">
          <div>
            <h2 className="text-lg sm:text-xl font-bold" style={{ color: BRAND.navy }}>Mis Proyectos</h2>
            <p className="text-xs sm:text-sm mt-0.5 sm:mt-1" style={{ color: "#64748B" }}>{projects.length} proyecto{projects.length !== 1 ? 's' : ''}</p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <Button className="text-white font-medium text-xs sm:text-sm" style={{ backgroundColor: BRAND.teal }}>
                <Plus className="w-4 h-4 mr-1 sm:mr-2" />
                <span className="hidden sm:inline">Nuevo Proyecto</span>
                <span className="sm:hidden">Nuevo</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="mx-4 sm:mx-auto max-w-[calc(100vw-2rem)] sm:max-w-lg">
              <DialogHeader>
                <DialogTitle style={{ color: BRAND.navy }}>
                  {uploadStep === "info" ? "Nuevo Proyecto" : uploadStep === "files" ? "Archivos GLB" : "Subiendo archivos..."}
                </DialogTitle>
              </DialogHeader>

              {/* Step 1: Project info */}
              {uploadStep === "info" && (
                <div className="space-y-4 pt-2">
                  <Input
                    placeholder="Nombre del proyecto"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <Input
                    placeholder="Descripción (opcional)"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                  <Button
                    className="w-full text-white font-medium"
                    style={{ backgroundColor: BRAND.teal }}
                    disabled={!newName.trim()}
                    onClick={() => setUploadStep("files")}
                  >
                    Siguiente: Agregar Archivos
                  </Button>
                </div>
              )}

              {/* Step 2: File selection */}
              {uploadStep === "files" && (
                <div className="space-y-3 pt-2">
                  <p className="text-xs" style={{ color: "#64748B" }}>
                    Arrastra o selecciona archivos GLB por especialidad. Solo las especialidades con archivo serán cargadas.
                  </p>
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                    {fileSlots.map((slot) => (
                      <FileSlotRow
                        key={slot.key}
                        slot={slot}
                        onFileSelect={(file) => handleFileSelect(slot.key, file)}
                        onCustomLabelChange={slot.custom ? (label) => {
                          setFileSlots(prev => prev.map(s => s.key === slot.key ? { ...s, customLabel: label } : s));
                        } : undefined}
                      />
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-xs pt-2" style={{ color: "#64748B" }}>
                    <span>{filesSelected} archivo{filesSelected !== 1 ? 's' : ''} seleccionado{filesSelected !== 1 ? 's' : ''}</span>
                    <span>{(totalSize / (1024 * 1024)).toFixed(1)} MB total</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => setUploadStep("info")}
                    >
                      Atrás
                    </Button>
                    <Button
                      className="flex-1 text-white font-medium"
                      style={{ backgroundColor: BRAND.teal }}
                      disabled={filesSelected === 0 || creating}
                      onClick={handleCreate}
                    >
                      {creating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
                      Crear y Subir
                    </Button>
                  </div>
                </div>
              )}

              {/* Step 3: Uploading progress */}
              {uploadStep === "uploading" && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    {fileSlots.filter((s) => s.file !== null).map((slot) => (
                      <div key={slot.key} className="flex items-center gap-3 p-2.5 rounded-lg" style={{ backgroundColor: BRAND.bg }}>
                        <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: slot.color }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium truncate" style={{ color: BRAND.navy }}>{slot.custom ? (slot.customLabel || slot.key) : slot.label}</span>
                            {slot.status === "done" && <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: "#4CAF50" }} />}
                            {slot.status === "error" && <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-500" />}
                            {slot.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: BRAND.teal }} />}
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-gray-200 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${slot.progress}%`,
                                backgroundColor: slot.status === "error" ? "#EF4444" : slot.status === "done" ? "#4CAF50" : BRAND.teal,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-center" style={{ color: "#94A3B8" }}>
                    No cierres esta ventana mientras se suben los archivos
                  </p>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>

        {projectsQuery.isLoading ? (
          <div className="flex justify-center py-16 sm:py-20">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.teal }} />
          </div>
        ) : projects.length === 0 ? (
          <Card className="border-dashed border-0 shadow-sm">
            <CardContent className="p-8 sm:p-12 text-center">
              <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-xl flex items-center justify-center mb-3 sm:mb-4" style={{ backgroundColor: `${BRAND.teal}10` }}>
                <FolderOpen className="w-7 h-7 sm:w-8 sm:h-8" style={{ color: BRAND.teal }} />
              </div>
              <h3 className="text-base sm:text-lg font-medium mb-2" style={{ color: BRAND.navy }}>Sin proyectos</h3>
              <p className="text-xs sm:text-sm mb-4" style={{ color: "#64748B" }}>Crea tu primer proyecto para comenzar a visualizar modelos BIM</p>
              <Button className="text-white font-medium" style={{ backgroundColor: BRAND.teal }} onClick={() => setDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" /> Crear Proyecto
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="hover:shadow-md transition-shadow cursor-pointer group border-0 shadow-sm active:scale-[0.98] transition-transform overflow-hidden"
                onClick={() => navigate(`/project/${project.id}`)}
                onMouseEnter={() => prefetchProject(project.id)}
                onTouchStart={() => prefetchProject(project.id)}
              >
                {/* Thumbnail */}
                {thumbnails[project.id] ? (
                  <div className="h-32 sm:h-36 w-full overflow-hidden bg-gray-100">
                    <img
                      src={thumbnails[project.id]}
                      alt={project.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  </div>
                ) : (
                  <div className="h-32 sm:h-36 w-full flex items-center justify-center" style={{ backgroundColor: `${BRAND.teal}08` }}>
                    <Box className="w-10 h-10" style={{ color: `${BRAND.teal}30` }} />
                  </div>
                )}
                <CardContent className="p-4 sm:p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-sm sm:text-base truncate" style={{ color: BRAND.navy }}>{project.name}</h3>
                      {project.description && (
                        <p className="text-xs sm:text-sm mt-1 line-clamp-2" style={{ color: "#64748B" }}>{project.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2 sm:mt-3 flex-wrap">
                        <span className={`text-[10px] sm:text-xs px-2 py-0.5 rounded-full font-medium ${
                          project.status === 'ready'
                            ? 'text-white'
                            : project.status === 'processing'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-red-100 text-red-700'
                        }`} style={project.status === 'ready' ? { backgroundColor: BRAND.teal } : {}}>
                          {project.status === 'ready' ? 'Listo' : project.status === 'processing' ? 'Procesando' : 'Error'}
                        </span>
                        {/* Cache status badge */}
                        {cacheStatus[project.id] && (
                          <span className={`text-[10px] sm:text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${
                            cacheStatus[project.id].downloading
                              ? 'bg-blue-50 text-blue-600'
                              : cacheStatus[project.id].cached === cacheStatus[project.id].total && cacheStatus[project.id].total > 0
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-gray-50 text-gray-500'
                          }`}>
                            {cacheStatus[project.id].downloading ? (
                              <><Download className="w-3 h-3 animate-bounce" /> {cacheStatus[project.id].cached}/{cacheStatus[project.id].total}</>
                            ) : cacheStatus[project.id].cached === cacheStatus[project.id].total && cacheStatus[project.id].total > 0 ? (
                              <><HardDrive className="w-3 h-3" /> Offline</>
                            ) : cacheStatus[project.id].total > 0 ? (
                              <><HardDrive className="w-3 h-3" /> {cacheStatus[project.id].cached}/{cacheStatus[project.id].total}</>
                            ) : null}
                          </span>
                        )}
                        <span className="text-[10px] sm:text-xs" style={{ color: "#94A3B8" }}>
                          {new Date(project.createdAt).toLocaleDateString('es-LA')}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive flex-shrink-0 -mr-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("¿Eliminar este proyecto?")) {
                          deleteMutation.mutate({ id: project.id });
                        }
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

/* ─── File Slot Row Component ─── */
function FileSlotRow({ slot, onFileSelect, onCustomLabelChange }: { slot: FileSlot; onFileSelect: (file: File | null) => void; onCustomLabelChange?: (label: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    const name = file?.name.toLowerCase() || "";
    if (file && (name.endsWith(".glb") || name.endsWith(".gltf") || name.endsWith(".ifc") || name.endsWith(".rvt"))) {
      onFileSelect(file);
    } else {
      toast.error("Formatos aceptados: .glb, .gltf, .ifc, .rvt");
    }
  }, [onFileSelect]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  }, [onFileSelect]);

  return (
    <div
      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${dragOver ? "border-solid" : "border-dashed"}`}
      style={{
        borderColor: dragOver ? BRAND.teal : slot.file ? BRAND.teal + "60" : "#E2E8F0",
        backgroundColor: slot.file ? `${BRAND.teal}08` : "transparent",
      }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: slot.color }} />
      <div className="flex-1 min-w-0">
        {slot.custom ? (
          <input
            type="text"
            placeholder="Nombre de especialidad..."
            value={slot.customLabel || ""}
            onChange={(e) => onCustomLabelChange?.(e.target.value)}
            className="text-xs font-medium w-full bg-transparent border-b border-dashed outline-none py-0.5 placeholder:text-gray-400"
            style={{ color: BRAND.navy, borderColor: slot.customLabel ? BRAND.teal + "60" : "#E2E8F0" }}
          />
        ) : (
          <p className="text-xs font-medium truncate" style={{ color: BRAND.navy }}>{slot.label}</p>
        )}
        {slot.file ? (
          <p className="text-[10px] truncate" style={{ color: "#64748B" }}>
            {slot.file.name} ({(slot.file.size / (1024 * 1024)).toFixed(1)} MB)
          </p>
        ) : (
          <p className="text-[10px]" style={{ color: "#94A3B8" }}>
            Arrastra .glb / .ifc / .rvt aquí
          </p>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".glb,.gltf,.ifc,.rvt"
        className="hidden"
        onChange={handleChange}
      />
      {slot.file ? (
        <div className="flex items-center gap-1 flex-shrink-0">
          <FileBox className="w-4 h-4" style={{ color: BRAND.teal }} />
          <button
            className="text-[10px] underline"
            style={{ color: "#94A3B8" }}
            onClick={() => onFileSelect(null)}
          >
            Quitar
          </button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="flex-shrink-0 h-7 px-2"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="w-3.5 h-3.5" style={{ color: BRAND.teal }} />
        </Button>
      )}
    </div>
  );
}
