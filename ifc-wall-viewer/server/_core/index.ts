import "dotenv/config";
import express from "express";
import { createServer } from "http";
import https from "https";
import net from "net";
import zlib from "zlib";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "350mb" }));
  app.use(express.urlencoded({ limit: "350mb", extended: true }));
  // Streaming proxy for GLB files from CDN (bypass CORS)
  app.get("/api/proxy-glb", (req, res) => {
    const url = req.query.url as string;
    const allowedHosts = ["https://files.manuscdn.com/", "https://d2xsxph8kpxj0f.cloudfront.net/"];
    if (!url || !allowedHosts.some(h => url.startsWith(h))) {
      res.status(400).json({ error: "Invalid URL" });
      return;
    }
    const parsedUrl = new URL(url);
    const headers: Record<string, string> = {};
    // Forward Range header for partial content requests (resumable downloads)
    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: 600000,
      headers,
    };
    // Detect if this is a pre-gzipped file from S3 (.gz extension)
    const isPreGzipped = url.endsWith(".gz");
    const isRangeReq = !!req.headers.range;
    const proxyReq = https.request(options, (proxyRes) => {
      res.set("Content-Type", "model/gltf-binary");
      res.set("Cache-Control", "public, max-age=86400");

      if (isPreGzipped && !isRangeReq) {
        // Pre-gzipped file: set Content-Encoding so browser auto-decompresses
        res.set("Content-Encoding", "gzip");
        // Don't set Content-Length (browser needs decompressed size, not gzipped)
        res.status(proxyRes.statusCode ?? 200);
        proxyRes.pipe(res);
      } else {
        // Regular file: direct streaming with Range support
        res.set("Accept-Ranges", "bytes");
        if (proxyRes.headers["content-length"]) {
          res.set("Content-Length", proxyRes.headers["content-length"]);
        }
        if (proxyRes.headers["content-range"]) {
          res.set("Content-Range", proxyRes.headers["content-range"] as string);
        }
        // Forward 206 Partial Content or 200 OK
        res.status(proxyRes.statusCode ?? 200);
        proxyRes.pipe(res);
      }
      proxyRes.on("error", (err) => {
        console.error("[GLB Proxy] Stream error:", err.message);
        res.destroy();
      });
    });
    proxyReq.on("error", (err) => {
      console.error("[GLB Proxy] Request error:", err.message, "URL:", url.substring(url.lastIndexOf("/") + 1));
      if (!res.headersSent) res.status(502).json({ error: "Failed to fetch GLB" });
    });
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      console.error("[GLB Proxy] Timeout for:", url.substring(url.lastIndexOf("/") + 1));
      if (!res.headersSent) res.status(504).json({ error: "Timeout" });
    });
    res.on("close", () => {
      // Client disconnected, abort upstream request
      proxyReq.destroy();
    });
    proxyReq.end();
  });

  // Direct file upload endpoint for GLB files (bypasses tRPC base64 size limits)
  app.post("/api/upload-glb", async (req, res) => {
    try {
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/octet-stream") && !contentType.includes("model/gltf-binary")) {
        res.status(400).json({ error: "Invalid content type. Send raw GLB binary." });
        return;
      }
      const projectId = req.headers["x-project-id"] as string;
      const specialty = req.headers["x-specialty"] as string;
      if (!projectId || !specialty) {
        res.status(400).json({ error: "Missing x-project-id or x-specialty headers" });
        return;
      }
      // Collect raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        res.status(400).json({ error: "Empty file" });
        return;
      }
      const { nanoid } = await import("nanoid");
      const { storagePut } = await import("../storage");
      const { optimizeGLB, generateLOD } = await import("../optimizeGLB");

      // Lossless optimization: dedup → weld → prune → meshopt (no geometry loss)
      const skipOptimize = req.headers["x-skip-optimize"] === "true";
      let finalBuffer: Uint8Array | Buffer = buffer;
      let optimizeInfo = { optimized: false, originalSize: buffer.length, optimizedSize: buffer.length, ratio: 1, level: "lossless" as string, stats: { verticesBefore: 0, verticesAfter: 0, meshesBefore: 0, meshesAfter: 0 } };

      if (!skipOptimize && buffer.length > 50_000) { // Only optimize files > 50KB
        try {
          // Lossless optimization for ALL specialties — preserves every detail
          const result = await optimizeGLB(buffer);
          finalBuffer = result.buffer;
          optimizeInfo = {
            optimized: result.ratio < 1,
            originalSize: result.originalSize,
            optimizedSize: result.optimizedSize,
            ratio: result.ratio,
            level: result.level,
            stats: result.stats,
          };
        } catch (err) {
          console.warn("[Upload GLB] Optimization failed, uploading original:", err);
        }
      }

      // Generate LOD preview for large files (>20MB original)
      let lodUrl: string | null = null;
      if (buffer.length > 20 * 1024 * 1024) {
        try {
          const lod = await generateLOD(buffer);
          const lodKey = `projects/${projectId}/${specialty}-lod-${nanoid(8)}.glb`;
          const lodResult = await storagePut(lodKey, lod.buffer, "model/gltf-binary");
          lodUrl = lodResult.url;
          console.log(`[Upload] LOD generated: ${(lod.buffer.length / 1024 / 1024).toFixed(1)}MB`);
        } catch (err) {
          console.warn("[Upload GLB] LOD generation failed, skipping:", err);
        }
      }

      const fileKey = `projects/${projectId}/${specialty}-${nanoid(8)}.glb`;
      const { url } = await storagePut(fileKey, finalBuffer, "model/gltf-binary");
      res.json({
        url,
        fileKey,
        fileSize: finalBuffer.length,
        originalSize: buffer.length,
        optimized: optimizeInfo.optimized,
        optimizationLevel: optimizeInfo.level,
        compressionRatio: optimizeInfo.ratio,
        lodUrl,
        stats: optimizeInfo.stats,
      });
    } catch (err: any) {
      console.error("[Upload GLB] Error:", err);
      res.status(500).json({ error: err.message || "Upload failed" });
    }
  });

  // IFC/RVT file upload with server-side conversion to GLB
  app.post("/api/upload-convert", async (req, res) => {
    try {
      const projectId = req.headers["x-project-id"] as string;
      const specialty = req.headers["x-specialty"] as string;
      const fileType = (req.headers["x-file-type"] as string || "").toLowerCase(); // "ifc" or "rvt"
      if (!projectId || !specialty) {
        res.status(400).json({ error: "Missing x-project-id or x-specialty headers" });
        return;
      }
      if (!fileType || !["ifc", "rvt"].includes(fileType)) {
        res.status(400).json({ error: "Missing or invalid x-file-type header. Must be 'ifc' or 'rvt'." });
        return;
      }

      // Collect raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        res.status(400).json({ error: "Empty file" });
        return;
      }

      console.log(`[Upload Convert] Received ${fileType.toUpperCase()} file: ${(buffer.length / 1024 / 1024).toFixed(1)}MB for project ${projectId}/${specialty}`);

      const { nanoid } = await import("nanoid");
      const { storagePut } = await import("../storage");

      let glbBuffer: Uint8Array;
      let conversionInfo: { meshCount: number; vertexCount: number; sourceFormat: string };

      if (fileType === "ifc") {
        // IFC → GLB conversion
        const { convertIFCtoGLB } = await import("../convertIFC");
        const result = await convertIFCtoGLB(buffer);
        glbBuffer = result.glbBuffer;
        conversionInfo = {
          meshCount: result.meshCount,
          vertexCount: result.vertexCount,
          sourceFormat: "IFC",
        };
      } else {
        // RVT → store original in S3 as reference, return info to guide user
        // RVT is a proprietary encrypted format that cannot be parsed without Revit
        const rvtKey = `projects/${projectId}/${specialty}-original-${nanoid(8)}.rvt`;
        const rvtResult = await storagePut(rvtKey, buffer, "application/octet-stream");
        
        res.json({
          rvtStored: true,
          rvtUrl: rvtResult.url,
          rvtFileKey: rvtKey,
          rvtFileSize: buffer.length,
          needsIFCExport: true,
          message: "Archivo RVT almacenado. Para visualización 3D, exporta como GLB o IFC desde Revit.",
          instructions: [
            "OPCIÓN 1 (Recomendada - Máxima fidelidad):",
            "1. Abre el archivo en Autodesk Revit",
            "2. Instala el plugin 'GLTF Exporter for Revit' desde Autodesk App Store",
            "3. Exporta como .glb (preserva todos los detalles)",
            "4. Sube el archivo .glb resultante",
            "",
            "OPCIÓN 2 (IFC):",
            "1. Abre el archivo en Autodesk Revit",
            "2. Ve a Archivo → Exportar → IFC",
            "3. Selecciona formato IFC4 con geometría completa",
            "4. Sube el archivo .ifc resultante",
          ],
        });
        return;
      }

      // Lossless optimization of converted GLB — preserves all geometry details
      const { optimizeGLB, generateLOD } = await import("../optimizeGLB");
      let finalBuffer: Uint8Array = glbBuffer;
      let optimizeInfo = { optimized: false, originalSize: glbBuffer.length, optimizedSize: glbBuffer.length, ratio: 1, level: "lossless" as string, stats: { verticesBefore: 0, verticesAfter: 0, meshesBefore: 0, meshesAfter: 0 } };

      if (glbBuffer.length > 50_000) {
        try {
          // Lossless optimization for ALL specialties — preserves every detail
          const result = await optimizeGLB(glbBuffer);
          finalBuffer = result.buffer;
          optimizeInfo = {
            optimized: result.ratio < 1,
            originalSize: result.originalSize,
            optimizedSize: result.optimizedSize,
            ratio: result.ratio,
            level: result.level,
            stats: result.stats,
          };
        } catch (err) {
          console.warn("[Upload Convert] Optimization failed, using unoptimized:", err);
        }
      }

      // Generate LOD for large converted files
      let lodUrl: string | null = null;
      if (glbBuffer.length > 20 * 1024 * 1024) {
        try {
          const lod = await generateLOD(glbBuffer);
          const lodKey = `projects/${projectId}/${specialty}-lod-${nanoid(8)}.glb`;
          const lodResult = await storagePut(lodKey, lod.buffer, "model/gltf-binary");
          lodUrl = lodResult.url;
        } catch (err) {
          console.warn("[Upload Convert] LOD generation failed:", err);
        }
      }

      const fileKey = `projects/${projectId}/${specialty}-${nanoid(8)}.glb`;
      const { url } = await storagePut(fileKey, finalBuffer, "model/gltf-binary");

      res.json({
        url,
        fileKey,
        fileSize: finalBuffer.length,
        originalSize: buffer.length,
        convertedFrom: conversionInfo.sourceFormat,
        meshCount: conversionInfo.meshCount,
        vertexCount: conversionInfo.vertexCount,
        optimized: optimizeInfo.optimized,
        optimizationLevel: optimizeInfo.level,
        compressionRatio: optimizeInfo.ratio,
        lodUrl,
        stats: optimizeInfo.stats,
      });
    } catch (err: any) {
      console.error("[Upload Convert] Error:", err);
      res.status(500).json({ error: err.message || "Conversion failed" });
    }
  });

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
