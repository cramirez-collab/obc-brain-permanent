/**
 * Convert hydraulic SVF→GLB only (SVF already translated in APS)
 * Then upload via curl subprocess to avoid OOM during S3 upload
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { SvfReader, GltfWriter } from "forge-convert-utils";

const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const OUTPUT_DIR = "/home/ubuntu/glb-output";

async function getToken() {
  const res = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APS_CLIENT_ID, client_secret: APS_CLIENT_SECRET,
      grant_type: "client_credentials", scope: "data:read data:write bucket:read",
    }),
  });
  return (await res.json()).access_token;
}

const URN = "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6aWZjLXdhbGwtdmlld2VyLWNvbnZlcnNpb25zL2hpZGFsbWEtaHlkcmF1bGljLTE3NzI0MzE4ODQ5NzgucnZ0";
const GUID = "f1ea3de8-0465-b597-f929-52bcb45b03b3";

console.log("Converting hydraulic SVF→GLB...");
const token = await getToken();

console.log("  Reading SVF scene...");
const reader = await SvfReader.FromDerivativeService(URN, GUID, { token });
const scene = await reader.read({ log: () => {}, skipPropertyDb: true });

const gltfDir = path.join(OUTPUT_DIR, "hydraulic-gltf");
fs.mkdirSync(gltfDir, { recursive: true });

console.log("  Writing glTF...");
const writer = new GltfWriter({ deduplicate: false, skipUnusedUvs: true, center: false, log: () => {} });
await writer.write(scene, gltfDir);

// Force GC
if (global.gc) global.gc();

console.log("  Packing GLB (streaming)...");
const gltfPath = path.join(gltfDir, "output.gltf");
const gltfJson = JSON.parse(fs.readFileSync(gltfPath, "utf-8"));

const bufferInfos = [];
let totalBinSize = 0;
for (const buf of gltfJson.buffers || []) {
  const binPath = path.join(gltfDir, buf.uri);
  const stat = fs.statSync(binPath);
  const padding = (4 - (stat.size % 4)) % 4;
  bufferInfos.push({ path: binPath, size: stat.size, offset: totalBinSize, padding });
  totalBinSize += stat.size + padding;
}

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
console.log(`  GLB size: ${(totalGlbSize/1024/1024).toFixed(1)}MB`);

const glbPath = path.join(OUTPUT_DIR, "hydraulic.glb");
const fd = fs.openSync(glbPath, "w");

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalGlbSize, 8);
fs.writeSync(fd, header);

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(paddedJsonLen, 0);
jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4);
fs.writeSync(fd, jsonChunkHeader);
fs.writeSync(fd, jsonBuf);
if (jsonPadding > 0) fs.writeSync(fd, Buffer.alloc(jsonPadding, 0x20));

const binChunkHeader = Buffer.alloc(8);
binChunkHeader.writeUInt32LE(totalBinSize, 0);
binChunkHeader.writeUInt32LE(0x004e4942, 4);
fs.writeSync(fd, binChunkHeader);

for (let i = 0; i < bufferInfos.length; i++) {
  const info = bufferInfos[i];
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

// Cleanup gltf dir to free disk
try { fs.rmSync(gltfDir, { recursive: true, force: true }); } catch {}
if (global.gc) global.gc();

// Upload via curl (subprocess) to avoid Node.js OOM
console.log("  Uploading to S3 via curl...");
const timestamp = Date.now();
const fileKey = `projects/60001/hydraulic-${timestamp}.glb`;
const forgeUrl = FORGE_API_URL.replace(/\/+$/, "");
const curlCmd = `curl -s -X POST "${forgeUrl}/v1/storage/upload?path=${fileKey}" -H "Authorization: Bearer ${FORGE_API_KEY}" -F "file=@${glbPath};type=application/octet-stream" --max-time 900 --progress-bar`;
console.log("  Running curl...");
const result = execSync(curlCmd, { maxBuffer: 10 * 1024 * 1024 }).toString().trim();
console.log("  Upload response:", result.substring(0, 200));

const parsed = JSON.parse(result.split("\n").pop());
console.log("  S3 URL:", parsed.url.substring(0, 80));

// Cleanup GLB
fs.unlinkSync(glbPath);

console.log("  ✅ hydraulic DONE");
console.log("  URL:", parsed.url);
console.log("  Size:", totalGlbSize);
