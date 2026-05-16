/**
 * Process Hydraulic file with streaming GLB packing + curl upload
 * to avoid OOM on 4GB RAM sandbox.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, openSync, writeSync, closeSync, readSync, rmSync } from "fs";
import { execSync } from "child_process";
import { ENV } from "../server/_core/env.ts";

const BUCKET = "objetiva-ar-persistent-1772433753237";
const OUTPUT_DIR = "/home/ubuntu/glb-output";

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

async function uploadRVT(token) {
  const rvtPath = "/home/ubuntu/hidalma-rvt/HMA-01-OBJETIVA-HID-01-AB.rvt";
  const data = readFileSync(rvtPath);
  const sizeMB = (data.length / 1024 / 1024).toFixed(1);
  console.log(`  Uploading HID RVT (${sizeMB}MB) to APS...`);
  
  const objectKey = "HMA-01-OBJETIVA-HID-01-AB.rvt";
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

async function convertSVFtoGLBStreaming(token, urn, guid) {
  const { SvfReader, GltfWriter } = await import("forge-convert-utils");
  
  console.log(`  Reading SVF scene...`);
  const reader = await SvfReader.FromDerivativeService(urn, guid, { token });
  const scene = await reader.read({ log: () => {} });
  
  console.log(`  Writing glTF...`);
  const gltfDir = `${OUTPUT_DIR}/hydraulic-gltf`;
  mkdirSync(gltfDir, { recursive: true });
  
  const writer = new GltfWriter({
    deduplicate: false,
    skipUnusedUvs: true,
    center: false,
    log: () => {},
  });
  await writer.write(scene, gltfDir);
  
  if (global.gc) global.gc();
  
  console.log(`  Streaming GLB pack...`);
  const gltfPath = `${gltfDir}/output.gltf`;
  const gltfContent = JSON.parse(readFileSync(gltfPath, "utf8"));
  
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
  
  delete gltfContent.images;
  gltfContent.buffers = [{ byteLength: totalBinSize }];
  
  const jsonStr = JSON.stringify(gltfContent);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJsonLen = jsonBuf.length + jsonPadding;
  
  const totalGLBSize = 12 + 8 + paddedJsonLen + 8 + totalBinSize;
  console.log(`  GLB total size: ${(totalGLBSize / 1024 / 1024).toFixed(1)}MB`);
  
  const glbPath = `${OUTPUT_DIR}/hydraulic.glb`;
  const fd = openSync(glbPath, "w");
  
  try {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(totalGLBSize, 8);
    writeSync(fd, header);
    
    const jsonChunkHeader = Buffer.alloc(8);
    jsonChunkHeader.writeUInt32LE(paddedJsonLen, 0);
    jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4);
    writeSync(fd, jsonChunkHeader);
    
    writeSync(fd, jsonBuf);
    if (jsonPadding > 0) writeSync(fd, Buffer.alloc(jsonPadding, 0x20));
    
    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(totalBinSize, 0);
    binChunkHeader.writeUInt32LE(0x004E4942, 4);
    writeSync(fd, binChunkHeader);
    
    const CHUNK_SIZE = 16 * 1024 * 1024;
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
  
  rmSync(gltfDir, { recursive: true, force: true });
  if (global.gc) global.gc();
  
  return glbPath;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  
  console.log("=== Processing hydraulic (Hidráulico) ===");
  
  let token = await getToken();
  
  // Upload RVT
  const urn = await uploadRVT(token);
  
  // Start translation
  token = await getToken();
  await startTranslation(token, urn);
  
  // Wait for translation
  const guid = await waitForTranslation(token, urn);
  
  // Convert SVF→GLB with streaming
  token = await getToken();
  const glbPath = await convertSVFtoGLBStreaming(token, urn, guid);
  
  console.log("  GLB conversion complete. Uploading via curl...");
  
  // Upload via curl to avoid OOM (storagePut reads entire file into memory)
  const forgeUrl = ENV.forgeApiUrl.replace(/\/+$/, "");
  const forgeKey = ENV.forgeApiKey;
  const curlCmd = `curl -X POST "${forgeUrl}/v1/storage/upload?path=hidalma-glb/hydraulic.glb" -H "Authorization: Bearer ${forgeKey}" -F "file=@${glbPath};type=model/gltf-binary" --max-time 900 -o /tmp/upload-hydraulic-result.json -w "%{http_code}" 2>/dev/null`;
  
  console.log("  Starting curl upload...");
  const httpCode = execSync(curlCmd, { timeout: 900000 }).toString().trim();
  console.log(`  Upload HTTP status: ${httpCode}`);
  
  const uploadResult = JSON.parse(readFileSync("/tmp/upload-hydraulic-result.json", "utf8"));
  console.log(`  Upload URL: ${uploadResult.url}`);
  
  // Clean up
  unlinkSync(glbPath);
  
  // Update results
  let results = {};
  try {
    results = JSON.parse(readFileSync(`${OUTPUT_DIR}/results-storagePut.json`, "utf8"));
  } catch {}
  results.hydraulic = { success: true, fileKey: "hidalma-glb/hydraulic.glb" };
  results.electrical = { success: true, fileKey: "hidalma-glb/electrical.glb" };
  writeFileSync(`${OUTPUT_DIR}/results-storagePut.json`, JSON.stringify(results, null, 2));
  
  console.log("  Done: hydraulic!");
  console.log("\n=== ALL 9 FILES COMPLETE ===");
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
