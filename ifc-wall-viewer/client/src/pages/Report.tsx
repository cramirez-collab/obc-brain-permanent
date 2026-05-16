import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Download, FileText, AlertTriangle, CheckCircle, Clock, MessageSquare, Loader2 } from "lucide-react";
import { useRef } from "react";

const BRAND = {
  navy: "#1B2A4A",
  teal: "#00A89D",
  bg: "#F5F7FA",
  cardBg: "#FFFFFF",
};

const statusColors: Record<string, string> = {
  abierta: "#EF4444",
  en_revision: "#F59E0B",
  resuelta: "#10B981",
  cerrada: "#6B7280",
  borrador: "#9CA3AF",
  enviada: "#3B82F6",
  respondida: "#10B981",
};

const priorityLabels: Record<string, string> = {
  baja: "Baja",
  media: "Media",
  alta: "Alta",
  critica: "Crítica",
  urgente: "Urgente",
};

export default function Report() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/project/:id/report");
  const projectId = Number(params?.id);
  const printRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = trpc.report.getData.useQuery(
    { projectId },
    { enabled: !!projectId }
  );

  const handlePrint = () => {
    window.print();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: BRAND.bg }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.teal }} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: BRAND.bg }}>
        <p style={{ color: BRAND.navy }}>Proyecto no encontrado</p>
      </div>
    );
  }

  const { project, files, observations, rfis, users } = data;
  const getUserName = (id: number | null) => {
    if (!id) return "—";
    const u = users.find((u: any) => u.id === id);
    return u?.name || `Usuario #${id}`;
  };

  const obsOpen = observations.filter((o: any) => o.status === "abierta").length;
  const obsResolved = observations.filter((o: any) => o.status === "resuelta" || o.status === "cerrada").length;
  const rfiOpen = rfis.filter((r: any) => r.status !== "cerrada" && r.status !== "respondida").length;
  const rfiClosed = rfis.filter((r: any) => r.status === "cerrada" || r.status === "respondida").length;
  const now = new Date().toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });

  return (
    <>
      {/* Print styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .print-container { padding: 0 !important; max-width: 100% !important; }
          .page-break { page-break-before: always; }
        }
      `}</style>

      {/* Top bar - no print */}
      <div className="no-print sticky top-0 z-50 flex items-center justify-between px-4 py-3 shadow-sm" style={{ backgroundColor: BRAND.navy }}>
        <button onClick={() => navigate(`/project/${projectId}`)} className="flex items-center gap-2 text-white">
          <ArrowLeft size={20} />
          <span className="text-sm">Volver al visor</span>
        </button>
        <Button onClick={handlePrint} className="text-white text-sm" style={{ backgroundColor: BRAND.teal }}>
          <Download size={16} className="mr-2" />
          Exportar PDF
        </Button>
      </div>

      {/* Report content */}
      <div ref={printRef} className="print-container max-w-4xl mx-auto px-4 py-8" style={{ backgroundColor: "white", color: BRAND.navy }}>
        {/* Header */}
        <div className="text-center mb-8 pb-6" style={{ borderBottom: `3px solid ${BRAND.teal}` }}>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: BRAND.navy }}>
            OBJETI<span style={{ color: BRAND.teal }}>VA</span> <sup className="text-xs font-normal">AR</sup>
          </h1>
          <h2 className="text-xl font-semibold mt-3">{project.name}</h2>
          <p className="text-sm mt-1 opacity-70">{project.description}</p>
          <p className="text-xs mt-3 opacity-50">Reporte generado el {now} por {user?.name || "Usuario"}</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <SummaryCard icon={<FileText size={20} />} label="Archivos" value={files.length} color={BRAND.teal} />
          <SummaryCard icon={<AlertTriangle size={20} />} label="Obs. Abiertas" value={obsOpen} color="#EF4444" />
          <SummaryCard icon={<CheckCircle size={20} />} label="Obs. Resueltas" value={obsResolved} color="#10B981" />
          <SummaryCard icon={<MessageSquare size={20} />} label="RFIs" value={rfis.length} color="#3B82F6" />
        </div>

        {/* Files section */}
        <section className="mb-8">
          <h3 className="text-lg font-bold mb-3 pb-2" style={{ borderBottom: `2px solid ${BRAND.teal}` }}>
            Archivos del Proyecto
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: BRAND.bg }}>
                <th className="text-left p-2 font-semibold">Especialidad</th>
                <th className="text-left p-2 font-semibold">Etiqueta</th>
                <th className="text-right p-2 font-semibold">Vértices</th>
                <th className="text-right p-2 font-semibold">Tamaño</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f: any) => (
                <tr key={f.id} className="border-b" style={{ borderColor: "#E5E7EB" }}>
                  <td className="p-2 flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: f.color }} />
                    {f.specialty}
                  </td>
                  <td className="p-2">{f.label}</td>
                  <td className="p-2 text-right">{(f.vertexCount || 0).toLocaleString()}</td>
                  <td className="p-2 text-right">{f.fileSize ? `${(f.fileSize / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Observations section */}
        {observations.length > 0 && (
          <section className="mb-8 page-break">
            <h3 className="text-lg font-bold mb-3 pb-2" style={{ borderBottom: `2px solid ${BRAND.teal}` }}>
              Bitácora de Observaciones ({observations.length})
            </h3>
            <div className="space-y-3">
              {observations.map((obs: any) => (
                <div key={obs.id} className="p-3 rounded-lg border" style={{ borderColor: "#E5E7EB" }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{obs.title}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: statusColors[obs.status] || "#6B7280" }}>
                          {obs.status}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: BRAND.bg, color: BRAND.navy }}>
                          {obs.category}
                        </span>
                      </div>
                      {obs.description && <p className="text-xs mt-1 opacity-70">{obs.description}</p>}
                    </div>
                    <div className="text-right text-xs opacity-50 flex-shrink-0">
                      <div>{new Date(obs.createdAt).toLocaleDateString("es-MX")}</div>
                      <div>{getUserName(obs.userId)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* RFIs section */}
        {rfis.length > 0 && (
          <section className="mb-8 page-break">
            <h3 className="text-lg font-bold mb-3 pb-2" style={{ borderBottom: `2px solid ${BRAND.teal}` }}>
              RFIs - Solicitudes de Información ({rfis.length})
            </h3>
            <div className="space-y-4">
              {rfis.map((rfi: any) => (
                <div key={rfi.id} className="p-4 rounded-lg border" style={{ borderColor: "#E5E7EB" }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm" style={{ color: BRAND.teal }}>RFI #{rfi.number}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: statusColors[rfi.status] || "#6B7280" }}>
                          {rfi.status}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "#FEF3C7", color: "#92400E" }}>
                          {priorityLabels[rfi.priority] || rfi.priority}
                        </span>
                      </div>
                      <h4 className="font-semibold text-sm mt-1">{rfi.subject}</h4>
                      {rfi.description && <p className="text-xs mt-1 opacity-70">{rfi.description}</p>}
                    </div>
                    <div className="text-right text-xs opacity-50 flex-shrink-0">
                      <div>{new Date(rfi.createdAt).toLocaleDateString("es-MX")}</div>
                      <div>Por: {getUserName(rfi.createdByUserId)}</div>
                      {rfi.assignedToUserId && <div>Asignado: {getUserName(rfi.assignedToUserId)}</div>}
                    </div>
                  </div>
                  {rfi.response && (
                    <div className="mt-2 p-2 rounded text-xs" style={{ backgroundColor: "#F0FDF4", border: "1px solid #BBF7D0" }}>
                      <span className="font-semibold">Respuesta:</span> {rfi.response}
                      {rfi.respondedAt && (
                        <span className="opacity-50 ml-2">
                          ({new Date(rfi.respondedAt).toLocaleDateString("es-MX")} - {getUserName(rfi.respondedByUserId)})
                        </span>
                      )}
                    </div>
                  )}
                  {rfi.attachments?.length > 0 && (
                    <div className="mt-2 flex gap-2 flex-wrap">
                      {rfi.attachments.map((att: any) => (
                        <img key={att.id} src={att.markupUrl || att.imageUrl} alt={att.caption || "Adjunto"} className="w-24 h-24 object-cover rounded border" />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Statistics summary */}
        <section className="mb-8 page-break">
          <h3 className="text-lg font-bold mb-3 pb-2" style={{ borderBottom: `2px solid ${BRAND.teal}` }}>
            Resumen Estadístico
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <StatBlock label="Total Observaciones" value={observations.length} />
            <StatBlock label="Observaciones Abiertas" value={obsOpen} />
            <StatBlock label="Observaciones Resueltas" value={obsResolved} />
            <StatBlock label="Total RFIs" value={rfis.length} />
            <StatBlock label="RFIs Abiertas" value={rfiOpen} />
            <StatBlock label="RFIs Cerradas/Respondidas" value={rfiClosed} />
          </div>
        </section>

        {/* Footer */}
        <div className="text-center pt-6 mt-8" style={{ borderTop: `2px solid ${BRAND.teal}` }}>
          <p className="text-xs opacity-50">
            ObjetivaAR — Reporte generado automáticamente · {now}
          </p>
          <p className="text-xs opacity-30 mt-1">
            © {new Date().getFullYear()} Objetiva. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </>
  );
}

function SummaryCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className="p-4 rounded-xl text-center" style={{ backgroundColor: `${color}10`, border: `1px solid ${color}30` }}>
      <div className="flex justify-center mb-2" style={{ color }}>{icon}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3 rounded-lg" style={{ backgroundColor: "#F5F7FA" }}>
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-xl font-bold" style={{ color: "#1B2A4A" }}>{value}</div>
    </div>
  );
}
