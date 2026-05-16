/**
 * GLB Cache - IndexedDB-based cache for GLB model files.
 * Stores ArrayBuffers locally so models load instantly after first download.
 * Supports chunked storage for large files (>50MB) to avoid IndexedDB limits.
 * Uses stable cacheKey (fileKey) instead of URL since presigned URLs change.
 * Includes retry logic for network resilience.
 */

const DB_NAME = "objetiva-glb-cache";
const DB_VERSION = 3; // Bumped for cacheKey migration
const STORE_NAME = "glb-files";
const CHUNK_STORE = "glb-chunks";
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks for large files
const MAX_SINGLE_STORE = 50 * 1024 * 1024; // Files >50MB use chunked storage

interface CacheEntry {
  cacheKey: string; // Stable identifier (fileKey from DB)
  data?: ArrayBuffer; // For small files
  size: number;
  cachedAt: number;
  etag?: string;
  chunked?: boolean;
  chunkCount?: number;
}

interface ChunkEntry {
  key: string; // cacheKey + "_chunk_" + index
  data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Delete old stores if upgrading from v2 (url-based keys)
      if ((event as IDBVersionChangeEvent).oldVersion < 3) {
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        if (db.objectStoreNames.contains(CHUNK_STORE)) {
          db.deleteObjectStore(CHUNK_STORE);
        }
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn("[GLB Cache] IndexedDB open failed:", request.error);
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/**
 * Get a cached GLB ArrayBuffer by cacheKey.
 * Handles both single-store and chunked files.
 */
export async function getCachedGLB(cacheKey: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    const entry = await new Promise<CacheEntry | undefined>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(cacheKey);
      request.onsuccess = () => resolve(request.result as CacheEntry | undefined);
      request.onerror = () => resolve(undefined);
    });

    if (!entry) return null;

    // Small file: data is inline
    if (!entry.chunked && entry.data) {
      return entry.data;
    }

    // Large file: reassemble from chunks using parallel reads (single transaction)
    if (entry.chunked && entry.chunkCount) {
      const tx = db.transaction(CHUNK_STORE, "readonly");
      const store = tx.objectStore(CHUNK_STORE);

      // Fire all chunk reads in parallel within the same transaction
      const chunkPromises: Promise<ChunkEntry | null>[] = [];
      for (let i = 0; i < entry.chunkCount; i++) {
        const chunkKey = `${cacheKey}_chunk_${i}`;
        chunkPromises.push(
          new Promise<ChunkEntry | null>((resolve) => {
            const req = store.get(chunkKey);
            req.onsuccess = () => resolve(req.result as ChunkEntry | null);
            req.onerror = () => resolve(null);
          })
        );
      }

      const chunks = await Promise.all(chunkPromises);
      // Validate all chunks present
      for (let i = 0; i < chunks.length; i++) {
        if (!chunks[i]) {
          console.warn(`[GLB Cache] Missing chunk ${i} for ${cacheKey}, cache invalid`);
          return null;
        }
      }

      // Reassemble into single buffer
      const result = new Uint8Array(entry.size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(new Uint8Array(chunk!.data), offset);
        offset += chunk!.data.byteLength;
      }
      return result.buffer;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Store a GLB ArrayBuffer in cache.
 * Uses chunked storage for files >50MB to avoid IndexedDB transaction limits.
 */
export async function setCachedGLB(cacheKey: string, data: ArrayBuffer, etag?: string): Promise<void> {
  try {
    const db = await openDB();

    if (data.byteLength <= MAX_SINGLE_STORE) {
      // Small file: store inline
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const entry: CacheEntry = {
          cacheKey,
          data,
          size: data.byteLength,
          cachedAt: Date.now(),
          etag,
          chunked: false,
        };
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }

    // Large file: store all chunks + metadata in a single transaction for speed
    const chunkCount = Math.ceil(data.byteLength / CHUNK_SIZE);

    await new Promise<void>((resolve) => {
      const tx = db.transaction([CHUNK_STORE, STORE_NAME], "readwrite");
      const chunkStore = tx.objectStore(CHUNK_STORE);
      const metaStore = tx.objectStore(STORE_NAME);

      // Write all chunks
      for (let i = 0; i < chunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, data.byteLength);
        const chunkData = data.slice(start, end);
        chunkStore.put({ key: `${cacheKey}_chunk_${i}`, data: chunkData } as ChunkEntry);
      }

      // Write metadata
      metaStore.put({
        cacheKey,
        size: data.byteLength,
        cachedAt: Date.now(),
        etag,
        chunked: true,
        chunkCount,
      } as CacheEntry);

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn("[GLB Cache] Store failed:", err);
  }
}

/**
 * Check if a cacheKey is cached and return metadata.
 */
export async function isCached(cacheKey: string): Promise<{ cached: boolean; size?: number; cachedAt?: number }> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(cacheKey);
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (entry) {
          resolve({ cached: true, size: entry.size, cachedAt: entry.cachedAt });
        } else {
          resolve({ cached: false });
        }
      };
      request.onerror = () => resolve({ cached: false });
    });
  } catch {
    return { cached: false };
  }
}

/**
 * Remove a specific cacheKey from cache (including chunks).
 */
export async function removeCachedGLB(cacheKey: string): Promise<void> {
  try {
    const db = await openDB();

    // Get entry to check if chunked
    const entry = await new Promise<CacheEntry | undefined>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cacheKey);
      req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
      req.onerror = () => resolve(undefined);
    });

    // Remove chunks + metadata in single transaction
    await new Promise<void>((resolve) => {
      const stores = entry?.chunked ? [CHUNK_STORE, STORE_NAME] : [STORE_NAME];
      const tx = db.transaction(stores, "readwrite");
      if (entry?.chunked && entry.chunkCount) {
        const chunkStore = tx.objectStore(CHUNK_STORE);
        for (let i = 0; i < entry.chunkCount; i++) {
          chunkStore.delete(`${cacheKey}_chunk_${i}`);
        }
      }
      tx.objectStore(STORE_NAME).delete(cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Silently fail
  }
}

/**
 * Get total cache size in bytes.
 */
export async function getCacheSize(): Promise<number> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result as CacheEntry[];
        const total = entries.reduce((sum, e) => sum + (e.size || 0), 0);
        resolve(total);
      };
      request.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

/**
 * Clear all cached GLB files (both stores).
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction([STORE_NAME, CHUNK_STORE], "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(CHUNK_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Silently fail
  }
}

/**
 * Download a single range chunk with retries.
 */
async function fetchRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const MAX_RANGE_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RANGE_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      });
      if (res.status === 206 || res.status === 200) {
        return await res.arrayBuffer();
      }
      throw new Error(`Range fetch failed: ${res.status}`);
    } catch (err) {
      if (attempt === MAX_RANGE_RETRIES - 1) throw err;
    }
  }
  throw new Error("Range fetch exhausted retries");
}

/**
 * Fetch a GLB file with cache-first strategy + retry logic.
 * @param cacheKey - Stable identifier for cache (fileKey from DB)
 * @param fetchUrl - The actual URL to download from (may be presigned, changes each time)
 * @param onProgress - Progress callback
 *
 * 1. Check IndexedDB cache by cacheKey → return instantly if found
 * 2. Fetch from network using fetchUrl with progress callback (3 retries with backoff)
 * 3. Store in IndexedDB under cacheKey for next time
 */
export async function fetchGLBWithCache(
  cacheKey: string,
  fetchUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ buffer: ArrayBuffer; fromCache: boolean; size: number }> {
  // 1. Try cache first (using stable cacheKey)
  const cached = await getCachedGLB(cacheKey);
  if (cached) {
    onProgress?.(cached.byteLength, cached.byteLength);
    return { buffer: cached, fromCache: true, size: cached.byteLength };
  }

  // 2. Get file size with HEAD request
  const MAX_RETRIES = 3;
  let lastError: Error | null = null;
  const RANGE_CHUNK_SIZE = 25 * 1024 * 1024; // 25MB chunks
  const RANGE_THRESHOLD = 50 * 1024 * 1024; // Use range downloads for files >50MB

  // Try to get content-length first
  let totalSize = 0;
  let supportsRange = false;
  try {
    const headRes = await fetch(fetchUrl, { method: "HEAD" });
    totalSize = parseInt(headRes.headers.get("content-length") || "0", 10);
    supportsRange = headRes.headers.get("accept-ranges") === "bytes";
  } catch {
    // HEAD failed, will fall back to streaming
  }

  // 3. For large files that support Range, use parallel chunked download to avoid edge proxy timeouts
  if (totalSize > RANGE_THRESHOLD && supportsRange) {
    console.log(`[GLB Cache] Large file (${(totalSize / 1024 / 1024).toFixed(0)}MB), using parallel chunked Range download`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 900_000); // 15 min total

      const combined = new Uint8Array(totalSize);
      let downloaded = 0;
      const CONCURRENCY = 4; // Download 4 chunks in parallel

      // Build chunk list
      const chunkRanges: { start: number; end: number }[] = [];
      for (let start = 0; start < totalSize; start += RANGE_CHUNK_SIZE) {
        chunkRanges.push({ start, end: Math.min(start + RANGE_CHUNK_SIZE - 1, totalSize - 1) });
      }

      // Process chunks in parallel batches
      for (let i = 0; i < chunkRanges.length; i += CONCURRENCY) {
        const batch = chunkRanges.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async ({ start, end }) => {
            const buf = await fetchRange(fetchUrl, start, end, controller.signal);
            return { start, buf };
          })
        );
        for (const { start, buf } of results) {
          combined.set(new Uint8Array(buf), start);
          downloaded += buf.byteLength;
        }
        onProgress?.(downloaded, totalSize);
      }

      clearTimeout(timeoutId);
      const arrayBuffer = combined.buffer;
      setCachedGLB(cacheKey, arrayBuffer).catch(() => {});
      return { buffer: arrayBuffer, fromCache: false, size: arrayBuffer.byteLength };
    } catch (err) {
      console.warn(`[GLB Cache] Chunked download failed, falling back to streaming:`, err);
      // Fall through to streaming approach
    }
  }

  // 4. Standard streaming fetch with retries (for small files or range fallback)
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[GLB Cache] Retry ${attempt}/${MAX_RETRIES} for ${cacheKey} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      const controller = new AbortController();
      // 10 minute timeout for very large files
      const timeoutId = setTimeout(() => controller.abort(), 600_000);

      const response = await fetch(fetchUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch GLB: ${response.status}`);
      }

      const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
      const etag = response.headers.get("etag") || undefined;

      if (!response.body) {
        const buffer = await response.arrayBuffer();
        setCachedGLB(cacheKey, buffer, etag).catch(() => {});
        return { buffer, fromCache: false, size: buffer.byteLength };
      }

      // Stream with progress
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(loaded, contentLength || loaded);
      }

      const combined = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const arrayBuffer = combined.buffer;
      setCachedGLB(cacheKey, arrayBuffer, etag).catch(() => {});
      return { buffer: arrayBuffer, fromCache: false, size: arrayBuffer.byteLength };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[GLB Cache] Fetch attempt ${attempt + 1} failed:`, lastError.message);
    }
  }

  throw lastError || new Error("Failed to fetch GLB after retries");
}
