/**
 * Analyze the bounding box and orientation of each GLB model
 * to detect which ones are rotated 90 degrees.
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { getBounds } from '@gltf-transform/functions';
import { getDb } from '../server/db.ts';
import { projectFiles } from '../drizzle/schema.ts';
import { eq } from 'drizzle-orm';
import { storageGet } from '../server/storage.ts';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const db = await getDb();
const files = await db.select().from(projectFiles).where(eq(projectFiles.projectId, 60001));

console.log(`Found ${files.length} files\n`);

// Sort by file size (smallest first)
files.sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0));

const results = [];

for (const f of files) {
  const sizeMB = (f.fileSize || 0) / 1024 / 1024;
  
  // Skip files > 200MB (electrical/hydraulic) - too large for memory
  if (sizeMB > 200) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SKIPPING ${f.specialty} (${sizeMB.toFixed(0)}MB) - too large`);
    console.log(`Will analyze via proxy with smaller buffer`);
    continue;
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Analyzing: ${f.specialty} (${sizeMB.toFixed(1)}MB)`);
  
  // Get URL
  const { url } = await storageGet(f.fileKey);
  
  // Download to temp file
  const tmpFile = path.join(os.tmpdir(), `analyze_${f.specialty}.glb`);
  
  await new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(tmpFile);
    proto.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
  
  const actualSize = fs.statSync(tmpFile).size / 1024 / 1024;
  console.log(`  Downloaded: ${actualSize.toFixed(1)}MB`);
  
  try {
    const doc = await io.read(tmpFile);
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
    
    if (!scene) {
      console.log(`  No scene found`);
      continue;
    }
    
    const bounds = getBounds(scene);
    const size = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    
    console.log(`  Bounding Box:`);
    console.log(`    Min: [${bounds.min.map(v => v.toFixed(2)).join(', ')}]`);
    console.log(`    Max: [${bounds.max.map(v => v.toFixed(2)).join(', ')}]`);
    console.log(`    Size: [${size.map(v => v.toFixed(2)).join(', ')}]`);
    console.log(`    Center: [${center.map(v => v.toFixed(2)).join(', ')}]`);
    
    // Check root node transforms
    const rootNodes = scene.listChildren();
    console.log(`  Root nodes: ${rootNodes.length}`);
    for (const node of rootNodes.slice(0, 3)) {
      const r = node.getRotation();
      const t = node.getTranslation();
      const s = node.getScale();
      console.log(`    "${node.getName()}" rot=[${r.map(v => v.toFixed(4)).join(',')}] pos=[${t.map(v => v.toFixed(2)).join(',')}] scale=[${s.map(v => v.toFixed(4)).join(',')}]`);
    }
    
    // Detect orientation
    const [sx, sy, sz] = size;
    let orientation = 'unknown';
    if (sz > sy * 1.5 && sz > 3) {
      orientation = 'ROTATED (Z-up, needs -90° X rotation)';
    } else if (sy > sz * 1.5 && sy > 3) {
      orientation = 'CORRECT (Y-up)';
    } else {
      orientation = `AMBIGUOUS (Y=${sy.toFixed(1)}, Z=${sz.toFixed(1)})`;
    }
    console.log(`  Orientation: ${orientation}`);
    
    results.push({
      specialty: f.specialty,
      bounds: { min: bounds.min, max: bounds.max, size, center },
      orientation,
    });
    
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
  
  // Clean up
  fs.unlinkSync(tmpFile);
}

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log(`${'='.repeat(60)}`);

for (const r of results) {
  console.log(`\n${r.specialty}:`);
  console.log(`  Center: [${r.bounds.center.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Size:   [${r.bounds.size.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  Status: ${r.orientation}`);
}

// Write results to JSON for later use
fs.writeFileSync('/home/ubuntu/glb-orientation-results.json', JSON.stringify(results, null, 2));
console.log('\nResults saved to /home/ubuntu/glb-orientation-results.json');

process.exit(0);
