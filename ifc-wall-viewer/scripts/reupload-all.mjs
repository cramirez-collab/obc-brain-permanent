/**
 * Re-upload all 9 RVTs to APS using Direct-to-S3 approach (signed URLs),
 * convert SVF→GLB, upload to permanent S3 via storagePut, update DB.
 * Usage: node --max-old-space-size=3072 --expose-gc scripts/reupload-all.mjs
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { SvfReader, GltfWriter } from "forge-convert-utils";
import mysql from "mysql2/promise";

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const BUCKET_KEY = "ifc-wall-viewer-conversions";
const RVT_DIR = "/home/ubuntu/hidalma-rvt";
const OUTPUT_DIR = "/home/ubuntu/glb-output";
const PART_SIZE = 5 * 1024 * 1024; // 5MB per part

const FILES = [
  { rvt: "HMA-01-OBJETIVA-PCI-01-AB.rvt", specialty: "fire_protection", label: "Protección contra Incendios" },
  { rvt: "HMA-01-OBJETIVA-PLUV-01-AB.rvt", specialty: "pluvial", label: "Pluvial" },
  { rvt: "HMA-01-OBJETIVA-SAN-01-AB.rvt", specialty: "sanitary", label: "Sanitario" },
  { rvt: "HMA-01-OBJETIVA-EST-01-AB.rvt", specialty: "structure", label: "Estructuras" },
  { rvt: "HMA-01-OBJETIVA-GAS-01-AB.rvt", specialty: "gas", label: "Gas" },
  { rvt: "HMA-01-OBJETIVA-HVAC-01-AB.rvt", specialty: "hvac", label: "Aire Acondicionado y Climatización" },
  { rvt: "HMA-01-OBJETIVA-ARQ-01-AB.rvt", specialty: "architecture", label: "Arquitectura" },
  { rvt: "HMA-01-OBJETIVA-ELE-01-AB.rvt", specialty: "electrical", label: "Eléctrico" },
  { rvt: "HMA-01-OBJETIVA-HID-01-AB.rvt", specialty: "hydraulic", label: "Hidráulico" },
];

async function getToken() {
  const res = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APS_CLIENT_ID,
      client_secret: APS_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "data:read data:write bucket:read bucket:create",
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function ensureBucket(token) {
  const res = await fetch(`https://developer.api.autodesk.com/oss/v2/buckets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bucketKey: BUCKET_KEY, policyKey: "transient" }),
  });
  if (res.status === 409) return;
  if (!res.ok) console.log("Bucket creation:", res.status, await res.text());
}

async function uploadToAPS(token, filePath, objectKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const sizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
  console.log(`  Uploading ${objectKey} (${sizeMB}MB) to APS via signed S3...`);

  const totalParts = Math.ceil(fileBuffer.length / PART_SIZE);

  // Step 1: Get signed upload URLs (up to 25 at a time)
  let uploadKey = null;
  let partNum = 1;

  while (partNum <= totalParts) {
    const batchSize = Math.min(25, totalParts - partNum + 1);
    let signedUrl = `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload?firstPart=${partNum}&parts=${batchSize}&minutesExpiration=60`;
    if (uploadKey) signedUrl += `&uploadKey=${encodeURIComponent(uploadKey)}`;

    const signRes = await fetch(signedUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!signRes.ok) {
      throw new Error(`Signed URL request failed: ${signRes.status} ${await signRes.text()}`);
    }
    const signData = await signRes.json();
    uploadKey = signData.uploadKey;
    const urls = signData.urls;

    // Step 2: Upload each part to its signed URL sequentially
    for (let i = 0; i < urls.length; i++) {
      const globalPartIdx = partNum - 1 + i;
      const start = globalPartIdx * PART_SIZE;
      const end = Math.min(start + PART_SIZE, fileBuffer.length);
      // Create a new Buffer copy to avoid subarray issues with fetch
      const partData = Buffer.from(fileBuffer.subarray(start, end));

      let retries = 3;
      let uploaded = false;
      while (retries > 0 && !uploaded) {
        try {
          const putRes = await fetch(urls[i], {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(partData.length),
            },
            body: partData,
          });
          // MUST consume response body to free connection
          await putRes.text();
          if (putRes.ok) {
            uploaded = true;
          } else if (putRes.status === 403) {
            console.log(`\n  Part ${globalPartIdx + 1} got 403, URLs expired`);
            break;
          } else {
            retries--;
            if (retries === 0) throw new Error(`Part ${globalPartIdx + 1} upload failed: ${putRes.status}`);
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (err) {
          retries--;
          if (retries === 0) throw new Error(`Part ${globalPartIdx + 1} network error: ${err.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!uploaded) throw new Error(`Part ${globalPartIdx + 1} failed after retries`);
    }

    partNum += batchSize;
    process.stdout.write(`\r  Uploaded ${Math.min(partNum - 1, totalParts)}/${totalParts} parts    `);
  }
  console.log("");

  // Step 3: Finalize upload
  const completeRes = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
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
    throw new Error(`Upload finalize failed: ${completeRes.status} ${await completeRes.text()}`);
  }
  const completeData = await completeRes.json();
  const urn = Buffer.from(completeData.objectId).toString("base64url");
  console.log(`  Upload complete. URN: ${urn.substring(0, 40)}...`);
  return urn;
}

async function startTranslation(token, urn) {
  console.log(`  Starting SVF translation...`);
  const res = await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-ads-force": "true",
    },
    body: JSON.stringify({
      input: { urn, compressedUrn: false },
      output: { formats: [{ type: "svf", views: ["3d"] }] },
    }),
  });
  if (!res.ok) throw new Error(`Translation start failed: ${res.status} ${await res.text()}`);
  console.log(`  Translation started.`);
}

async function waitForTranslation(token, urn) {
  console.log(`  Waiting for SVF translation...`);
  let currentToken = token;
  const startTime = Date.now();
  while (true) {
    // Refresh token every 50 min
    if (Date.now() - startTime > 50 * 60 * 1000) {
      currentToken = await getToken();
    }
    const res = await fetch(
      `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`,
      { headers: { Authorization: `Bearer ${currentToken}` } }
    );
    if (!res.ok) throw new Error(`Manifest check failed: ${res.status}`);
    const manifest = await res.json();
    const status = manifest.status;
    const progress = manifest.progress || "0%";
    process.stdout.write(`\r  Translation: ${status} (${progress})    `);
    if (status === "success") { console.log(""); return manifest; }
    if (status === "failed" || status === "timeout") throw new Error(`Translation failed: ${status}`);
    await new Promise(r => setTimeout(r, 15000));
  }
}

function findSvfDerivative(manifest) {
  const findGraphics = (obj) => {
    if (obj.role === "graphics" && obj.guid) return obj.guid;
    for (const child of obj.children || []) {
      const found = findGraphics(child);
      if (found) return found;
    }
    return null;
  };
  for (const d of manifest.derivatives || []) {
    if (d.outputType === "svf") {
      const found = findGraphics(d);
      if (found) return found;
    }
  }
  for (const d of manifest.derivatives || []) {
    const found = findGraphics(d);
    if (found) return found;
  }
  return null;
}

async function convertSvfToGlb(token, urn, guid, outputPath) {
  console.log(`  Converting SVF to GLB...`);
  const auth = { token };
  const reader = await SvfReader.FromDerivativeService(urn, guid, auth);
  const scene = await reader.read({ log: () => {}, skipPropertyDb: true });

  const gltfDir = outputPath.replace(".glb", "-gltf");
  fs.mkdirSync(gltfDir, { recursive: true });

  const writer = new GltfWriter({
    deduplicate: false,
    skipUnusedUvs: true,
    center: false,
    log: () => {},
  });
  await writer.write(scene, gltfDir);

  const gltfPath = path.join(gltfDir, "output.gltf");
  if (!fs.existsSync(gltfPath)) throw new Error("output.gltf not found in " + gltfDir);

  // Pack gltf + bins into GLB
  const gltfJson = JSON.parse(fs.readFileSync(gltfPath, "utf-8"));
  const binFiles = [];
  let totalBinSize = 0;

  for (const buf of gltfJson.buffers || []) {
    const binPath = path.join(gltfDir, buf.uri);
    const binData = fs.readFileSync(binPath);
    binFiles.push(binData);
    totalBinSize += binData.length;
    const padding = (4 - (binData.length % 4)) % 4;
    totalBinSize += padding;
  }

  // Merge all buffers
  const mergedBin = Buffer.alloc(totalBinSize);
  let offset = 0;
  const bufferOffsets = [];
  for (const binData of binFiles) {
    bufferOffsets.push(offset);
    binData.copy(mergedBin, offset);
    offset += binData.length;
    offset += (4 - (binData.length % 4)) % 4;
  }

  // Update bufferViews
  if (gltfJson.buffers.length > 1) {
    for (const bv of gltfJson.bufferViews || []) {
      const bufIdx = bv.buffer || 0;
      bv.byteOffset = (bv.byteOffset || 0) + bufferOffsets[bufIdx];
      bv.buffer = 0;
    }
  }

  gltfJson.buffers = [{ byteLength: totalBinSize }];

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJsonBuf = Buffer.alloc(jsonBuf.length + jsonPadding, 0x20);
  jsonBuf.copy(paddedJsonBuf);

  const totalSize = 12 + 8 + paddedJsonBuf.length + 8 + mergedBin.length;
  const glb = Buffer.alloc(totalSize);
  let pos = 0;
  glb.writeUInt32LE(0x46546c67, pos); pos += 4;
  glb.writeUInt32LE(2, pos); pos += 4;
  glb.writeUInt32LE(totalSize, pos); pos += 4;
  glb.writeUInt32LE(paddedJsonBuf.length, pos); pos += 4;
  glb.writeUInt32LE(0x4e4f534a, pos); pos += 4;
  paddedJsonBuf.copy(glb, pos); pos += paddedJsonBuf.length;
  glb.writeUInt32LE(mergedBin.length, pos); pos += 4;
  glb.writeUInt32LE(0x004e4942, pos); pos += 4;
  mergedBin.copy(glb, pos);

  fs.writeFileSync(outputPath, glb);
  console.log(`  GLB written: ${(glb.length / 1024 / 1024).toFixed(1)}MB`);

  // Cleanup gltf dir
  try { fs.rmSync(gltfDir, { recursive: true, force: true }); } catch {}

  return glb;
}

async function uploadToS3(glbBuffer, specialty) {
  console.log(`  Uploading to permanent S3 (${(glbBuffer.length / 1024 / 1024).toFixed(1)}MB)...`);
  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const fileKey = `projects/60001/${specialty}-${randomSuffix}.glb`;

  const baseUrl = FORGE_API_URL.replace(/\/+$/, "");
  const uploadUrl = new URL("v1/storage/upload", baseUrl + "/");
  uploadUrl.searchParams.set("path", fileKey);

  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${specialty}.glb"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(header);
  const footerBuf = Buffer.from(footer);
  const body = Buffer.concat([headerBuf, glbBuffer, footerBuf]);

  const res = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FORGE_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 upload failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  console.log(`  S3 URL: ${data.url.substring(0, 80)}...`);
  return data.url;
}

async function updateDB(specialty, url, fileSize) {
  const conn = await mysql.createConnection(DATABASE_URL);
  await conn.execute(
    "UPDATE project_files SET url = ?, fileSize = ?, conversionStatus = 'ready' WHERE projectId = 60001 AND specialty = ?",
    [url, fileSize, specialty]
  );
  await conn.end();
  console.log(`  DB updated.`);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let token = await getToken();
  let tokenTime = Date.now();
  await ensureBucket(token);

  const results = [];

  for (let i = 0; i < FILES.length; i++) {
    const file = FILES[i];
    console.log(`\n[${i + 1}/${FILES.length}] Processing ${file.specialty} (${file.label})`);

    try {
      // Refresh token if older than 50 min
      if (Date.now() - tokenTime > 50 * 60 * 1000) {
        token = await getToken();
        tokenTime = Date.now();
      }

      const rvtPath = path.join(RVT_DIR, file.rvt);
      if (!fs.existsSync(rvtPath)) {
        console.log(`  SKIP: RVT not found`);
        results.push({ ...file, status: "skip", error: "RVT not found" });
        continue;
      }

      // 1. Upload RVT to APS via signed S3
      const objectKey = `hidalma-${file.specialty}-${Date.now()}.rvt`;
      const urn = await uploadToAPS(token, rvtPath, objectKey);

      // 2. Start SVF translation
      await startTranslation(token, urn);

      // 3. Wait for translation (refresh token before)
      token = await getToken();
      tokenTime = Date.now();
      const manifest = await waitForTranslation(token, urn);

      // 4. Find SVF derivative GUID
      const guid = findSvfDerivative(manifest);
      if (!guid) throw new Error("No SVF graphics derivative found");
      console.log(`  SVF GUID: ${guid}`);

      // 5. Convert SVF to GLB (refresh token)
      token = await getToken();
      tokenTime = Date.now();
      const glbPath = path.join(OUTPUT_DIR, `${file.specialty}.glb`);
      const glbBuffer = await convertSvfToGlb(token, urn, guid, glbPath);

      // 6. Upload GLB to permanent S3
      const s3Url = await uploadToS3(glbBuffer, file.specialty);

      // 7. Update DB
      await updateDB(file.specialty, s3Url, glbBuffer.length);

      // 8. Cleanup
      try { fs.unlinkSync(glbPath); } catch {}

      results.push({ ...file, status: "success", url: s3Url, size: glbBuffer.length });
      console.log(`  ✅ ${file.specialty} DONE (${(glbBuffer.length / 1024 / 1024).toFixed(1)}MB)`);

      if (global.gc) global.gc();
    } catch (err) {
      console.error(`  ❌ ${file.specialty} FAILED:`, err.message);
      results.push({ ...file, status: "error", error: err.message });
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "results-final.json"), JSON.stringify(results, null, 2));
  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`${r.specialty}: ${r.status} ${r.size ? `(${(r.size / 1024 / 1024).toFixed(1)}MB)` : r.error || ""}`);
  }
  console.log(`\n${results.filter(r => r.status === "success").length}/${FILES.length} completed.`);
}

main().catch(console.error);
