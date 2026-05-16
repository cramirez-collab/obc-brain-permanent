import { useEffect, useState, useCallback, useRef } from "react";

interface OfflineCacheState {
  supported: boolean;
  registered: boolean;
  online: boolean;
  cachedGlbs: string[];
  cachedAssets: number;
  caching: boolean;
  appCached: boolean;
}

export function useOfflineCache() {
  const [state, setState] = useState<OfflineCacheState>({
    supported: false,
    registered: false,
    online: navigator.onLine,
    cachedGlbs: [],
    cachedAssets: 0,
    caching: false,
    appCached: false,
  });
  const swRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    setState((s) => ({ ...s, supported: true }));

    // Online/offline listeners
    const handleOnline = () => setState((s) => ({ ...s, online: true }));
    const handleOffline = () => setState((s) => ({ ...s, online: false }));
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        swRef.current = reg;
        setState((s) => ({ ...s, registered: true }));
        // Request current cache status
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "GET_CACHE_STATUS" });
        }
      })
      .catch((err) => {
        console.warn("SW registration failed:", err);
      });

    const handler = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === "CACHE_STATUS") {
        setState((s) => ({
          ...s,
          cachedGlbs: data.glb || [],
          cachedAssets: (data.static?.length || 0) + (data.runtime?.length || 0),
          appCached: (data.static?.length || 0) > 2, // More than just / and /index.html
        }));
      }
      if (data.type === "GLB_CACHED") {
        setState((s) => ({
          ...s,
          caching: false,
          cachedGlbs: data.success ? [...s.cachedGlbs, data.url] : s.cachedGlbs,
        }));
      }
      if (data.type === "CACHES_CLEARED") {
        setState((s) => ({ ...s, cachedGlbs: [], cachedAssets: 0, appCached: false }));
      }
      if (data.type === "APP_PRECACHED") {
        setState((s) => ({ ...s, appCached: true, cachedAssets: data.cached || 0 }));
      }
    };

    navigator.serviceWorker.addEventListener("message", handler);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handler);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const cacheGlb = useCallback((url: string) => {
    if (!navigator.serviceWorker.controller) return;
    setState((s) => ({ ...s, caching: true }));
    navigator.serviceWorker.controller.postMessage({ type: "CACHE_GLB", url });
  }, []);

  const precacheApp = useCallback(() => {
    if (!navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: "PRECACHE_APP" });
  }, []);

  const clearAllCaches = useCallback(() => {
    if (!navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: "CLEAR_ALL_CACHES" });
  }, []);

  const isGlbCached = useCallback(
    (url: string) => state.cachedGlbs.some((u) => u.includes(url)),
    [state.cachedGlbs]
  );

  return { ...state, cacheGlb, precacheApp, clearAllCaches, isGlbCached };
}
