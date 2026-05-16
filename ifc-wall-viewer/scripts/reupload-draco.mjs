import { storagePut, storageGet } from "../server/storage.js";
import { readFileSync, existsSync, unlinkSync, statSync } from "fs";
import { execSync } from "child_process";

const WORK_DIR = "/home/ubuntu/glb-draco-reupload";
execSync(`mkdir -p ${WORK_DIR}`);

// Start with just structure to test the approach
const FILES = ["structure"];

async function main() {
  for (const name of FILES) {
    const origPath = `${WORK_DIR}/${name}-original.glb`;
    const dracoPath = `${WORK_DIR}/${name}-draco.glb`;
    
    console.log(`\n=== ${name} ===`);
    
    // Download original from S3
    if (!existsSync(origPath)) {
      console.log("  Downloading original...");
      const { url } = await storageGet(`hidalma-glb/${name}.glb`);
      execSync(`curl -sL "${url}" -o "${origPath}"`, { timeout: 600000 });
    }
    const origSize = statSync(origPath).size;
    console.log(`  Original: ${(origSize / 1024 / 1024).toFixed(1)}MB`);
    
    // Draco compress
    if (!existsSync(dracoPath)) {
      console.log("  Compressing with Draco...");
      execSync(
        `npx --yes @gltf-transform/cli optimize "${origPath}" "${dracoPath}" --compress draco`,
        { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }
      );
    }
    const dracoSize = statSync(dracoPath).size;
    console.log(`  Draco: ${(dracoSize / 1024 / 1024).toFixed(1)}MB (${((1-dracoSize/origSize)*100).toFixed(1)}% reduction)`);
    
    // Upload via storagePut (overwrite)
    console.log("  Uploading via storagePut...");
    const data = readFileSync(dracoPath);
    const result = await storagePut(`hidalma-glb/${name}.glb`, data, "model/gltf-binary");
    console.log(`  Uploaded: ${result.url}`);
    
    // Verify size
    const verifyHead = execSync(`curl -sI "${result.url}" | grep -i content-length | awk '{print $2}' | tr -d '\\r'`).toString().trim();
    const verifySize = parseInt(verifyHead);
    console.log(`  Verified size: ${(verifySize / 1024 / 1024).toFixed(1)}MB ${verifySize === dracoSize ? 'OK' : 'MISMATCH'}`);
    
    // Clean up
    unlinkSync(origPath);
    unlinkSync(dracoPath);
  }
}

main().then(() => { console.log("\nDone!"); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
