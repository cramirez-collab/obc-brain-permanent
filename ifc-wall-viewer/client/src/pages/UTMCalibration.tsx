import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, MapPin, Navigation, Crosshair, Save, RotateCcw, Loader2, CheckCircle } from "lucide-react";
import { useState, useCallback, useEffect } from "react";

const BRAND = {
  navy: "#1B2A4A",
  teal: "#00A89D",
  bg: "#F5F7FA",
  cardBg: "#FFFFFF",
};

interface UTMCoords {
  easting: number;
  northing: number;
  zone: number;
  hemisphere: "N" | "S";
  elevation: number;
}

interface GPSCoords {
  lat: number;
  lng: number;
  altitude: number | null;
  accuracy: number;
}

// Simple lat/lng to UTM conversion
function latLngToUTM(lat: number, lng: number): { easting: number; northing: number; zone: number; hemisphere: "N" | "S" } {
  const zone = Math.floor((lng + 180) / 6) + 1;
  const hemisphere: "N" | "S" = lat >= 0 ? "N" : "S";

  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e = Math.sqrt(2 * f - f * f);
  const e2 = e * e / (1 - e * e);
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + n * n / 4 + n * n * n * n / 64);

  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const lng0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;

  const t = Math.sinh(Math.atanh(Math.sin(latRad)) - (2 * Math.sqrt(n) / (1 + n)) * Math.atanh((2 * Math.sqrt(n) / (1 + n)) * Math.sin(latRad)));
  const xi = Math.atan(t / Math.cos(lngRad - lng0));
  const eta = Math.atanh(Math.sin(lngRad - lng0) / Math.sqrt(1 + t * t));

  const alpha = [
    0,
    n / 2 - (2 / 3) * n * n + (5 / 16) * n * n * n,
    (13 / 48) * n * n - (3 / 5) * n * n * n,
    (61 / 240) * n * n * n,
  ];

  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP += alpha[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP += alpha[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const easting = k0 * A * etaP + 500000;
  let northing = k0 * A * xiP;
  if (lat < 0) northing += 10000000;

  return { easting, northing, zone, hemisphere };
}

export default function UTMCalibration() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/project/:id/utm");
  const projectId = Number(params?.id);

  const [gps, setGps] = useState<GPSCoords | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<number | null>(null);

  // Manual UTM input
  const [manualUTM, setManualUTM] = useState<UTMCoords>({
    easting: 0,
    northing: 0,
    zone: 14,
    hemisphere: "N",
    elevation: 0,
  });

  // Model reference point (origin in model space)
  const [modelOrigin, setModelOrigin] = useState({ x: 0, y: 0, z: 0 });

  // Calibration state
  const [calibrated, setCalibrated] = useState(false);
  const [calibrationData, setCalibrationData] = useState<{
    utmRef: UTMCoords;
    modelRef: { x: number; y: number; z: number };
    timestamp: string;
  } | null>(null);

  // Load saved calibration from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(`utm-cal-${projectId}`);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setCalibrationData(data);
        setCalibrated(true);
        setManualUTM(data.utmRef);
        setModelOrigin(data.modelRef);
      } catch { /* ignore */ }
    }
  }, [projectId]);

  const startGPS = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsError("Geolocalización no disponible en este dispositivo");
      return;
    }
    setGpsLoading(true);
    setGpsError(null);

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const coords: GPSCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
        };
        setGps(coords);
        setGpsLoading(false);

        // Auto-fill UTM from GPS
        const utm = latLngToUTM(coords.lat, coords.lng);
        setManualUTM({
          easting: Math.round(utm.easting * 100) / 100,
          northing: Math.round(utm.northing * 100) / 100,
          zone: utm.zone,
          hemisphere: utm.hemisphere,
          elevation: coords.altitude ? Math.round(coords.altitude * 100) / 100 : 0,
        });
      },
      (err) => {
        setGpsError(err.message);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    setWatchId(id);
  }, []);

  const stopGPS = useCallback(() => {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      setWatchId(null);
    }
  }, [watchId]);

  const saveCalibration = useCallback(() => {
    const data = {
      utmRef: manualUTM,
      modelRef: modelOrigin,
      timestamp: new Date().toISOString(),
    };
    localStorage.setItem(`utm-cal-${projectId}`, JSON.stringify(data));
    setCalibrationData(data);
    setCalibrated(true);
  }, [manualUTM, modelOrigin, projectId]);

  const resetCalibration = useCallback(() => {
    localStorage.removeItem(`utm-cal-${projectId}`);
    setCalibrationData(null);
    setCalibrated(false);
  }, [projectId]);

  useEffect(() => {
    return () => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); };
  }, [watchId]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: BRAND.bg }}>
      {/* Header */}
      <div className="sticky top-0 z-50 flex items-center justify-between px-4 py-3 shadow-sm" style={{ backgroundColor: BRAND.navy }}>
        <button onClick={() => navigate(`/project/${projectId}`)} className="flex items-center gap-2 text-white">
          <ArrowLeft size={20} />
          <span className="text-sm hidden sm:inline">Volver</span>
        </button>
        <h1 className="text-white font-semibold text-sm flex items-center gap-2">
          <MapPin size={16} />
          Calibración UTM
        </h1>
        <div className="w-16" />
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {/* Status */}
        {calibrated && calibrationData && (
          <div className="p-4 rounded-xl flex items-start gap-3" style={{ backgroundColor: "#F0FDF4", border: "1px solid #BBF7D0" }}>
            <CheckCircle size={20} className="flex-shrink-0 mt-0.5" style={{ color: "#10B981" }} />
            <div>
              <p className="font-semibold text-sm" style={{ color: "#065F46" }}>Calibración activa</p>
              <p className="text-xs opacity-70" style={{ color: "#065F46" }}>
                UTM {calibrationData.utmRef.zone}{calibrationData.utmRef.hemisphere} E{calibrationData.utmRef.easting.toFixed(2)} N{calibrationData.utmRef.northing.toFixed(2)} · Elev. {calibrationData.utmRef.elevation}m
              </p>
              <p className="text-xs opacity-50 mt-1" style={{ color: "#065F46" }}>
                {new Date(calibrationData.timestamp).toLocaleString("es-MX")}
              </p>
            </div>
          </div>
        )}

        {/* GPS Section */}
        <div className="rounded-xl p-4 shadow-sm" style={{ backgroundColor: BRAND.cardBg }}>
          <h2 className="font-bold text-sm mb-3 flex items-center gap-2" style={{ color: BRAND.navy }}>
            <Navigation size={16} style={{ color: BRAND.teal }} />
            Posición GPS del Dispositivo
          </h2>

          {gps ? (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded" style={{ backgroundColor: BRAND.bg }}>
                  <span className="text-xs opacity-50">Latitud</span>
                  <div className="font-mono font-semibold">{gps.lat.toFixed(7)}</div>
                </div>
                <div className="p-2 rounded" style={{ backgroundColor: BRAND.bg }}>
                  <span className="text-xs opacity-50">Longitud</span>
                  <div className="font-mono font-semibold">{gps.lng.toFixed(7)}</div>
                </div>
                <div className="p-2 rounded" style={{ backgroundColor: BRAND.bg }}>
                  <span className="text-xs opacity-50">Altitud</span>
                  <div className="font-mono font-semibold">{gps.altitude?.toFixed(1) || "—"} m</div>
                </div>
                <div className="p-2 rounded" style={{ backgroundColor: BRAND.bg }}>
                  <span className="text-xs opacity-50">Precisión</span>
                  <div className="font-mono font-semibold">±{gps.accuracy.toFixed(1)} m</div>
                </div>
              </div>
              <Button onClick={stopGPS} variant="outline" className="w-full text-xs mt-2">
                Detener GPS
              </Button>
            </div>
          ) : (
            <div>
              {gpsError && (
                <p className="text-xs text-red-500 mb-2">{gpsError}</p>
              )}
              <Button
                onClick={startGPS}
                className="w-full text-white text-sm"
                style={{ backgroundColor: BRAND.teal }}
                disabled={gpsLoading}
              >
                {gpsLoading ? <Loader2 size={16} className="animate-spin mr-2" /> : <Crosshair size={16} className="mr-2" />}
                {gpsLoading ? "Obteniendo posición..." : "Obtener posición GPS"}
              </Button>
              <p className="text-xs opacity-50 mt-2 text-center">
                Activa la ubicación de alta precisión en tu dispositivo
              </p>
            </div>
          )}
        </div>

        {/* Manual UTM Input */}
        <div className="rounded-xl p-4 shadow-sm" style={{ backgroundColor: BRAND.cardBg }}>
          <h2 className="font-bold text-sm mb-3 flex items-center gap-2" style={{ color: BRAND.navy }}>
            <MapPin size={16} style={{ color: BRAND.teal }} />
            Coordenadas UTM del Punto de Referencia
          </h2>
          <p className="text-xs opacity-60 mb-3">
            Ingresa las coordenadas UTM del punto donde te encuentras en la obra. Puedes obtenerlas del GPS o ingresarlas manualmente.
          </p>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold opacity-70">Zona UTM</label>
                <input
                  type="number"
                  value={manualUTM.zone}
                  onChange={(e) => setManualUTM({ ...manualUTM, zone: +e.target.value })}
                  className="w-full p-2 rounded border text-sm font-mono"
                  style={{ borderColor: "#E5E7EB" }}
                />
              </div>
              <div>
                <label className="text-xs font-semibold opacity-70">Hemisferio</label>
                <select
                  value={manualUTM.hemisphere}
                  onChange={(e) => setManualUTM({ ...manualUTM, hemisphere: e.target.value as "N" | "S" })}
                  className="w-full p-2 rounded border text-sm"
                  style={{ borderColor: "#E5E7EB" }}
                >
                  <option value="N">Norte (N)</option>
                  <option value="S">Sur (S)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold opacity-70">Easting (E)</label>
              <input
                type="number"
                step="0.01"
                value={manualUTM.easting || ""}
                onChange={(e) => setManualUTM({ ...manualUTM, easting: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
                placeholder="Ej: 485234.56"
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-70">Northing (N)</label>
              <input
                type="number"
                step="0.01"
                value={manualUTM.northing || ""}
                onChange={(e) => setManualUTM({ ...manualUTM, northing: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
                placeholder="Ej: 2156789.12"
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-70">Elevación (m.s.n.m.)</label>
              <input
                type="number"
                step="0.1"
                value={manualUTM.elevation || ""}
                onChange={(e) => setManualUTM({ ...manualUTM, elevation: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
                placeholder="Ej: 2240.5"
              />
            </div>
          </div>
        </div>

        {/* Model Origin */}
        <div className="rounded-xl p-4 shadow-sm" style={{ backgroundColor: BRAND.cardBg }}>
          <h2 className="font-bold text-sm mb-3 flex items-center gap-2" style={{ color: BRAND.navy }}>
            <Crosshair size={16} style={{ color: BRAND.teal }} />
            Punto de Referencia en el Modelo
          </h2>
          <p className="text-xs opacity-60 mb-3">
            Coordenadas del punto de referencia dentro del modelo 3D (normalmente el origen 0,0,0 o el punto base del proyecto).
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold opacity-70">X</label>
              <input
                type="number"
                step="0.1"
                value={modelOrigin.x}
                onChange={(e) => setModelOrigin({ ...modelOrigin, x: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-70">Y</label>
              <input
                type="number"
                step="0.1"
                value={modelOrigin.y}
                onChange={(e) => setModelOrigin({ ...modelOrigin, y: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-70">Z</label>
              <input
                type="number"
                step="0.1"
                value={modelOrigin.z}
                onChange={(e) => setModelOrigin({ ...modelOrigin, z: +e.target.value })}
                className="w-full p-2 rounded border text-sm font-mono"
                style={{ borderColor: "#E5E7EB" }}
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            onClick={saveCalibration}
            className="flex-1 text-white text-sm"
            style={{ backgroundColor: BRAND.teal }}
          >
            <Save size={16} className="mr-2" />
            Guardar Calibración
          </Button>
          {calibrated && (
            <Button
              onClick={resetCalibration}
              variant="outline"
              className="text-sm"
            >
              <RotateCcw size={16} className="mr-2" />
              Reset
            </Button>
          )}
        </div>

        <p className="text-xs text-center opacity-40 pb-8">
          La calibración se guarda localmente en este dispositivo. Al estar en sitio, el modelo se alineará con las coordenadas reales.
        </p>
      </div>
    </div>
  );
}
