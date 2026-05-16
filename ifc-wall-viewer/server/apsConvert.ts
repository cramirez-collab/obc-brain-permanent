/**
 * Autodesk Platform Services (APS) — RVT → IFC → GLB conversion pipeline
 *
 * Flow:
 * 1. Get OAuth2 token (client_credentials)
 * 2. Create/ensure a bucket exists
 * 3. Upload RVT to APS Object Storage
 * 4. Submit translation job (RVT → IFC)
 * 5. Poll until translation completes
 * 6. Download the IFC derivative
 * 7. Convert IFC → GLB using our local pipeline
 */

import { ENV } from "./_core/env";

const APS_BASE = "https://developer.api.autodesk.com";
const BUCKET_KEY = "ifc-wall-viewer-conversions";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 360; // 30 minutes max

// ── OAuth2 Token ──

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getApsToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ENV.apsClientId,
      client_secret: ENV.apsClientSecret,
      grant_type: "client_credentials",
      scope: "data:read data:write data:create bucket:read bucket:create",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`APS OAuth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

// ── Bucket Management ──

async function ensureBucket(token: string): Promise<void> {
  // Try to get bucket first
  const getRes = await fetch(`${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/details`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (getRes.ok) return; // Bucket exists

  // Create bucket
  const createRes = await fetch(`${APS_BASE}/oss/v2/buckets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucketKey: BUCKET_KEY,
      policyKey: "transient", // Auto-delete after 24h
    }),
  });

  if (!createRes.ok && createRes.status !== 409) {
    const text = await createRes.text();
    throw new Error(`Failed to create bucket (${createRes.status}): ${text}`);
  }
}

// ── Upload RVT to APS ──

async function uploadToAps(token: string, objectKey: string, buffer: Buffer): Promise<string> {
  await ensureBucket(token);

  // For files > 5MB, use signed URL upload
  if (buffer.length > 5 * 1024 * 1024) {
    return uploadLargeFile(token, objectKey, buffer);
  }

  // Small file: direct upload
  const res = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": buffer.length.toString(),
      },
      body: new Uint8Array(buffer),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`APS upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.objectId; // urn for translation
}

async function uploadLargeFile(token: string, objectKey: string, buffer: Buffer): Promise<string> {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
  const totalParts = Math.ceil(buffer.length / CHUNK_SIZE);

  // Initiate upload
  const initiateRes = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=60&parts=${totalParts}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!initiateRes.ok) {
    const text = await initiateRes.text();
    throw new Error(`APS signed upload initiate failed (${initiateRes.status}): ${text}`);
  }

  const initiateData = await initiateRes.json();
  const { urls, uploadKey } = initiateData;

  // Upload each part
  const eTags: string[] = [];
  for (let i = 0; i < totalParts; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, buffer.length);
    const chunk = buffer.subarray(start, end);

    const partRes = await fetch(urls[i], {
      method: "PUT",
      headers: {
        "Content-Length": chunk.length.toString(),
      },
      body: new Uint8Array(chunk),
    });

    if (!partRes.ok) {
      throw new Error(`APS part upload failed (part ${i + 1}/${totalParts}): ${partRes.status}`);
    }

    const eTag = partRes.headers.get("ETag") || "";
    eTags.push(eTag);
  }

  // Complete upload
  const completeRes = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadKey }),
    }
  );

  if (!completeRes.ok) {
    const text = await completeRes.text();
    throw new Error(`APS upload complete failed (${completeRes.status}): ${text}`);
  }

  const completeData = await completeRes.json();
  return completeData.objectId;
}

// ── Translation Job (RVT → IFC) ──

function toBase64Urn(objectId: string): string {
  return Buffer.from(objectId).toString("base64url");
}

async function submitTranslation(token: string, urn: string): Promise<string> {
  const base64Urn = toBase64Urn(urn);

  const res = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-ads-force": "true",
    },
    body: JSON.stringify({
      input: { urn: base64Urn },
      output: {
        formats: [
          {
            type: "ifc",
            advanced: {
              exportSettingName: "IFC4 Design Transfer View",
            },
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`APS translation job failed (${res.status}): ${text}`);
  }

  return base64Urn;
}

interface TranslationStatus {
  status: string;
  progress: string;
  derivatives?: Array<{
    outputType: string;
    status: string;
    children?: Array<{
      type: string;
      role: string;
      urn: string;
      mime: string;
    }>;
  }>;
}

async function pollTranslation(
  token: string,
  base64Urn: string,
  onProgress?: (progress: string) => void
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const res = await fetch(
      `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`APS manifest check failed (${res.status}): ${text}`);
    }

    const manifest: TranslationStatus = await res.json();

    if (onProgress) {
      onProgress(manifest.progress || "0%");
    }

    if (manifest.status === "success") {
      // Find the IFC derivative
      for (const deriv of manifest.derivatives || []) {
        if (deriv.outputType === "ifc" && deriv.status === "success") {
          for (const child of deriv.children || []) {
            if (child.role === "ifc" || child.mime === "application/ifc" || child.urn?.endsWith(".ifc")) {
              return child.urn;
            }
          }
          // If no specific child, check for any IFC output
          if (deriv.children && deriv.children.length > 0) {
            return deriv.children[0].urn;
          }
        }
      }
      throw new Error("Translation succeeded but no IFC derivative found in manifest");
    }

    if (manifest.status === "failed") {
      throw new Error("APS translation failed. The RVT file may be corrupted or unsupported.");
    }

    if (manifest.status === "timeout") {
      throw new Error("APS translation timed out. The file may be too large or complex.");
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`APS translation did not complete within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60000} minutes`);
}

// ── Download IFC Derivative ──

async function downloadDerivative(token: string, base64Urn: string, derivativeUrn: string): Promise<Buffer> {
  const encodedDerivUrn = encodeURIComponent(derivativeUrn);
  const res = await fetch(
    `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest/${encodedDerivUrn}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`APS derivative download failed (${res.status}): ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ── Python IFC→GLB for large files ──

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

/**
 * Convert large IFC files to GLB using Python IfcOpenShell.
 * Spawns a child process to avoid Node.js memory limits.
 */
async function convertIFCtoGLBPython(
  ifcBuffer: Buffer,
  onProgress?: (progress: ConversionProgress) => void
): Promise<{ glbBuffer: Uint8Array; meshCount: number; vertexCount: number }> {
  const tmpDir = os.tmpdir();
  const ifcPath = path.join(tmpDir, `convert-${Date.now()}.ifc`);
  const glbPath = path.join(tmpDir, `convert-${Date.now()}.glb`);

  try {
    // Write IFC to temp file
    fs.writeFileSync(ifcPath, ifcBuffer);
    onProgress?.({ step: `Convirtiendo IFC (${(ifcBuffer.length / 1024 / 1024).toFixed(0)}MB) → GLB via IfcOpenShell...` });

    // Find the Python converter script
    const scriptPath = path.resolve("server/convert-ifc-glb.py");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Python converter script not found at ${scriptPath}`);
    }

    // Run Python conversion with generous timeout (30 min for large files)
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [scriptPath, ifcPath, glbPath],
      { timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
    );

    if (stderr) {
      console.warn(`[IFC→GLB Python] stderr: ${stderr}`);
    }

    // Parse mesh count and vertex count from stdout
    let meshCount = 0;
    let vertexCount = 0;
    const meshMatch = stdout.match(/(\d+) meshes/);
    const vertMatch = stdout.match(/([\d,]+) vert/);
    if (meshMatch) meshCount = parseInt(meshMatch[1]);
    if (vertMatch) vertexCount = parseInt(vertMatch[1].replace(/,/g, ""));

    // Read the GLB output
    if (!fs.existsSync(glbPath)) {
      throw new Error(`Python converter did not produce GLB output. stdout: ${stdout}`);
    }

    const glbBuffer = new Uint8Array(fs.readFileSync(glbPath));
    console.log(`[IFC→GLB Python] ${meshCount} meshes, ${vertexCount} verts, ${(glbBuffer.length / 1024 / 1024).toFixed(1)}MB`);

    return { glbBuffer, meshCount, vertexCount };
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(ifcPath); } catch {}
    try { fs.unlinkSync(glbPath); } catch {}
  }
}

// ── Main Pipeline: RVT → IFC → GLB ──

export interface ConversionResult {
  glbBuffer: Uint8Array;
  ifcBuffer: Buffer;
  meshCount: number;
  vertexCount: number;
  conversionSteps: string[];
}

export interface ConversionProgress {
  step: string;
  progress?: string;
}

export async function convertRVTtoGLB(
  rvtBuffer: Buffer,
  fileName: string,
  onProgress?: (progress: ConversionProgress) => void
): Promise<ConversionResult> {
  const steps: string[] = [];

  // Step 1: Get token
  onProgress?.({ step: "Autenticando con Autodesk..." });
  const token = await getApsToken();
  steps.push("OAuth2 token obtained");

  // Step 2: Upload RVT to APS
  onProgress?.({ step: "Subiendo RVT a Autodesk Cloud..." });
  const objectKey = `${Date.now()}-${fileName}`;
  const objectId = await uploadToAps(token, objectKey, rvtBuffer);
  steps.push(`RVT uploaded to APS (${(rvtBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  // Step 3: Submit translation job
  onProgress?.({ step: "Iniciando conversión RVT → IFC..." });
  const base64Urn = await submitTranslation(token, objectId);
  steps.push("Translation job submitted (RVT → IFC4)");

  // Step 4: Poll until complete
  onProgress?.({ step: "Convirtiendo en Autodesk Cloud (puede tardar varios minutos)..." });
  const derivativeUrn = await pollTranslation(token, base64Urn, (progress) => {
    onProgress?.({ step: `Convirtiendo RVT → IFC...`, progress });
  });
  steps.push("IFC4 derivative ready");

  // Step 5: Download IFC
  onProgress?.({ step: "Descargando IFC convertido..." });
  const ifcBuffer = await downloadDerivative(token, base64Urn, derivativeUrn);
  steps.push(`IFC downloaded (${(ifcBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

  // Step 6: Convert IFC → GLB
  // For large IFC files (>50MB), use Python IfcOpenShell (more memory efficient)
  // For small files, use web-ifc (faster)
  onProgress?.({ step: "Convirtiendo IFC → GLB (preservando todos los detalles)..." });

  const IFC_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50MB
  let glbBuffer: Uint8Array;
  let meshCount = 0;
  let vertexCount = 0;

  if (ifcBuffer.length > IFC_SIZE_THRESHOLD) {
    // Use Python IfcOpenShell for large files
    const pyResult = await convertIFCtoGLBPython(ifcBuffer, onProgress);
    glbBuffer = pyResult.glbBuffer;
    meshCount = pyResult.meshCount;
    vertexCount = pyResult.vertexCount;
    steps.push(`GLB generated via IfcOpenShell (${meshCount} meshes, ${vertexCount} vertices)`);
  } else {
    // Use web-ifc for small files (faster)
    const { convertIFCtoGLB } = await import("./convertIFC");
    const result = await convertIFCtoGLB(ifcBuffer);
    glbBuffer = result.glbBuffer;
    meshCount = result.meshCount;
    vertexCount = result.vertexCount;
    steps.push(`GLB generated via web-ifc (${meshCount} meshes, ${vertexCount} vertices)`);
  }

  return {
    glbBuffer,
    ifcBuffer,
    meshCount,
    vertexCount,
    conversionSteps: steps,
  };
}
