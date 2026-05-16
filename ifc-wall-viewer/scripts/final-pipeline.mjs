/**
 * Final pipeline: Upload RVTs to persistent APS bucket, convert SVF→GLB, 
 * upload GLBs via storagePut for permanent URLs, update DB.
 * 
 * Process one file at a time to avoid OOM.
 * For large files (>200MB GLB), use streaming GLB packing.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { ENV } from "../server/_core/env.ts";
import { storagePut } from "../server/storage.ts";

const BUCKET = "objetiva-ar-persistent-1772433753237";
const OUTPUT_DIR = "/home/ubuntu/glb-output";

const FILES = [
  { name: "fire_protection", rvt: "HMA-01-OBJETIVA-PCI-01-AB.rvt", label: "Protección contra incendios" },
  { name: "pluvial", rvt: "HMA-01-OBJETIVA-PLUV-01-AB.rvt", label: "Pluvial" },
  { name: "sanitary", rvt: "HMA-01-OBJETIVA-SAN-01-AB.rvt", label: "Sanitario" },
  { name: "structure", rvt: "HMA-01-OBJETIVA-EST-01-AB.rvt", label: "Estructura" },
  { name: "gas", rvt: "HMA-01-OBJETIVA-GAS-01-AB.rvt", label: "Gas" },
  { name: "hvac", rvt: "HMA-01-OBJETIVA-HVAC-01-AB.rvt", label: "HVAC" },
  { name: "architecture", rvt: "HMA-01-OBJETIVA-ARQ-01-AB.rvt", label: "Arquitectura" },
  { name: "electrical", rvt: "HMA-01-OBJETIVA-ELE-01-AB.rvt", label: "Eléctrico" },
  { name: "hydraulic", rvt: "HMA-01-OBJETIVA-HID-01-AB.rvt", label: "Hidráulico" },
];

// Skip files that already have working URLs (pass via env)
const SKIP = (process.env.SKIP || "").split(",").filter(Boolean);

async function getToken() {
  const resp = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: ENV.apsClientId,
      client_secret: ENV.apsClientSecret,
      scope: "data:read data:write bucket:read bucket:create",
    }),
  });
  return (await resp.json()).access_token;
}

async function uploadRVT(token, file) {
  const rvtPath = `/home/ubuntu/hidalma-rvt/${file.rvt}`;
  const data = readFileSync(rvtPath);
  const sizeMB = (data.length / 1024 / 1024).toFixed(1);
  console.log(`  Uploading ${file.rvt} (${sizeMB}MB) to APS...`);

  // Use signed S3 upload for large files
  const PART_SIZE = 5 * 1024 * 1024; // 5MB parts
  const totalParts = Math.ceil(data.length / PART_SIZE);
  
  // Get signed URLs
  let uploadKey = null;
  const allUrls = [];
  
  for (let firstPart = 1; firstPart <= totalParts; firstPart += 25) {
    const lastPart = Math.min(firstPart + 24, totalParts);
    const url = new URL(`https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(file.rvt)}/signeds3upload`);
    url.searchParams.set("firstPart", String(firstPart));
    url.searchParams.set("parts", String(lastPart - firstPart + 1));
    if (uploadKey) url.searchParams.set("uploadKey", uploadKey);
    
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await resp.json();
    uploadKey = json.uploadKey;
    allUrls.push(...json.urls);
  }
  
  // Upload parts
  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, data.length);
    const part = data.subarray(start, end);
    const resp = await fetch(allUrls[i], {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(part),
    });
    if (!resp.ok) throw new Error(`Part ${i+1} upload failed: ${resp.status}`);
    await resp.text();
  }
  
  // Complete upload
  const completeResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(file.rvt)}/signeds3upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uploadKey }),
    }
  );
  const result = await completeResp.json();
  const urn = Buffer.from(result.objectId).toString("base64url");
  console.log(`  Upload complete. URN: ${urn}`);
  return urn;
}

async function startTranslation(token, urn) {
  console.log(`  Starting SVF translation...`);
  const resp = await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
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
  const result = await resp.json();
  console.log(`  Translation started: ${result.result}`);
}

async function waitForTranslation(token, urn) {
  while (true) {
    const resp = await fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const manifest = await resp.json();
    const status = manifest.status;
    const progress = manifest.progress || "0%";
    
    if (status === "success") {
      // Find the SVF derivative
      for (const d of manifest.derivatives || []) {
        if (d.outputType === "svf") {
          for (const c of d.children || []) {
            if (c.type === "geometry" && c.role === "3d") {
              // Find the graphics resource
              for (const gc of c.children || []) {
                if (gc.role === "graphics" && gc.mime === "application/autodesk-svf") {
                  console.log(`  Translation complete. GUID: ${gc.guid}`);
                  return gc.guid;
                }
              }
            }
          }
        }
      }
      throw new Error("No SVF graphics found in manifest");
    }
    
    if (status === "failed") throw new Error("Translation failed");
    
    process.stdout.write(`  Translation: ${progress}\r`);
    await new Promise(r => setTimeout(r, 15000));
    // Refresh token every 30 minutes
    token = await getToken();
  }
}

async function convertSVFtoGLB(token, urn, guid, name) {
  const { SvfReader, GltfWriter } = await import("forge-convert-utils");
  
  console.log(`  Reading SVF scene...`);
  const reader = await SvfReader.FromDerivativeService(urn, guid, { token });
  const scene = await reader.read({ log: () => {} });
  
  console.log(`  Writing glTF...`);
  const gltfDir = `${OUTPUT_DIR}/${name}-gltf`;
  mkdirSync(gltfDir, { recursive: true });
  
  const writer = new GltfWriter({
    deduplicate: false,
    skipUnusedUvs: true,
    center: false,
    log: () => {},
  });
  await writer.write(scene, gltfDir);
  
  // Pack glTF to GLB
  console.log(`  Packing GLB...`);
  const gltfPath = `${gltfDir}/output.gltf`;
  const gltfContent = JSON.parse(readFileSync(gltfPath, "utf8"));
  
  // Read all binary buffers
  const buffers = [];
  let totalBinSize = 0;
  for (const buf of gltfContent.buffers || []) {
    const binPath = `${gltfDir}/${buf.uri}`;
    const binData = readFileSync(binPath);
    buffers.push(binData);
    totalBinSize += binData.length;
  }
  
  // Update buffer references for GLB (single buffer)
  let offset = 0;
  const bufferViews = gltfContent.bufferViews || [];
  for (const bv of bufferViews) {
    const bufIdx = bv.buffer;
    let bufOffset = 0;
    for (let i = 0; i < bufIdx; i++) {
      bufOffset += buffers[i].length;
      // Align to 4 bytes
      bufOffset = (bufOffset + 3) & ~3;
    }
    bv.byteOffset = (bv.byteOffset || 0) + bufOffset;
    bv.buffer = 0;
  }
  
  // Merge all buffers with 4-byte alignment
  const mergedParts = [];
  let mergedSize = 0;
  for (const buf of buffers) {
    mergedParts.push(buf);
    mergedSize += buf.length;
    const padding = (4 - (buf.length % 4)) % 4;
    if (padding > 0) {
      mergedParts.push(Buffer.alloc(padding));
      mergedSize += padding;
    }
  }
  const mergedBuffer = Buffer.concat(mergedParts);
  
  // Remove buffer URIs, set single buffer
  delete gltfContent.images; // Remove texture references
  gltfContent.buffers = [{ byteLength: mergedBuffer.length }];
  
  const jsonStr = JSON.stringify(gltfContent);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuf, Buffer.alloc(jsonPadding, 0x20)]);
  
  const binPadding = (4 - (mergedBuffer.length % 4)) % 4;
  const paddedBin = Buffer.concat([mergedBuffer, Buffer.alloc(binPadding)]);
  
  // GLB header
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); // glTF magic
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBin.length, 8); // total length
  
  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJson.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // JSON
  
  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(paddedBin.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4); // BIN
  
  const glb = Buffer.concat([header, jsonChunkHeader, paddedJson, binChunkHeader, paddedBin]);
  const glbPath = `${OUTPUT_DIR}/${name}.glb`;
  writeFileSync(glbPath, glb);
  
  const sizeMB = (glb.length / 1024 / 1024).toFixed(1);
  console.log(`  GLB written: ${sizeMB}MB`);
  
  // Clean up gltf dir
  rmSync(gltfDir, { recursive: true, force: true });
  
  return glbPath;
}

async function uploadGLBtoS3(name, glbPath) {
  const data = readFileSync(glbPath);
  const sizeMB = (data.length / 1024 / 1024).toFixed(1);
  console.log(`  Uploading GLB to S3 via storagePut (${sizeMB}MB)...`);
  
  const fileKey = `hidalma-glb/${name}.glb`;
  const result = await storagePut(fileKey, data, "model/gltf-binary");
  console.log(`  S3 upload complete. Key: ${result.key}`);
  
  // Clean up local GLB
  unlinkSync(glbPath);
  
  return result.key;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const results = {};
  
  for (const file of FILES) {
    if (SKIP.includes(file.name)) {
      console.log(`\n[${file.name}] SKIPPED`);
      continue;
    }
    
    console.log(`\n=== Processing ${file.name} (${file.label}) ===`);
    
    try {
      let token = await getToken();
      
      // Step 1: Upload RVT to APS
      const urn = await uploadRVT(token, file);
      
      // Step 2: Start SVF translation
      token = await getToken();
      await startTranslation(token, urn);
      
      // Step 3: Wait for translation
      const guid = await waitForTranslation(token, urn);
      
      // Step 4: Convert SVF→GLB
      token = await getToken();
      const glbPath = await convertSVFtoGLB(token, urn, guid, file.name);
      
      // Step 5: Upload GLB to S3 via storagePut
      const fileKey = await uploadGLBtoS3(file.name, glbPath);
      
      results[file.name] = { success: true, fileKey };
      console.log(`  ✅ ${file.name} complete!`);
      
      // Force GC
      if (global.gc) global.gc();
      
    } catch (err) {
      console.error(`  ❌ ${file.name} failed:`, err.message);
      results[file.name] = { success: false, error: err.message };
    }
    
    // Save intermediate results
    writeFileSync(`${OUTPUT_DIR}/results-storagePut.json`, JSON.stringify(results, null, 2));
  }
  
  console.log("\n=== FINAL RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
