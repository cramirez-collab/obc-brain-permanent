/**
 * Upload Draco-compressed GLBs with NEW fileKeys (v2 suffix) to bypass CloudFront cache.
 * Then update the DB fileKeys to point to the new paths.
 */
import { storagePut, storageGet } from "../server/storage.js";
import { getProjectFiles, updateProjectFile } from "../server/db.js";
import { readFileSync, existsSync, unlinkSync, statSync } from "fs";
import { execSync } from "child_process";

const WORK_DIR = "/home/ubuntu/glb-draco-reupload";
execSync(`mkdir -p ${WORK_DIR}`);

// Only the 7 files that can be Draco-compressed (< 350MB)
const FILES = [
  "fire_protection", "pluvial", "sanitary", "structure", "gas", "hvac", "architecture"
];

async function main() {
  // Get all project files to map specialty -> id
  const allFiles = await getProjectFiles(60001);
  const fileMap = {};
  for (const f of allFiles) {
    // Extract name from fileKey: "hidalma-glb/structure.glb" -> "structure"
    const name = f.fileKey.replace("hidalma-glb/", "").replace(".glb", "").replace("-v2", "");
    fileMap[name] = f;
  }
  
  const results = [];
  
  for (const name of FILES) {
    const origPath = `${WORK_DIR}/${name}-orig.glb`;
    const dracoPath = `${WORK_DIR}/${name}-v2.glb`;
    const newKey = `hidalma-glb/${name}-v2.glb`;
    
    console.log(`\n=== ${name} ===`);
    
    const dbFile = fileMap[name];
    if (!dbFile) {
      console.log("  NOT FOUND in DB, skipping");
      continue;
    }
    console.log(`  DB id=${dbFile.id}, current fileKey=${dbFile.fileKey}`);
    
    // Download original
    if (!existsSync(origPath)) {
      console.log("  Downloading...");
      const { url } = await storageGet(dbFile.fileKey);
      execSync(`curl -sL "${url}" -o "${origPath}"`, { timeout: 600000 });
    }
    const origSize = statSync(origPath).size;
    console.log(`  Original: ${(origSize / 1024 / 1024).toFixed(1)}MB`);
    
    // Draco compress
    if (!existsSync(dracoPath)) {
      console.log("  Compressing...");
      try {
        execSync(
          `npx --yes @gltf-transform/cli optimize "${origPath}" "${dracoPath}" --compress draco`,
          { timeout: 600000, maxBuffer: 50 * 1024 * 1024, stdio: "pipe" }
        );
      } catch (err) {
        console.error(`  FAILED compression`);
        if (existsSync(origPath)) unlinkSync(origPath);
        continue;
      }
    }
    const dracoSize = statSync(dracoPath).size;
    console.log(`  Draco: ${(dracoSize / 1024 / 1024).toFixed(1)}MB (${((1-dracoSize/origSize)*100).toFixed(1)}% reduction)`);
    
    // Upload with NEW key
    console.log(`  Uploading as ${newKey}...`);
    const data = readFileSync(dracoPath);
    const { url } = await storagePut(newKey, data, "model/gltf-binary");
    console.log(`  URL: ${url}`);
    
    // Verify
    const headSize = parseInt(
      execSync(`curl -sI "${url}" | grep -i content-length | awk '{print $2}' | tr -d '\\r'`).toString().trim()
    );
    const match = headSize === dracoSize;
    console.log(`  Verified: ${(headSize / 1024 / 1024).toFixed(1)}MB ${match ? 'OK' : 'MISMATCH!'}`);
    
    if (match) {
      // Update DB
      await updateProjectFile(dbFile.id, { fileKey: newKey, fileSize: dracoSize });
      console.log(`  DB updated: fileKey=${newKey}, fileSize=${dracoSize}`);
      results.push({ name, newKey, dracoSize, origSize });
    }
    
    // Clean up
    if (existsSync(origPath)) unlinkSync(origPath);
    if (existsSync(dracoPath)) unlinkSync(dracoPath);
  }
  
  console.log("\n=== Summary ===");
  let totalOrig = 0, totalDraco = 0;
  for (const r of results) {
    totalOrig += r.origSize;
    totalDraco += r.dracoSize;
    console.log(`${r.name.padEnd(20)} ${(r.origSize/1024/1024).toFixed(1).padStart(8)}MB -> ${(r.dracoSize/1024/1024).toFixed(1).padStart(8)}MB`);
  }
  if (totalOrig > 0) {
    console.log(`${"TOTAL".padEnd(20)} ${(totalOrig/1024/1024).toFixed(1).padStart(8)}MB -> ${(totalDraco/1024/1024).toFixed(1).padStart(8)}MB (${((1-totalDraco/totalOrig)*100).toFixed(1)}%)`);
  }
}

main().then(() => { console.log("\nDone!"); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
