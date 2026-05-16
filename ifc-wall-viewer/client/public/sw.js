/**
 * Service Worker - Complete Offline Mode for ObjetivaAR
 * 
 * Strategies:
 * 1. App Shell (HTML/JS/CSS): Cache-first with network update
 * 2. GLB Models: Cache-first (IndexedDB primary, SW as backup)
 * 3. API (tRPC): Network-first with cache fallback
 * 4. Draco WASM decoders: Cache-first (from gstatic.com)
 * 5. Navigation: Return cached index.html for SPA routes
 * 6. Fonts/images: Cache-first
 */

const CACHE_VERSION = "v3";
const STATIC_CACHE = `objetiva-static-${CACHE_VERSION}`;
const GLB_CACHE = `objetiva-glb-${CACHE_VERSION}`;
const API_CACHE = `objetiva-api-${CACHE_VERSION}`;
const RUNTIME_CACHE = `objetiva-runtime-${CACHE_VERSION}`;

const ALL_CACHES = [STATIC_CACHE, GLB_CACHE, API_CACHE, RUNTIME_CACHE];

// Core app shell to precache on install
const PRECACHE_URLS = [
  "/",
  "/index.html",
];

// ─── Install: precache app shell ───
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      // Precache core URLs
      await cache.addAll(PRECACHE_URLS);
      
      // Try to cache the main page to get Vite asset references
      try {
        const response = await fetch("/");
        if (response.ok) {
          const html = await response.text();
          // Extract Vite-hashed asset URLs from HTML
          const assetUrls = [];
          const scriptMatches = html.matchAll(/src="(\/assets\/[^"]+)"/g);
          for (const m of scriptMatches) assetUrls.push(m[1]);
          const linkMatches = html.matchAll(/href="(\/assets\/[^"]+)"/g);
          for (const m of linkMatches) assetUrls.push(m[1]);
          
          // Cache all discovered assets
          for (const url of assetUrls) {
            try {
              const assetResp = await fetch(url);
              if (assetResp.ok) {
                await cache.put(url, assetResp);
              }
            } catch { /* skip failed assets */ }
          }
        }
      } catch { /* offline install, skip dynamic discovery */ }
    })
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches ───
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch strategies ───
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Skip WebSocket and chrome-extension requests
  if (url.protocol === "ws:" || url.protocol === "wss:" || url.protocol === "chrome-extension:") return;

  // 1. GLB proxy requests: cache-first (heavy files)
  if (url.pathname.startsWith("/api/proxy-glb")) {
    event.respondWith(handleGLBRequest(request));
    return;
  }

  // 2. API tRPC requests: network-first with cache fallback
  if (url.pathname.startsWith("/api/trpc")) {
    event.respondWith(handleAPIRequest(request));
    return;
  }

  // 3. Skip other API/auth requests
  if (url.pathname.startsWith("/api/")) return;

  // 4. Draco WASM decoders from gstatic: cache-first
  if (url.hostname === "www.gstatic.com" && url.pathname.includes("draco")) {
    event.respondWith(handleDracoRequest(request));
    return;
  }

  // 5. Google Fonts: cache-first
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
    event.respondWith(handleFontRequest(request));
    return;
  }

  // 6. Vite assets (hashed, immutable): cache-first
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(handleAssetRequest(request));
    return;
  }

  // 7. Navigation requests (SPA): return cached index.html
  if (request.mode === "navigate") {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  // 8. Static files (images, icons, etc.): stale-while-revalidate
  if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot)$/)) {
    event.respondWith(handleStaticRequest(request));
    return;
  }

  // 9. Everything else: network-first
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ─── Strategy Handlers ───

async function handleGLBRequest(request) {
  const cache = await caches.open(GLB_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Offline - Modelo no disponible en caché", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function handleAPIRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify([{ error: { message: "Sin conexión" } }]),
      { headers: { "Content-Type": "application/json" }, status: 503 }
    );
  }
}

async function handleDracoRequest(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Draco decoder not available offline", { status: 503 });
  }
}

async function handleFontRequest(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("", { status: 503 });
  }
}

async function handleAssetRequest(request) {
  // Vite assets have content hashes → immutable → cache forever
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Asset not available offline", { status: 503 });
  }
}

async function handleNavigationRequest(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Update cached index.html
      const cache = await caches.open(STATIC_CACHE);
      cache.put("/index.html", response.clone());
    }
    return response;
  } catch {
    // Offline: serve cached index.html for SPA routing
    const cached = await caches.match("/index.html");
    if (cached) return cached;
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ObjetivaAR - Sin Conexión</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#1e293b}
      .box{text-align:center;padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.5rem;margin-bottom:0.5rem}
      p{color:#64748b;font-size:0.875rem}button{margin-top:1rem;padding:0.5rem 1.5rem;background:#00A89D;color:white;border:none;border-radius:0.5rem;cursor:pointer}</style></head>
      <body><div class="box"><div class="icon">📡</div><h1>Sin Conexión</h1><p>No hay conexión a internet y la app no está en caché.</p>
      <button onclick="location.reload()">Reintentar</button></div></body></html>`,
      { headers: { "Content-Type": "text/html" }, status: 503 }
    );
  }
}

async function handleStaticRequest(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  // Stale-while-revalidate: return cached immediately, update in background
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    // Return stale, revalidate in background
    fetchPromise; // fire and forget
    return cached;
  }

  // No cache: wait for network
  const response = await fetchPromise;
  if (response) return response;
  return new Response("", { status: 503 });
}

// ─── Message handler for manual cache operations ───
self.addEventListener("message", (event) => {
  const { type, url: targetUrl } = event.data || {};

  if (type === "CACHE_GLB") {
    event.waitUntil(
      caches.open(GLB_CACHE).then(async (cache) => {
        try {
          const response = await fetch(targetUrl);
          if (response.ok) {
            await cache.put(targetUrl, response);
            notifyClients({ type: "GLB_CACHED", url: targetUrl, success: true });
          }
        } catch {
          notifyClients({ type: "GLB_CACHED", url: targetUrl, success: false });
        }
      })
    );
  }

  if (type === "PRECACHE_APP") {
    // Force re-cache all app assets
    event.waitUntil(
      caches.open(STATIC_CACHE).then(async (cache) => {
        try {
          const response = await fetch("/");
          if (!response.ok) return;
          const html = await response.text();
          await cache.put("/index.html", new Response(html, {
            headers: { "Content-Type": "text/html" },
          }));
          await cache.put("/", new Response(html, {
            headers: { "Content-Type": "text/html" },
          }));

          // Extract and cache Vite assets
          const assetUrls = [];
          for (const m of html.matchAll(/src="(\/assets\/[^"]+)"/g)) assetUrls.push(m[1]);
          for (const m of html.matchAll(/href="(\/assets\/[^"]+)"/g)) assetUrls.push(m[1]);

          let cached = 0;
          for (const url of assetUrls) {
            try {
              const resp = await fetch(url);
              if (resp.ok) {
                await cache.put(url, resp);
                cached++;
              }
            } catch { /* skip */ }
          }

          notifyClients({ type: "APP_PRECACHED", total: assetUrls.length, cached });
        } catch (err) {
          notifyClients({ type: "APP_PRECACHE_FAILED", error: err.message });
        }
      })
    );
  }

  if (type === "GET_CACHE_STATUS") {
    event.waitUntil(
      Promise.all([
        caches.open(GLB_CACHE).then((c) => c.keys()),
        caches.open(STATIC_CACHE).then((c) => c.keys()),
        caches.open(API_CACHE).then((c) => c.keys()),
        caches.open(RUNTIME_CACHE).then((c) => c.keys()),
      ]).then(([glbKeys, staticKeys, apiKeys, runtimeKeys]) => {
        notifyClients({
          type: "CACHE_STATUS",
          glb: glbKeys.map((k) => k.url),
          static: staticKeys.map((k) => k.url),
          api: apiKeys.map((k) => k.url),
          runtime: runtimeKeys.map((k) => k.url),
        });
      })
    );
  }

  if (type === "CLEAR_ALL_CACHES") {
    event.waitUntil(
      Promise.all(ALL_CACHES.map((c) => caches.delete(c))).then(() => {
        notifyClients({ type: "CACHES_CLEARED" });
      })
    );
  }
});

async function notifyClients(message) {
  const clients = await self.clients.matchAll();
  clients.forEach((client) => client.postMessage(message));
}
