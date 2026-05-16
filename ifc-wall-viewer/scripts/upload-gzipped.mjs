#!/usr/bin/env node
import { execSync } from "child_process";
import { existsSync, statSync } from "fs";

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL;
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;
const WORK_DIR = "/home/ubuntu/glb-draco";

async function getDownloadUrl(fileKey) {
  const url = new URL("v1/storage/downloadUrl", FORGE_API_URL.endsWith("/") ? FORGE_API_URL : FORGE_API_URL + "/");
  url.searchParams.set("path", fileKey);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${FORGE_API_KEY}` } });
  const data = await resp.json();
  return data.url;
}

async function processFile(name, fileKey) {
  const origPath = `${WORK_DIR}/${name}-original.glb`;
  const gzPath = `${WORK_DIR}/${name}-gzipped.glb`;
  console.log(`\n=== ${name} ===`);
  if (!existsSync(origPath)) {
    console.log("  Downloading...");
    const url = await getDownloadUrl(fileKey);
    execSync(`curl -sL "${url}" -o "${origPath}"`, { timeout: 600000 });
  }
  const origSize = statSync(origPath).size;
  console.log(`  Original: ${(origSize / 1024 / 1024).toFixed(1)}MB`);
  if (!existsSync(gzPath)) {
    console.log("  Gzipping...");
    execSync(`gzip -9 -c "${origPath}" > "${gzPath}"`, { timeout: 600000 });
  }
  const gzSize = statSync(gzPath).size;
  console.log(`  Gzipped: ${(gzSize / 1024 / 1024).toFixed(1)}MB (${((1 - gzSize/origSize)*100).toFixed(1)}% reduction)`);
  console.log("  Uploading to S3...");
  const uploadUrl = new URL("v1/storage/upload", FORGE_API_URL.endsWith("/") ? FORGE_API_URL : FORGE_API_URL + "/");
  uploadUrl.searchParams.set("path", fileKey);
  const result = execSync(
    `curl -s -X POST "${uploadUrl.toString()}" -H "Authorization: Bearer ${FORGE_API_KEY}" -F "file=@${gzPath}" -w "\\nHTTP:%{http_code}"`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 600000 }
  ).toString();
  const httpCode = result.match(/HTTP:(\d+)/)?.[1];
  console.log(`  Upload HTTP: ${httpCode}`);
  execSync(`rm -f "${origPath}" "${gzPath}"`);
}

async function main() {
  // Electrical - already gzipped
  if (existsSync(`${WORK_DIR}/electrical-gzipped.glb`)) {
    const gzSize = statSync(`${WORK_DIR}/electrical-gzipped.glb`).size;
    console.log(`\n=== electrical (pre-gzipped: ${(gzSize/1024/1024).toFixed(1)}MB) ===`);
    console.log("  Uploading to S3...");
    const uploadUrl = new URL("v1/storage/upload", FORGE_API_URL.endsWith("/") ? FORGE_API_URL : FORGE_API_URL + "/");
    uploadUrl.searchParams.set("path", "hidalma-glb/electrical.glb");
    const result = execSync(
      `curl -s -X POST "${uploadUrl.toString()}" -H "Authorization: Bearer ${FORGE_API_KEY}" -F "file=@${WORK_DIR}/electrical-gzipped.glb" -w "\\nHTTP:%{http_code}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 600000 }
    ).toString();
    const httpCode = result.match(/HTTP:(\d+)/)?.[1];
    console.log(`  Upload HTTP: ${httpCode}`);
    execSync(`rm -f ${WORK_DIR}/electrical-original.glb ${WORK_DIR}/electrical-gzipped.glb`);
  } else {
    await processFile("electrical", "hidalma-glb/electrical.glb");
  }
  // Hydraulic
  await processFile("hydraulic", "hidalma-glb/hydraulic.glb");
  console.log("\nDone!");
}
main().catch(console.error);
