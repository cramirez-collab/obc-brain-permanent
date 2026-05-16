import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useRoute, useLocation } from "wouter";
import {
  ArrowLeft, Plus, Send, MessageCircle, AlertTriangle,
  CheckCircle, Clock, X,
} from "lucide-react";

/* ─── Objetiva Brand ─── */
const B = {
  navy: "#1B2A4A", teal: "#00A89D", bg: "#F5F7FA",
  cardBg: "#FFFFFF", border: "#E2E8F0", textPrimary: "#1B2A4A",
  textSecondary: "#64748B",
};

const CATEGORIES = ["general", "estructura", "arquitectura", "instalaciones", "seguridad", "calidad"] as const;
const PRIORITIES = ["baja", "media", "alta", "critica"] as const;
const STATUSES = ["abierta", "en_revision", "resuelta", "cerrada"] as const;

const priorityColor: Record<string, string> = {
  baja: "#22C55E", media: "#F59E0B", alta: "#EF4444", critica: "#DC2626",
};
const statusIcon: Record<string, typeof Clock> = {
  abierta: Clock, en_revision: AlertTriangle, resuelta: CheckCircle, cerrada: CheckCircle,
};

export default function Bitacora() {
  const [, params] = useRoute("/project/:id/bitacora");
  const [, navigate] = useLocation();
  const projectId = Number(params?.id);
  const { user } = useAuth();

  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  // Create form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<typeof CATEGORIES[number]>("general");
  const [priority, setPriority] = useState<typeof PRIORITIES[number]>("media");

  // Chat
  const [chatMsg, setChatMsg] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const obsQuery = trpc.observation.list.useQuery({ projectId }, { enabled: !!projectId });
  const observations = obsQuery.data ?? [];

  const chatQuery = trpc.chat.list.useQuery(
    { projectId, observationId: selectedId ?? undefined },
    { enabled: !!selectedId, refetchInterval: 5000 }
  );
  const messages = chatQuery.data ?? [];

  const usersQuery = trpc.users.list.useQuery();
  const allUsers = usersQuery.data ?? [];

  const utils = trpc.useUtils();

  const createObs = trpc.observation.create.useMutation({
    onSuccess: () => {
      utils.observation.list.invalidate({ projectId });
      setView("list");
      setTitle(""); setDescription(""); setCategory("general"); setPriority("media");
    },
  });

  const updateObs = trpc.observation.update.useMutation({
    onSuccess: () => {
      utils.observation.list.invalidate({ projectId });
    },
  });

  const sendMsg = trpc.chat.send.useMutation({
    onSuccess: () => {
      utils.chat.list.invalidate({ projectId, observationId: selectedId ?? undefined });
      setChatMsg("");
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const getUserName = useCallback((userId: number) => {
    const u = allUsers.find(u => u.id === userId);
    return u?.name ?? `Usuario ${userId}`;
  }, [allUsers]);

  const filtered = observations.filter(o => {
    if (filterCategory !== "all" && o.category !== filterCategory) return false;
    if (filterStatus !== "all" && o.status !== filterStatus) return false;
    return true;
  });

  const selectedObs = observations.find(o => o.id === selectedId);

  // Detect desktop for two-column layout
  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 1024;

  // ─── DESKTOP: Two-column layout (list + detail side by side) ───
  if (isDesktop) {
    return (
      <div className="h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
        {/* Header */}
        <header className="sticky top-0 z-20 px-6 py-3 flex items-center gap-4 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => navigate(`/project/${projectId}`)} className="p-2 rounded-lg hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" style={{ color: B.navy }} />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold" style={{ color: B.navy }}>Bitácora de Observaciones</h1>
            <p className="text-xs" style={{ color: B.textSecondary }}>{filtered.length} observaciones</p>
          </div>
          {/* Filters */}
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="text-xs px-3 py-2 rounded-lg border" style={{ borderColor: B.border, color: B.textPrimary }}>
            <option value="all">Todas las categorías</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
          </select>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="text-xs px-3 py-2 rounded-lg border" style={{ borderColor: B.border, color: B.textPrimary }}>
            <option value="all">Todos los estados</option>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
          <Button size="sm" onClick={() => setView("create")} style={{ backgroundColor: B.teal }} className="text-white gap-1">
            <Plus className="w-4 h-4" /> Nueva
          </Button>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {/* Left: List */}
          <div className="w-[380px] xl:w-[420px] border-r overflow-y-auto p-4 space-y-2" style={{ borderColor: B.border }}>
            {filtered.length === 0 && (
              <div className="text-center py-16">
                <AlertTriangle className="w-10 h-10 mx-auto mb-3" style={{ color: B.textSecondary }} />
                <p className="text-sm" style={{ color: B.textSecondary }}>No hay observaciones</p>
              </div>
            )}
            {filtered.map(obs => {
              const StatusIcon = statusIcon[obs.status] ?? Clock;
              const isActive = obs.id === selectedId;
              return (
                <button
                  key={obs.id}
                  onClick={() => { setSelectedId(obs.id); setView("detail"); }}
                  className="w-full text-left p-3 rounded-xl shadow-sm hover:shadow-md transition-all"
                  style={{
                    backgroundColor: isActive ? `${B.teal}08` : B.cardBg,
                    border: `1px solid ${isActive ? B.teal : B.border}`,
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full mt-2 flex-shrink-0" style={{ backgroundColor: priorityColor[obs.priority] }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate" style={{ color: B.navy }}>{obs.title}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0" style={{ backgroundColor: `${priorityColor[obs.priority]}20`, color: priorityColor[obs.priority] }}>
                          {obs.priority}
                        </span>
                      </div>
                      <p className="text-xs mt-0.5 truncate" style={{ color: B.textSecondary }}>{obs.description || "Sin descripción"}</p>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ backgroundColor: `${B.teal}15`, color: B.teal }}>{obs.category}</span>
                        <span className="flex items-center gap-1 text-[10px]" style={{ color: B.textSecondary }}>
                          <StatusIcon className="w-3 h-3" /> {obs.status.replace("_", " ")}
                        </span>
                        <span className="text-[10px]" style={{ color: B.textSecondary }}>
                          {new Date(obs.createdAt).toLocaleDateString("es-MX")}
                        </span>
                      </div>
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
                  <h2 className="text-base font-bold" style={{ color: B.navy }}>Nueva Observación</h2>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Título *</label>
                    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Describe brevemente la observación" className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Descripción</label>
                    <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Detalla la observación..." rows={4} className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2 resize-none" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Categoría</label>
                      <select value={category} onChange={e => setCategory(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Prioridad</label>
                      <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                        {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                      </select>
                    </div>
                  </div>
                  <Button className="w-full text-white py-3 rounded-xl" style={{ backgroundColor: B.teal }} disabled={!title.trim() || createObs.isPending} onClick={() => createObs.mutate({ projectId, title, description, category, priority })}>
                    {createObs.isPending ? "Guardando..." : "Registrar Observación"}
                  </Button>
                </div>
              </>
            ) : selectedId && selectedObs ? (
              <>
                {/* Detail header */}
                <div className="px-6 py-3 flex items-center gap-3" style={{ borderBottom: `1px solid ${B.border}`, backgroundColor: B.cardBg }}>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-base font-bold truncate" style={{ color: B.navy }}>{selectedObs.title}</h2>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${priorityColor[selectedObs.priority]}20`, color: priorityColor[selectedObs.priority] }}>{selectedObs.priority}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ backgroundColor: `${B.teal}15`, color: B.teal }}>{selectedObs.category}</span>
                      <span className="text-[10px]" style={{ color: B.textSecondary }}>por {getUserName(selectedObs.userId)} · {new Date(selectedObs.createdAt).toLocaleString("es-MX")}</span>
                    </div>
                  </div>
                  <select value={selectedObs.status} onChange={e => { if (selectedId) updateObs.mutate({ id: selectedId, status: e.target.value as any }); }} className="text-xs px-2 py-1.5 rounded-lg border font-medium" style={{ borderColor: B.border, color: B.teal }}>
                    {STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                  </select>
                </div>
                {selectedObs.description && (
                  <div className="px-6 py-2" style={{ borderBottom: `1px solid ${B.border}` }}>
                    <p className="text-xs" style={{ color: B.textSecondary }}>{selectedObs.description}</p>
                  </div>
                )}
                {/* Chat */}
                <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2">
                  {messages.length === 0 && (
                    <div className="text-center py-8">
                      <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: B.textSecondary }} />
                      <p className="text-xs" style={{ color: B.textSecondary }}>Inicia la conversación sobre esta observación</p>
                    </div>
                  )}
                  {messages.map(msg => {
                    const isMe = msg.userId === user?.id;
                    return (
                      <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                        <div className="max-w-[65%] px-3 py-2 rounded-2xl shadow-sm" style={{ backgroundColor: isMe ? B.teal : B.cardBg, color: isMe ? "#FFFFFF" : B.textPrimary, border: isMe ? "none" : `1px solid ${B.border}`, borderBottomRightRadius: isMe ? "4px" : "16px", borderBottomLeftRadius: isMe ? "16px" : "4px" }}>
                          {!isMe && <p className="text-[10px] font-semibold mb-0.5" style={{ color: B.teal }}>{getUserName(msg.userId)}</p>}
                          {msg.imageUrl && <img src={msg.imageUrl} alt="" className="rounded-lg mb-1 max-h-40 object-cover" />}
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
                  <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && chatMsg.trim()) { e.preventDefault(); sendMsg.mutate({ projectId, observationId: selectedId ?? undefined, message: chatMsg.trim() }); } }} placeholder="Escribe un mensaje..." className="flex-1 px-4 py-2.5 rounded-full text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
                  <button onClick={() => { if (chatMsg.trim()) sendMsg.mutate({ projectId, observationId: selectedId ?? undefined, message: chatMsg.trim() }); }} disabled={!chatMsg.trim() || sendMsg.isPending} className="p-2.5 rounded-full transition-opacity disabled:opacity-40" style={{ backgroundColor: B.teal }}>
                    <Send className="w-4 h-4 text-white" />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <MessageCircle className="w-12 h-12 mx-auto mb-3" style={{ color: B.textSecondary }} />
                  <p className="text-sm" style={{ color: B.textSecondary }}>Selecciona una observación para ver el detalle</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── MOBILE/TABLET: Single column views ───

  // ─── CREATE VIEW ───
  if (view === "create") {
    return (
      <div className="min-h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
        <header className="sticky top-0 z-20 px-4 py-3 flex items-center gap-3 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => setView("list")} className="p-2 rounded-lg hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" style={{ color: B.navy }} />
          </button>
          <h1 className="text-base font-bold" style={{ color: B.navy }}>Nueva Observación</h1>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Título *</label>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Describe brevemente la observación" className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Descripción</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Detalla la observación..." rows={4} className="w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2 resize-none" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Categoría</label>
              <select value={category} onChange={e => setCategory(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block" style={{ color: B.textSecondary }}>Prioridad</label>
              <select value={priority} onChange={e => setPriority(e.target.value as any)} className="w-full px-3 py-2.5 rounded-xl text-sm border" style={{ borderColor: B.border, color: B.textPrimary }}>
                {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="p-4 safe-area-bottom" style={{ backgroundColor: B.cardBg, borderTop: `1px solid ${B.border}` }}>
          <Button className="w-full text-white py-3 rounded-xl" style={{ backgroundColor: B.teal }} disabled={!title.trim() || createObs.isPending} onClick={() => createObs.mutate({ projectId, title, description, category, priority })}>
            {createObs.isPending ? "Guardando..." : "Registrar Observación"}
          </Button>
        </div>
      </div>
    );
  }

  // ─── DETAIL VIEW (with chat) ───
  if (view === "detail" && selectedObs) {
    return (
      <div className="h-[100dvh] flex flex-col" style={{ backgroundColor: B.bg }}>
        <header className="sticky top-0 z-20 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
          <button onClick={() => { setView("list"); setSelectedId(null); }} className="p-2 rounded-lg hover:bg-gray-100 flex-shrink-0">
            <ArrowLeft className="w-5 h-5" style={{ color: B.navy }} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-bold truncate" style={{ color: B.navy }}>{selectedObs.title}</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${priorityColor[selectedObs.priority]}20`, color: priorityColor[selectedObs.priority] }}>{selectedObs.priority}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ backgroundColor: `${B.teal}15`, color: B.teal }}>{selectedObs.category}</span>
            </div>
          </div>
          <select value={selectedObs.status} onChange={e => { if (selectedId) updateObs.mutate({ id: selectedId, status: e.target.value as any }); }} className="text-[11px] px-2 py-1.5 rounded-lg border font-medium flex-shrink-0" style={{ borderColor: B.border, color: B.teal }}>
            {STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </header>

        {selectedObs.description && (
          <div className="px-4 py-2.5" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
            <p className="text-xs" style={{ color: B.textSecondary }}>{selectedObs.description}</p>
            <p className="text-[10px] mt-1" style={{ color: B.textSecondary }}>
              por {getUserName(selectedObs.userId)} · {new Date(selectedObs.createdAt).toLocaleString("es-MX")}
            </p>
          </div>
        )}

        {/* Chat messages */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <MessageCircle className="w-8 h-8 mx-auto mb-2" style={{ color: B.textSecondary }} />
              <p className="text-xs" style={{ color: B.textSecondary }}>Inicia la conversación</p>
            </div>
          )}
          {messages.map(msg => {
            const isMe = msg.userId === user?.id;
            return (
              <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[80%] sm:max-w-[70%] px-3 py-2 rounded-2xl shadow-sm" style={{ backgroundColor: isMe ? B.teal : B.cardBg, color: isMe ? "#FFFFFF" : B.textPrimary, border: isMe ? "none" : `1px solid ${B.border}`, borderBottomRightRadius: isMe ? "4px" : "16px", borderBottomLeftRadius: isMe ? "16px" : "4px" }}>
                  {!isMe && <p className="text-[10px] font-semibold mb-0.5" style={{ color: B.teal }}>{getUserName(msg.userId)}</p>}
                  {msg.imageUrl && <img src={msg.imageUrl} alt="" className="rounded-lg mb-1 max-h-40 object-cover" />}
                  <p className="text-xs whitespace-pre-wrap">{msg.message}</p>
                  <p className="text-[9px] mt-0.5 text-right" style={{ opacity: 0.6 }}>{new Date(msg.createdAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>

        {/* Chat input - NOT fixed, uses sticky bottom with safe area */}
        <div className="sticky bottom-0 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-2" style={{ backgroundColor: B.cardBg, borderTop: `1px solid ${B.border}` }}>
          <input value={chatMsg} onChange={e => setChatMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && chatMsg.trim()) { e.preventDefault(); sendMsg.mutate({ projectId, observationId: selectedId ?? undefined, message: chatMsg.trim() }); } }} placeholder="Escribe un mensaje..." className="flex-1 px-3 py-2.5 rounded-full text-xs border focus:outline-none focus:ring-2" style={{ borderColor: B.border, color: B.textPrimary, "--tw-ring-color": B.teal } as any} />
          <button onClick={() => { if (chatMsg.trim()) sendMsg.mutate({ projectId, observationId: selectedId ?? undefined, message: chatMsg.trim() }); }} disabled={!chatMsg.trim() || sendMsg.isPending} className="p-2.5 rounded-full transition-opacity disabled:opacity-40 flex-shrink-0" style={{ backgroundColor: B.teal }}>
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    );
  }

  // ─── LIST VIEW (mobile/tablet) ───
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: B.bg }}>
      <header className="sticky top-0 z-20 px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3 shadow-sm" style={{ backgroundColor: B.cardBg, borderBottom: `1px solid ${B.border}` }}>
        <button onClick={() => navigate(`/project/${projectId}`)} className="p-2 rounded-lg hover:bg-gray-100">
          <ArrowLeft className="w-5 h-5" style={{ color: B.navy }} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold" style={{ color: B.navy }}>Bitácora</h1>
          <p className="text-xs" style={{ color: B.textSecondary }}>{filtered.length} observaciones</p>
        </div>
        <Button size="sm" onClick={() => setView("create")} style={{ backgroundColor: B.teal }} className="text-white gap-1 text-xs">
          <Plus className="w-4 h-4" /> Nueva
        </Button>
      </header>

      {/* Filters - horizontal scroll */}
      <div className="px-3 sm:px-4 py-2 flex gap-2 overflow-x-auto no-scrollbar" style={{ backgroundColor: B.cardBg }}>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border flex-shrink-0" style={{ borderColor: B.border, color: B.textPrimary }}>
          <option value="all">Categoría</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border flex-shrink-0" style={{ borderColor: B.border, color: B.textPrimary }}>
          <option value="all">Estado</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-16">
            <AlertTriangle className="w-10 h-10 mx-auto mb-3" style={{ color: B.textSecondary }} />
            <p className="text-sm" style={{ color: B.textSecondary }}>No hay observaciones registradas</p>
          </div>
        )}
        {filtered.map(obs => {
          const StatusIcon = statusIcon[obs.status] ?? Clock;
          return (
            <button
              key={obs.id}
              onClick={() => { setSelectedId(obs.id); setView("detail"); }}
              className="w-full text-left p-3 rounded-xl shadow-sm hover:shadow-md transition-shadow active:scale-[0.98]"
              style={{ backgroundColor: B.cardBg, border: `1px solid ${B.border}` }}
            >
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full mt-2 flex-shrink-0" style={{ backgroundColor: priorityColor[obs.priority] }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold truncate" style={{ color: B.navy }}>{obs.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0" style={{ backgroundColor: `${priorityColor[obs.priority]}20`, color: priorityColor[obs.priority] }}>{obs.priority}</span>
                  </div>
                  <p className="text-xs mt-0.5 truncate" style={{ color: B.textSecondary }}>{obs.description || "Sin descripción"}</p>
                  <div className="flex items-center gap-2 sm:gap-3 mt-1.5 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md" style={{ backgroundColor: `${B.teal}15`, color: B.teal }}>{obs.category}</span>
                    <span className="flex items-center gap-1 text-[10px]" style={{ color: B.textSecondary }}>
                      <StatusIcon className="w-3 h-3" /> {obs.status.replace("_", " ")}
                    </span>
                    <span className="text-[10px]" style={{ color: B.textSecondary }}>{new Date(obs.createdAt).toLocaleDateString("es-MX")}</span>
                  </div>
                </div>
                <MessageCircle className="w-4 h-4 flex-shrink-0 mt-1" style={{ color: B.textSecondary }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
