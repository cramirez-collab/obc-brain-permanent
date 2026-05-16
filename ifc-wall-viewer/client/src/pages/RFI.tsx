import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useRoute, useLocation } from "wouter";
import {
  ArrowLeft, Plus, Send, Pencil, Camera,
  X, AlertCircle, CheckCircle, Clock,
  MessageCircle, Upload, Undo2,
  Circle, Minus,
} from "lucide-react";

const B = {
  navy: "#1B2A4A", teal: "#00A89D", bg: "#F5F7FA",
  cardBg: "#FFFFFF", border: "#E2E8F0", textPrimary: "#1B2A4A",
  textSecondary: "#64748B", red: "#EF4444", orange: "#F59E0B",
};

const RFI_CATEGORIES = ["diseno", "estructura", "instalaciones", "arquitectura", "coordinacion", "otro"] as const;
const RFI_PRIORITIES = ["baja", "media", "alta", "urgente"] as const;
const RFI_STATUSES = ["borrador", "enviada", "en_revision", "respondida", "cerrada"] as const;

const priorityColor: Record<string, string> = {
  baja: "#22C55E", media: "#F59E0B", alta: "#EF4444", urgente: "#DC2626",
};
const statusColor: Record<string, string> = {
  borrador: "#94A3B8", enviada: "#3B82F6", en_revision: "#F59E0B", respondida: "#22C55E", cerrada: "#64748B",
};

// ─── Markup Canvas Component ───
function MarkupEditor({
  imageUrl, onSave, onCancel,
}: { imageUrl: string; onSave: (markupBase64: string, caption: string) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [tool, setTool] = useState<"pen" | "arrow" | "circle">("pen");
  const [color, setColor] = useState("#EF4444");
  const [lineWidth, setLineWidth] = useState(3);
  const [caption, setCaption] = useState("");
  const [imgLoaded, setImgLoaded] = useState(false);
  const pathRef = useRef<{ x: number; y: number }[]>([]);
  const historyRef = useRef<ImageData[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const maxW = Math.min(window.innerWidth - 32, 800);
      const scale = maxW / img.width;
      canvas.width = maxW;
      canvas.height = img.height * scale;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const getPos = (e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const t = "touches" in e ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };

  const startDraw = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    setDrawing(true);
    pathRef.current = [getPos(e)];
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "pen") {
      ctx.beginPath();
      const p = getPos(e);
      ctx.moveTo(p.x, p.y);
    }
  };

  const moveDraw = (e: React.TouchEvent | React.MouseEvent) => {
    if (!drawing) return;
    e.preventDefault();
    const p = getPos(e);
    pathRef.current.push(p);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    if (tool === "pen") {
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  };

  const endDraw = () => {
    if (!drawing) return;
    setDrawing(false);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !canvasRef.current) return;
    const pts = pathRef.current;

    if (tool === "arrow" && pts.length >= 2) {
      const start = pts[0];
      const end = pts[pts.length - 1];
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const headLen = 15;
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else if (tool === "circle" && pts.length >= 2) {
      const start = pts[0];
      const end = pts[pts.length - 1];
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    historyRef.current.push(ctx.getImageData(0, 0, canvasRef.current.width, canvasRef.current.height));
    pathRef.current = [];
  };

  const undo = () => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || historyRef.current.length <= 1) return;
    historyRef.current.pop();
    const prev = historyRef.current[historyRef.current.length - 1];
    ctx.putImageData(prev, 0, 0);
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    onSave(base64, caption);
  };

  const tools = [
    { id: "pen" as const, icon: Pencil, label: "Lápiz" },
    { id: "arrow" as const, icon: Minus, label: "Flecha" },
    { id: "circle" as const, icon: Circle, label: "Círculo" },
  ];
  const colors = ["#EF4444", "#F59E0B", "#22C55E", "#3B82F6", "#FFFFFF", "#000000"];

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: "#111" }}>
      {/* Toolbar - responsive */}
      <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 overflow-x-auto no-scrollbar" style={{ backgroundColor: B.navy }}>
        <button onClick={onCancel} className="p-2 rounded-lg hover:bg-white/10 flex-shrink-0">
          <X className="w-5 h-5 text-white" />
        </button>
        <div className="h-6 w-px bg-white/20 flex-shrink-0" />
        {tools.map(t => (
          <button key={t.id} onClick={() => setTool(t.id)} className="p-2 rounded-lg transition-colors flex-shrink-0" style={{ backgroundColor: tool === t.id ? B.teal : "transparent" }}>
            <t.icon className="w-4 h-4 text-white" />
          </button>
        ))}
        <div className="h-6 w-px bg-white/20 flex-shrink-0" />
        {colors.map(c => (
          <button key={c} onClick={() => setColor(c)} className="w-6 h-6 rounded-full border-2 flex-shrink-0" style={{ backgroundColor: c, borderColor: color === c ? "#FFF" : "transparent" }} />
        ))}
        <div className="h-6 w-px bg-white/20 flex-shrink-0" />
        <button onClick={undo} className="p-2 rounded-lg hover:bg-white/10 flex-shrink-0">
          <Undo2 className="w-4 h-4 text-white" />
        </button>
        <input type="range" min={1} max={8} value={lineWidth} onChange={e => setLineWidth(Number(e.target.value))} className="w-14 sm:w-16 accent-teal-500 flex-shrink-0" />
      </div>

      {/* Canvas */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-2 sm:p-4">
        <canvas ref={canvasRef} className="rounded-lg shadow-2xl max-w-full" style={{ touchAction: "none" }} onMouseDown={startDraw} onMouseMove={moveDraw} onMouseUp={endDraw} onMouseLeave={endDraw} onTouchStart={startDraw} onTouchMove={moveDraw} onTouchEnd={endDraw} />
      </div>

      {/* Caption + Save */}
      <div className="flex items-center gap-2 px-2 sm:px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" style={{ backgroundColor: B.navy }}>
        <input value={caption} onChange={e => setCaption(e.target.value)} placeholder="Agrega una nota..." className="flex-1 px-3 py-2 rounded-full text-xs bg-white/10 text-white border-none focus:outline-none placeholder:text-white/50" />
        <Button size="sm" onClick={handleSave} style={{ backgroundColor: B.teal }} className="text-white rounded-full px-4 flex-shrink-0">
          Guardar
        </Button>
      </div>
    </div>
  );
}

// ─── Main RFI Page ───
export default function RFIPage() {
  const [, params] = useRoute("/project/:id/rfi");
  const [, navigate] = useLocation();
  const projectId = Number(params?.id);
  const { user } = useAuth();

  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showMarkup, setShowMarkup] = useState(false);
  const [markupImageUrl, setMarkupImageUrl] = useState("");

  // Create form
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<typeof RFI_CATEGORIES[number]>("otro");
  const [priority, setPriority] = useState<typeof RFI_PRIORITIES[number]>("media");

  // Chat
  const [chatMsg, setChatMsg] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rfiQuery = trpc.rfi.list.useQuery({ projectId }, { enabled: !!projectId });
  const rfis = rfiQuery.data ?? [];

  const rfiDetailQuery = trpc.rfi.getById.useQuery({ id: selectedId! }, { enabled: !!selectedId });
  const selectedRfi = rfiDetailQuery.data;

  const chatQuery = trpc.chat.list.useQuery({ projectId, rfiId: selectedId ?? undefined }, { enabled: !!selectedId, refetchInterval: 5000 });
  const messages = chatQuery.data ?? [];

  const usersQuery = trpc.users.list.useQuery();
  const allUsers = usersQuery.data ?? [];

  const utils = trpc.useUtils();

  const createRfiMut = trpc.rfi.create.useMutation({
    onSuccess: () => {
      utils.rfi.list.invalidate({ projectId });
      setView("list");
      setSubject(""); setDescription(""); setCategory("otro"); setPriority("media");
    },
  });

  const updateRfiMut = trpc.rfi.update.useMutation({
    onSuccess: () => {
      utils.rfi.list.invalidate({ projectId });
      if (selectedId) utils.rfi.getById.invalidate({ id: selectedId });
    },
  });

  const addAttachmentMut = trpc.rfi.addAttachment.useMutation({
    onSuccess: () => {
      if (selectedId) utils.rfi.getById.invalidate({ id: selectedId });
    },
  });

  const sendMsg = trpc.chat.send.useMutation({
    onSuccess: () => {
      utils.chat.list.invalidate({ projectId, rfiId: selectedId ?? undefined });
      setChatMsg("");
    },
  });

  const uploadImageMut = trpc.chat.uploadImage.useMutation();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const getUserName = useCallback((userId: number | null) => {
    if (!userId) return "Sin asignar";
    const u = allUsers.find(u => u.id === userId);
    return u?.name ?? `Usuario ${userId}`;
  }, [allUsers]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      const url = URL.createObjectURL(file);
      setMarkupImageUrl(url);
      setShowMarkup(true);
      (window as any).__rfiFileBase64 = base64;
      (window as any).__rfiFileName = file.name;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleMarkupSave = async (markupBase64: string, caption: string) => {
    if (!selectedId) return;
    const fileBase64 = (window as any).__rfiFileBase64;
    const fileName = (window as any).__rfiFileName;
    await addAttachmentMut.mutateAsync({ rfiId: selectedId, fileBase64, fileName, markupBase64, caption });
    setShowMarkup(false);
    setMarkupImageUrl("");
  };

  const handleCameraCapture = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.onchange = (e) => handleFileUpload(e as any);
    input.click();
  };

  // Markup overlay
  if (showMarkup && markupImageUrl) {
    return <MarkupEditor imageUrl={markupImageUrl} onSave={handleMarkupSave} onCancel={() => { setShowMarkup(false); setMarkupImageUrl(""); }} />;
  }

  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 1024;

  // ─── DESKTOP: Two-column layout ───
  if (isDesktop) {
    return (
      <div className="h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
        <header className="sticky top-0 z-20 px-6 py-3 flex items-center gap-4 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => navigate(`/project/${projectId}`)} className="p-2 rounded-lg hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" style={{ color: B.navy }} />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold" style={{ color: B.navy }}>RFI - Solicitudes de Información</h1>
            <p className="text-xs" style={{ color: B.textSecondary }}>{rfis.length} solicitudes</p>
          </div>
          <Button size="sm" onClick={() => setView("create")} style={{ backgroundColor: B.teal }} className="text-white gap-1">
            <Plus className="w-4 h-4" /> Nueva RFI
          </Button>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {/* Left: List */}
          <div className="w-[380px] xl:w-[420px] border-r overflow-y-auto p-4 space-y-2" style={{ borderColor: B.border }}>
            {rfis.length === 0 && (
              <div className="text-center py-16">
                <AlertCircle className="w-10 h-10 mx-auto mb-3" style={{ color: B.textSecondary }} />
                <p className="text-sm" style={{ color: B.textSecondary }}>No hay RFIs</p>
              </div>
            )}
            {rfis.map(rfi => {
              const isActive = rfi.id === selectedId;
              return (
                <button key={rfi.id} onClick={() => { setSelectedId(rfi.id); setView("detail"); }} className="w-full text-left p-3 rounded-xl shadow-sm hover:shadow-md transition-all" style={{ backgroundColor: isActive ? `${B.teal}08` : B.cardBg, border: `1px solid ${isActive ? B.teal : B.border}` }}>
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: B.teal }}>#{rfi.number}</div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold truncate block" style={{ color: B.navy }}>{rfi.subject}</span>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${statusColor[rfi.status]}20`, color: statusColor[rfi.status] }}>{rfi.status.replace("_", " ")}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${priorityColor[rfi.priority]}20`, color: priorityColor[rfi.priority] }}>{rfi.priority}</span>
                      </div>
                      <p className="text-[10px] mt-1" style={{ color: B.textSecondary }}>{new Date(rfi.createdAt).toLocaleDateString("es-MX")}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Detail / Create / Empty */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {view === "create" ? (
              <>
                <div className="px-6 py-4 flex items-center gap-3" style={{ borderBottom: `1px solid ${B.border}`, backgroundColor: B.cardBg }}>
                  <button onClick={() => setView("list")} className="p-1 rounded hover:bg-gray-100"><X className="w-4 h-4" style={{ color: B.navy }} /></button>
                  <h2 className="text-base font-bold" style={{ color: B.navy }}>Nueva RFI</h2>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Asunto *</label>
                    <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Pregunta o solicitud" className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Descripción</label>
                    <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Detalla la solicitud..." rows={4} className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2 resize-none" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Categoría</label>
                      <select value={category} onChange={e => setCategory(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                        {RFI_CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Prioridad</label>
                      <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                        {RFI_PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                      </select>
                    </div>
                  </div>
                  <Button className="w-full text-white py-3 rounded-xl" style={{ backgroundColor: B.teal }} disabled={!subject.trim() || createRfiMut.isPending} onClick={() => createRfiMut.mutate({ projectId, subject, description, category, priority })}>
                    {createRfiMut.isPending ? "Creando..." : "Crear RFI"}
                  </Button>
                </div>
              </>
            ) : selectedId && selectedRfi ? (
              <>
                {/* Detail header */}
                <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${B.border}`, backgroundColor: B.cardBg }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-md text-white" style={{ backgroundColor: B.teal }}>#{selectedRfi.number}</span>
                      <h2 className="text-base font-bold truncate" style={{ color: B.navy }}>{selectedRfi.subject}</h2>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${statusColor[selectedRfi.status]}20`, color: statusColor[selectedRfi.status] }}>{selectedRfi.status.replace("_", " ")}</span>
                      <span className="text-[10px]" style={{ color: B.textSecondary }}>por {getUserName(selectedRfi.createdByUserId)} · {new Date(selectedRfi.createdAt).toLocaleString("es-MX")}</span>
                    </div>
                  </div>
                  <select value={selectedRfi.status} onChange={e => { if (selectedId) updateRfiMut.mutate({ id: selectedId, status: e.target.value as any }); }} className="text-xs px-2 py-1.5 rounded-lg border font-medium" style={{ borderColor: B.border, color: B.teal }}>
                    {RFI_STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                  </select>
                </div>
                {/* Description + Attachments */}
                <div className="px-6 py-3 space-y-3" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
                  {selectedRfi.description && <p className="text-xs" style={{ color: B.textSecondary }}>{selectedRfi.description}</p>}
                  {selectedRfi.attachments && selectedRfi.attachments.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold" style={{ color: B.navy }}>Adjuntos ({selectedRfi.attachments.length})</p>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {selectedRfi.attachments.map((att: any) => (
                          <div key={att.id} className="flex-shrink-0 w-24 rounded-lg overflow-hidden border" style={{ borderColor: B.border }}>
                            <img src={att.markupUrl || att.imageUrl} alt={att.caption || "Adjunto"} className="w-24 h-24 object-cover cursor-pointer" onClick={() => window.open(att.markupUrl || att.imageUrl, "_blank")} />
                            {att.caption && <p className="text-[9px] px-1 py-0.5 truncate" style={{ color: B.textSecondary }}>{att.caption}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                    <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium border" style={{ borderColor: B.border, color: B.teal }}>
                      <Upload className="w-3.5 h-3.5" /> Subir foto
                    </button>
                    <button onClick={handleCameraCapture} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium border" style={{ borderColor: B.border, color: B.teal }}>
                      <Camera className="w-3.5 h-3.5" /> Tomar foto
                    </button>
                  </div>
                </div>
                {/* Chat */}
                <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2">
                  {messages.length === 0 && (
                    <div className="text-center py-8">
                      <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: B.textSecondary }} />
                      <p className="text-xs" style={{ color: B.textSecondary }}>Discute esta RFI con tu equipo</p>
                    </div>
                  )}
                  {messages.map(msg => {
                    const isMe = msg.userId === user?.id;
                    return (
                      <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[65%] px-3 py-2 rounded-2xl shadow-sm" style={{ backgroundColor: isMe ? B.teal : B.cardBg, color: isMe ? "#FFFFFF" : B.textPrimary, border: isMe ? "none" : `1px solid ${B.border}`, borderBottomRightRadius: isMe ? "4px" : "16px", borderBottomLeftRadius: isMe ? "16px" : "4px" }}>
                          {!isMe && <p className="text-[10px] font-semibold mb-0.5" style={{ color: B.teal }}>{getUserName(msg.userId)}</p>}
                          {msg.imageUrl && <img src={msg.imageUrl} alt="" className="rounded-lg mb-1 max-h-40 object-cover cursor-pointer" onClick={() => window.open(msg.imageUrl!, "_blank")} />}
                          <p className="text-xs whitespace-pre-wrap">{msg.message}</p>
                          <p className="text-[9px] mt-0.5 text-right" style={{ opacity: 0.6 }}>{new Date(msg.createdAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</p>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
                {/* Chat input */}
                <div className="px-4 py-3 flex items-center gap-2" style={{ backgroundColor: B.cardBg, borderTop: `1px solid ${B.border}` }}>
                  <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && chatMsg.trim()) { e.preventDefault(); sendMsg.mutate({ projectId, rfiId: selectedId ?? undefined, message: chatMsg.trim() }); } }} placeholder="Escribe un mensaje..." className="flex-1 px-4 py-2.5 rounded-full text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  <button onClick={() => { if (chatMsg.trim()) sendMsg.mutate({ projectId, rfiId: selectedId ?? undefined, message: chatMsg.trim() }); }} disabled={!chatMsg.trim() || sendMsg.isPending} className="p-2.5 rounded-full transition-opacity disabled:opacity-40" style={{ backgroundColor: B.teal }}>
                    <Send className="w-4 h-4 text-white" />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <MessageCircle className="w-12 h-12 mx-auto mb-3" style={{ color: B.textSecondary }} />
                  <p className="text-sm" style={{ color: B.textSecondary }}>Selecciona una RFI para ver el detalle</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── MOBILE/TABLET ───

  // CREATE
  if (view === "create") {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
        <header className="sticky top-0 z-20 px-4 py-3 flex items-center gap-3 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => setView("list")} className="p-2 rounded-lg hover:bg-gray-100"><ArrowLeft className="w-5 h-5" style={{ color: B.navy }} /></button>
          <h1 className="text-base font-bold" style={{ color: B.navy }}>Nueva RFI</h1>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Asunto *</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Pregunta o solicitud" className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Descripción</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Detalla la solicitud..." rows={4} className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2 resize-none" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Categoría</label>
              <select value={category} onChange={e => setCategory(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                {RFI_CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Prioridad</label>
              <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                {RFI_PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" style={{ backgroundColor: B.cardBg, borderTop: `1px solid ${B.border}` }}>
          <Button className="w-full text-white py-3 rounded-xl" style={{ backgroundColor: B.teal }} disabled={!subject.trim() || createRfiMut.isPending} onClick={() => createRfiMut.mutate({ projectId, subject, description, category, priority })}>
            {createRfiMut.isPending ? "Creando..." : "Crear RFI"}
          </Button>
        </div>
      </div>
    );
  }

  // DETAIL
  if (view === "detail" && selectedRfi) {
    return (
      <div className="h-[100dvh] flex flex-col" style={{ backgroundColor: B.bg }}>
        <header className="sticky top-0 z-20 px-3 sm:px-4 py-2.5 flex items-center gap-2 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => { setView("list"); setSelectedId(null); }} className="p-2 rounded-lg hover:bg-gray-100 flex-shrink-0"><ArrowLeft className="w-5 h-5" style={{ color: B.navy }} /></button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold px-2 py-0.5 rounded-md text-white flex-shrink-0" style={{ backgroundColor: B.teal }}>#{selectedRfi.number}</span>
              <h1 className="text-sm font-bold truncate" style={{ color: B.navy }}>{selectedRfi.subject}</h1>
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${statusColor[selectedRfi.status]}20`, color: statusColor[selectedRfi.status] }}>{selectedRfi.status.replace("_", " ")}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${priorityColor[selectedRfi.priority]}20`, color: priorityColor[selectedRfi.priority] }}>{selectedRfi.priority}</span>
            </div>
          </div>
          <select value={selectedRfi.status} onChange={e => { if (selectedId) updateRfiMut.mutate({ id: selectedId, status: e.target.value as any }); }} className="text-[11px] px-2 py-1.5 rounded-lg border font-medium flex-shrink-0" style={{ borderColor: B.border, color: B.teal }}>
            {RFI_STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </header>

        {/* Description + Attachments */}
        <div className="px-3 sm:px-4 py-2.5 space-y-2.5" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          {selectedRfi.description && <p className="text-xs" style={{ color: B.textSecondary }}>{selectedRfi.description}</p>}
          <p className="text-[10px]" style={{ color: B.textSecondary }}>por {getUserName(selectedRfi.createdByUserId)} · {new Date(selectedRfi.createdAt).toLocaleString("es-MX")}</p>
          {selectedRfi.attachments && selectedRfi.attachments.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold" style={{ color: B.navy }}>Adjuntos ({selectedRfi.attachments.length})</p>
              <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                {selectedRfi.attachments.map((att: any) => (
                  <div key={att.id} className="flex-shrink-0 w-20 sm:w-24 rounded-lg overflow-hidden border" style={{ borderColor: B.border }}>
                    <img src={att.markupUrl || att.imageUrl} alt={att.caption || "Adjunto"} className="w-20 h-20 sm:w-24 sm:h-24 object-cover cursor-pointer" onClick={() => window.open(att.markupUrl || att.imageUrl, "_blank")} />
                    {att.caption && <p className="text-[9px] px-1 py-0.5 truncate" style={{ color: B.textSecondary }}>{att.caption}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border" style={{ borderColor: B.border, color: B.teal }}>
              <Upload className="w-3.5 h-3.5" /> Subir
            </button>
            <button onClick={handleCameraCapture} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border" style={{ borderColor: B.border, color: B.teal }}>
              <Camera className="w-3.5 h-3.5" /> Foto
            </button>
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: B.textSecondary }} />
              <p className="text-xs" style={{ color: B.textSecondary }}>Discute esta RFI con tu equipo</p>
            </div>
          )}
          {messages.map(msg => {
            const isMe = msg.userId === user?.id;
            return (
              <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[80%] sm:max-w-[70%] px-3 py-2 rounded-2xl shadow-sm" style={{ backgroundColor: isMe ? B.teal : B.cardBg, color: isMe ? "#FFFFFF" : B.textPrimary, border: isMe ? "none" : `1px solid ${B.border}`, borderBottomRightRadius: isMe ? "4px" : "16px", borderBottomLeftRadius: isMe ? "16px" : "4px" }}>
                  {!isMe && <p className="text-[10px] font-semibold mb-0.5" style={{ color: B.teal }}>{getUserName(msg.userId)}</p>}
                  {msg.imageUrl && <img src={msg.imageUrl} alt="" className="rounded-lg mb-1 max-h-40 object-cover cursor-pointer" onClick={() => window.open(msg.imageUrl!, "_blank")} />}
                  <p className="text-xs whitespace-pre-wrap">{msg.message}</p>
                  <p className="text-[9px] mt-0.5 text-right" style={{ opacity: 0.6 }}>{new Date(msg.createdAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>

        {/* Chat input */}
        <div className="sticky bottom-0 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-2" style={{ backgroundColor: B.cardBg, borderTop: `1px solid ${B.border}` }}>
          <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && chatMsg.trim()) { e.preventDefault(); sendMsg.mutate({ projectId, rfiId: selectedId ?? undefined, message: chatMsg.trim() }); } }} placeholder="Escribe un mensaje..." className="flex-1 px-3 py-2.5 rounded-full text-xs border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          <button onClick={() => { if (chatMsg.trim()) sendMsg.mutate({ projectId, rfiId: selectedId ?? undefined, message: chatMsg.trim() }); }} disabled={!chatMsg.trim() || sendMsg.isPending} className="p-2.5 rounded-full transition-opacity disabled:opacity-40 flex-shrink-0" style={{ backgroundColor: B.teal }}>
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    );
  }

  // LIST
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
      <header className="sticky top-0 z-20 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
        <button onClick={() => navigate(`/project/${projectId}`)} className="p-2 rounded-lg hover:bg-gray-100"><ArrowLeft className="w-5 h-5" style={{ color: B.navy }} /></button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold" style={{ color: B.navy }}>RFI</h1>
          <p className="text-xs" style={{ color: B.textSecondary }}>{rfis.length} solicitudes</p>
        </div>
        <Button size="sm" onClick={() => setView("create")} style={{ backgroundColor: B.teal }} className="text-white gap-1 text-xs">
          <Plus className="w-4 h-4" /> Nueva
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
        {rfis.length === 0 && (
          <div className="text-center py-16">
            <AlertCircle className="w-10 h-10 mx-auto mb-3" style={{ color: B.textSecondary }} />
            <p className="text-sm" style={{ color: B.textSecondary }}>No hay RFIs registradas</p>
          </div>
        )}
        {rfis.map(rfi => (
          <button key={rfi.id} onClick={() => { setSelectedId(rfi.id); setView("detail"); }} className="w-full text-left p-3 rounded-xl shadow-sm hover:shadow-md transition-shadow active:scale-[0.98]" style={{ backgroundColor: B.cardBg, border: `1px solid ${B.border}` }}>
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: B.teal }}>#{rfi.number}</div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold truncate block" style={{ color: B.navy }}>{rfi.subject}</span>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${statusColor[rfi.status]}20`, color: statusColor[rfi.status] }}>{rfi.status.replace("_", " ")}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${priorityColor[rfi.priority]}20`, color: priorityColor[rfi.priority] }}>{rfi.priority}</span>
                  <span className="text-[10px]" style={{ color: B.textSecondary }}>{rfi.category}</span>
                </div>
                <p className="text-[10px] mt-1" style={{ color: B.textSecondary }}>
                  {new Date(rfi.createdAt).toLocaleDateString("es-MX")}
                  {rfi.dueDate && ` · Vence: ${new Date(rfi.dueDate).toLocaleDateString("es-MX")}`}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
