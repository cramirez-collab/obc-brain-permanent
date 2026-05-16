/**
 * Convert electrical and hydraulic SVF→GLB using low-memory approach:
 * 1. Stop dev server to free memory
 * 2. Read SVF scene
 * 3. Write to glTF directory
 * 4. Stream-pack glTF→GLB without loading all bins into memory
 * 5. Upload to permanent S3 via storagePut
 * 6. Update DB
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
const OUTPUT_DIR = "/home/ubuntu/glb-output";
const RVT_DIR = "/home/ubuntu/hidalma-rvt";
const PART_SIZE = 5 * 1024 * 1024;

async function getToken() {
  const res = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APS_CLIENT_ID, client_secret: APS_CLIENT_SECRET,
      grant_type: "client_credentials", scope: "data:read data:write bucket:read bucket:create",
    }),
  });
  return (await res.json()).access_token;
}

async function ensureBucket(token) {
  await fetch("https://developer.api.autodesk.com/oss/v2/buckets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey: BUCKET_KEY, policyKey: "transient" }),
  });
}

async function uploadToAPS(token, filePath, objectKey) {
  const fileBuffer = fs.readFileSync(filePath);
  const totalParts = Math.ceil(fileBuffer.length / PART_SIZE);
  console.log(`  Uploading ${objectKey} (${(fileBuffer.length/1024/1024).toFixed(1)}MB, ${totalParts} parts)...`);

  let uploadKey = null;
  let partNum = 1;
  while (partNum <= totalParts) {
    const batchSize = Math.min(25, totalParts - partNum + 1);
    let url = `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload?firstPart=${partNum}&parts=${batchSize}&minutesExpiration=60`;
    if (uploadKey) url += `&uploadKey=${encodeURIComponent(uploadKey)}`;
    const signRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const signData = await signRes.json();
    if (!uploadKey) uploadKey = signData.uploadKey;

    for (let i = 0; i < signData.urls.length; i++) {
      const idx = partNum - 1 + i;
      const start = idx * PART_SIZE;
      const end = Math.min(start + PART_SIZE, fileBuffer.length);
      const partData = Buffer.from(fileBuffer.subarray(start, end));
      const putRes = await fetch(signData.urls[i], {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(partData.length) },
        body: partData,
      });
      await putRes.text();
      if (!putRes.ok) throw new Error(`Part ${idx+1} failed: ${putRes.status}`);
    }
    partNum += batchSize;
    process.stdout.write(`\r  Uploaded ${Math.min(partNum-1, totalParts)}/${totalParts} parts`);
  }
  console.log("");

  const completeRes = await fetch(
    `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ uploadKey }) }
  );
  if (!completeRes.ok) throw new Error(`Finalize failed: ${completeRes.status}`);
  const data = await completeRes.json();
  return Buffer.from(data.objectId).toString("base64url");
}

async function startAndWaitTranslation(token, urn) {
  await fetch("https://developer.api.autodesk.com/modelderivative/v2/designdata/job", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-ads-force": "true" },
    body: JSON.stringify({ input: { urn }, output: { formats: [{ type: "svf", views: ["3d"] }] } }),
  });
  console.log("  Translation started...");
  let currentToken = token;
  const start = Date.now();
  while (true) {
    if (Date.now() - start > 50*60*1000) currentToken = await getToken();
    const res = await fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`, { headers: { Authorization: `Bearer ${currentToken}` } });
    const manifest = await res.json();
    process.stdout.write(`\r  Translation: ${manifest.status} (${manifest.progress || "0%"})    `);
    if (manifest.status === "success") { console.log(""); return manifest; }
    if (manifest.status === "failed") throw new Error("Translation failed");
    await new Promise(r => setTimeout(r, 15000));
  }
}

function findSvfGuid(manifest) {
  const find = (obj) => {
    if (obj.role === "graphics" && obj.guid) return obj.guid;
    for (const c of obj.children || []) { const f = find(c); if (f) return f; }
    return null;
  };
  for (const d of manifest.derivatives || []) { const f = find(d); if (f) return f; }
  return null;
}

async function convertSvfToGlb(token, urn, guid, specialty) {
  console.log("  Reading SVF scene...");
  const reader = await SvfReader.FromDerivativeService(urn, guid, { token });
  const scene = await reader.read({ log: () => {}, skipPropertyDb: true });

  const gltfDir = path.join(OUTPUT_DIR, `${specialty}-gltf`);
  fs.mkdirSync(gltfDir, { recursive: true });

  console.log("  Writing glTF...");
  const writer = new GltfWriter({ deduplicate: false, skipUnusedUvs: true, center: false, log: () => {} });
  await writer.write(scene, gltfDir);

  // Force GC after SVF read
  if (global.gc) global.gc();

  console.log("  Packing GLB (streaming)...");
  const gltfPath = path.join(gltfDir, "output.gltf");
  const gltfJson = JSON.parse(fs.readFileSync(gltfPath, "utf-8"));

  // Calculate total binary size and offsets
  const bufferInfos = [];
  let totalBinSize = 0;
  for (const buf of gltfJson.buffers || []) {
    const binPath = path.join(gltfDir, buf.uri);
    const stat = fs.statSync(binPath);
    const padding = (4 - (stat.size % 4)) % 4;
    bufferInfos.push({ path: binPath, size: stat.size, offset: totalBinSize, padding });
    totalBinSize += stat.size + padding;
  }

  // Update bufferViews to point to merged buffer
  if (gltfJson.buffers.length > 1) {
    for (const bv of gltfJson.bufferViews || []) {
      const bufIdx = bv.buffer || 0;
      bv.byteOffset = (bv.byteOffset || 0) + bufferInfos[bufIdx].offset;
      bv.buffer = 0;
    }
  }
  gltfJson.buffers = [{ byteLength: totalBinSize }];

  const jsonStr = JSON.stringify(gltfJson);
  const jsonBuf = Buffer.from(jsonStr);
  const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
  const paddedJsonLen = jsonBuf.length + jsonPadding;

  const totalGlbSize = 12 + 8 + paddedJsonLen + 8 + totalBinSize;
  console.log(`  GLB size will be: ${(totalGlbSize/1024/1024).toFixed(1)}MB`);

  // Write GLB using streaming to avoid loading all bins into memory at once
  const glbPath = path.join(OUTPUT_DIR, `${specialty}.glb`);
  const fd = fs.openSync(glbPath, "w");

  // GLB header (12 bytes)
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(totalGlbSize, 8); // total length
  fs.writeSync(fd, header);

  // JSON chunk header (8 bytes)
  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(paddedJsonLen, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // JSON
  fs.writeSync(fd, jsonChunkHeader);

  // JSON data + padding
  fs.writeSync(fd, jsonBuf);
  if (jsonPadding > 0) fs.writeSync(fd, Buffer.alloc(jsonPadding, 0x20));

  // BIN chunk header (8 bytes)
  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(totalBinSize, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4); // BIN
  fs.writeSync(fd, binChunkHeader);

  // Stream each bin file
  for (let i = 0; i < bufferInfos.length; i++) {
    const info = bufferInfos[i];
    // Read in 10MB chunks to avoid loading huge bins into memory
    const CHUNK = 10 * 1024 * 1024;
    const binFd = fs.openSync(info.path, "r");
    let bytesRead = 0;
    while (bytesRead < info.size) {
      const toRead = Math.min(CHUNK, info.size - bytesRead);
      const chunk = Buffer.alloc(toRead);
      fs.readSync(binFd, chunk, 0, toRead, bytesRead);
      fs.writeSync(fd, chunk);
      bytesRead += toRead;
    }
    fs.closeSync(binFd);
    if (info.padding > 0) fs.writeSync(fd, Buffer.alloc(info.padding, 0));
    process.stdout.write(`\r  Packed bin ${i+1}/${bufferInfos.length}    `);
  }
  fs.closeSync(fd);
  console.log(`\n  GLB written: ${(fs.statSync(glbPath).size/1024/1024).toFixed(1)}MB`);

  // Cleanup gltf dir
  try { fs.rmSync(gltfDir, { recursive: true, force: true }); } catch {}
  if (global.gc) global.gc();

  return glbPath;
}

async function uploadGlbToS3(glbPath, specialty) {
  const fileSize = fs.statSync(glbPath).size;
  console.log(`  Uploading to permanent S3 (${(fileSize/1024/1024).toFixed(1)}MB)...`);

  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const fileKey = `projects/60001/${specialty}-${randomSuffix}.glb`;
  const baseUrl = FORGE_API_URL.replace(/\/+$/, "");
  const uploadUrl = new URL("v1/storage/upload", baseUrl + "/");
  uploadUrl.searchParams.set("path", fileKey);

  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${specialty}.glb"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footerStr = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(headerStr);
  const footerBuf = Buffer.from(footerStr);
  const fileBuf = fs.readFileSync(glbPath);
  const body = Buffer.concat([headerBuf, fileBuf, footerBuf]);

  const res = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FORGE_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body,
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`  S3 URL: ${data.url.substring(0, 80)}...`);
  return { url: data.url, size: fileSize };
}

async function updateDB(specialty, url, fileSize) {
  const conn = await mysql.createConnection(DATABASE_URL);
  await conn.execute(
    "UPDATE project_files SET url = ?, fileSize = ?, conversionStatus = 'ready' WHERE projectId = 60001 AND specialty = ?",
    [url, fileSize, specialty]
  );
  await conn.end();
}

async function processFile(specialty, rvtFile, label) {
  console.log(`\nProcessing ${specialty} (${label})`);
  let token = await getToken();

  // 1. Upload RVT to APS
  const rvtPath = path.join(RVT_DIR, rvtFile);
  const objectKey = `hidalma-${specialty}-${Date.now()}.rvt`;
  const urn = await uploadToAPS(token, rvtPath, objectKey);

  // 2. Translate to SVF
  token = await getToken();
  const manifest = await startAndWaitTranslation(token, urn);
  const guid = findSvfGuid(manifest);
  if (!guid) throw new Error("No SVF graphics found");
  console.log(`  GUID: ${guid}`);

  // 3. Convert SVF→GLB (low-mem streaming)
  token = await getToken();
  const glbPath = await convertSvfToGlb(token, urn, guid, specialty);

  // 4. Upload to permanent S3
  const { url, size } = await uploadGlbToS3(glbPath, specialty);

  // 5. Update DB
  await updateDB(specialty, url, size);
  console.log(`  ✅ ${specialty} DONE (${(size/1024/1024).toFixed(1)}MB)`);

  // Cleanup
  try { fs.unlinkSync(glbPath); } catch {}
  if (global.gc) global.gc();
}

// Process the 2 large files
const target = process.argv[2]; // "electrical" or "hydraulic"
const FILES = {
  electrical: { rvt: "HMA-01-OBJETIVA-ELE-01-AB.rvt", label: "Eléctrico" },
  hydraulic: { rvt: "HMA-01-OBJETIVA-HID-01-AB.rvt", label: "Hidráulico" },
};

if (target && FILES[target]) {
  await processFile(target, FILES[target].rvt, FILES[target].label);
} else {
  // Process both
  for (const [key, val] of Object.entries(FILES)) {
    try {
      await processFile(key, val.rvt, val.label);
    } catch (err) {
      console.error(`  ❌ ${key} FAILED:`, err.message);
    }
  }
}
