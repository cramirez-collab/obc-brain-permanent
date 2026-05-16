/**
 * Process large files (Electrical, Hydraulic) with streaming GLB packing
 * to avoid OOM on 4GB RAM sandbox.
 * 
 * Uses file-based streaming: writes GLB directly to disk chunk by chunk
 * instead of building the entire buffer in memory.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, openSync, writeSync, closeSync, readSync } from "fs";
import { rmSync } from "fs";
import { ENV } from "../server/_core/env.ts";
import { storagePut } from "../server/storage.ts";

const BUCKET = "objetiva-ar-persistent-1772433753237";
const OUTPUT_DIR = "/home/ubuntu/glb-output";

const FILES_TO_PROCESS = [
  { 
    name: "electrical", 
    rvt: "HMA-01-OBJETIVA-ELE-01-AB.rvt", 
    label: "Eléctrico",
    urn: "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6b2JqZXRpdmEtYXItcGVyc2lzdGVudC0xNzcyNDMzNzUzMjM3L0hNQS0wMS1PQkpFVElWQS1FTEUtMDEtQUIucnZ0",
    guid: "3ef275c5-a081-81fc-44a3-af974bbb15e3",
    skipUploadTranslate: true,
  },
  { 
    name: "hydraulic", 
    rvt: "HMA-01-OBJETIVA-HID-01-AB.rvt", 
    label: "Hidráulico",
    skipUploadTranslate: false,
  },
];

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
  
  const objectKey = file.rvt;
  const signResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=60`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const signData = await signResp.json();
  
  await fetch(signData.urls[0], {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
  });
  
  const completeResp = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uploadKey: signData.uploadKey }),
    }
  );
  const obj = await completeResp.json();
  const urn = Buffer.from(obj.objectId).toString("base64url");
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
      for (const d of manifest.derivatives || []) {
        if (d.outputType === "svf") {
          for (const c of d.children || []) {
            if (c.type === "geometry" && c.role === "3d") {
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
    
    process.stdout.write(`\r  Translation: ${progress}      `);
    await new Promise(r => setTimeout(r, 15000));
    token = await getToken();
  }
}

/**
 * STREAMING GLB conversion - writes directly to file to avoid OOM
 */
async function convertSVFtoGLBStreaming(token, urn, guid, name) {
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
  
  // Force GC after scene write
  if (global.gc) global.gc();
  
  console.log(`  Streaming GLB pack...`);
  const gltfPath = `${gltfDir}/output.gltf`;
  const gltfContent = JSON.parse(readFileSync(gltfPath, "utf8"));
  
  // Calculate buffer sizes and offsets WITHOUT loading buffers into memory
  const bufferInfos = [];
  let totalBinSize = 0;
  for (const buf of gltfContent.buffers || []) {
    const binPath = `${gltfDir}/${buf.uri}`;
    const size = statSync(binPath).size;
    const paddedSize = size + ((4 - (size % 4)) % 4);
    bufferInfos.push({ path: binPath, size, paddedSize });
    totalBinSize += paddedSize;
  }
  
  console.log(`  Total binary size: ${(totalBinSize / 1024 / 1024).toFixed(1)}MB across ${bufferInfos.length} buffers`);
  
  // Update buffer views with correct offsets
  const bufferStartOffsets = [];
  let bufferOffset = 0;
  for (const info of bufferInfos) {
    bufferStartOffsets.push(bufferOffset);
    bufferOffset += info.paddedSize;
  }
  
  const bufferViews = gltfContent.bufferViews || [];
  for (const bv of bufferViews) {
    const bufIdx = bv.buffer;
    bv.byteOffset = (bv.byteOffset || 0) + bufferStartOffsets[bufIdx];
    bv.buffer = 0;
  }
  
  // Remove texture references, set single buffer
  delete gltfContent.images;
  gltfContent.buffers = [{ byteLength: totalBinSize }];
  
  const jsonStr = JSON.stringify(gltfContent);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJsonLen = jsonBuf.length + jsonPadding;
  
  const totalGLBSize = 12 + 8 + paddedJsonLen + 8 + totalBinSize;
  console.log(`  GLB total size: ${(totalGLBSize / 1024 / 1024).toFixed(1)}MB`);
  
  // Write GLB to file using streaming (fd-based writes)
  const glbPath = `${OUTPUT_DIR}/${name}.glb`;
  const fd = openSync(glbPath, "w");
  
  try {
    // GLB header (12 bytes)
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0); // glTF magic
    header.writeUInt32LE(2, 4); // version
    header.writeUInt32LE(totalGLBSize, 8);
    writeSync(fd, header);
    
    // JSON chunk header (8 bytes)
    const jsonChunkHeader = Buffer.alloc(8);
    jsonChunkHeader.writeUInt32LE(paddedJsonLen, 0);
    jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4);
    writeSync(fd, jsonChunkHeader);
    
    // JSON content
    writeSync(fd, jsonBuf);
    if (jsonPadding > 0) writeSync(fd, Buffer.alloc(jsonPadding, 0x20));
    
    // BIN chunk header (8 bytes)
    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(totalBinSize, 0);
    binChunkHeader.writeUInt32LE(0x004E4942, 4);
    writeSync(fd, binChunkHeader);
    
    // Write each binary buffer one at a time (streaming - never all in memory)
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunks
    for (let i = 0; i < bufferInfos.length; i++) {
      const info = bufferInfos[i];
      const binFd = openSync(info.path, "r");
      let bytesWritten = 0;
      
      while (bytesWritten < info.size) {
        const toRead = Math.min(CHUNK_SIZE, info.size - bytesWritten);
        const buf = Buffer.alloc(toRead);
        const n = readSync(binFd, buf, 0, toRead, bytesWritten);
        writeSync(fd, buf, 0, n);
        bytesWritten += n;
      }
      closeSync(binFd);
      
      // Add padding
      const padding = info.paddedSize - info.size;
      if (padding > 0) writeSync(fd, Buffer.alloc(padding));
      
      if ((i + 1) % 20 === 0 || i === bufferInfos.length - 1) {
        console.log(`  Written buffer ${i + 1}/${bufferInfos.length}`);
        if (global.gc) global.gc();
      }
    }
  } finally {
    closeSync(fd);
  }
  
  const finalSize = statSync(glbPath).size;
  console.log(`  GLB written: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
  
  // Clean up gltf dir to free disk
  rmSync(gltfDir, { recursive: true, force: true });
  if (global.gc) global.gc();
  
  return glbPath;
}

async function uploadGLBtoS3Streaming(name, glbPath) {
  const fileSize = statSync(glbPath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  console.log(`  Uploading GLB to S3 via storagePut (${sizeMB}MB)...`);
  
  const data = readFileSync(glbPath);
  const fileKey = `hidalma-glb/${name}.glb`;
  const result = await storagePut(fileKey, data, "model/gltf-binary");
  console.log(`  S3 upload complete. Key: ${result.key}`);
  
  unlinkSync(glbPath);
  if (global.gc) global.gc();
  
  return result.key;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  
  // Load existing results
  let results = {};
  try {
    results = JSON.parse(readFileSync(`${OUTPUT_DIR}/results-storagePut.json`, "utf8"));
  } catch {}
  
  for (const file of FILES_TO_PROCESS) {
    // Skip if already done
    if (results[file.name] && results[file.name].success) {
      console.log(`\n[${file.name}] Already complete, skipping.`);
      continue;
    }
    
    console.log(`\n=== Processing ${file.name} (${file.label}) ===`);
    
    try {
      let token = await getToken();
      let urn = file.urn;
      let guid = file.guid;
      
      if (!file.skipUploadTranslate) {
        urn = await uploadRVT(token, file);
        token = await getToken();
        await startTranslation(token, urn);
        guid = await waitForTranslation(token, urn);
      } else {
        console.log(`  Skipping upload/translate (already done).`);
      }
      
      // Convert SVF to GLB with streaming
      token = await getToken();
      const glbPath = await convertSVFtoGLBStreaming(token, urn, guid, file.name);
      
      // Upload to S3
      const fileKey = await uploadGLBtoS3Streaming(file.name, glbPath);
      
      results[file.name] = { success: true, fileKey };
      console.log(`  Done: ${file.name}!`);
      
    } catch (err) {
      console.error(`  FAILED ${file.name}:`, err.message);
      results[file.name] = { success: false, error: err.message };
    }
    
    writeFileSync(`${OUTPUT_DIR}/results-storagePut.json`, JSON.stringify(results, null, 2));
    if (global.gc) global.gc();
  }
  
  console.log("\n=== FINAL RESULTS ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
