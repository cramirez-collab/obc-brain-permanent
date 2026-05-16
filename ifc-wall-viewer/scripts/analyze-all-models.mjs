/**
 * Analyze all 9 GLB models with Draco support
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { getDb } from '../server/db.ts';
import { projectFiles } from '../drizzle/schema.ts';
import { eq } from 'drizzle-orm';
import { storageGet } from '../server/storage.ts';
import fs from 'fs';
import path from 'path';

const WORK_DIR = '/home/ubuntu/glb-analysis';
fs.mkdirSync(WORK_DIR, { recursive: true });

async function createIO() {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  return io;
}

async function downloadFile(fileKey, name) {
  const localPath = path.join(WORK_DIR, `${name}.glb`);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) {
    console.log(`  [CACHED] ${name}`);
    return localPath;
  }
  const { url } = await storageGet(fileKey);
  console.log(`  Downloading ${name}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(localPath, buffer);
  console.log(`  Downloaded: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
  return localPath;
}

function analyzeDocument(doc, name) {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  const nodes = root.listNodes();
  
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalVertices = 0;
  
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const posAccessor = prim.getAttribute('POSITION');
      if (!posAccessor) continue;
      const count = posAccessor.getCount();
      totalVertices += count;
      for (let i = 0; i < count; i++) {
        const pos = posAccessor.getElement(i, [0, 0, 0]);
        minX = Math.min(minX, pos[0]);
        minY = Math.min(minY, pos[1]);
        minZ = Math.min(minZ, pos[2]);
        maxX = Math.max(maxX, pos[0]);
        maxY = Math.max(maxY, pos[1]);
        maxZ = Math.max(maxZ, pos[2]);
      }
    }
  }
  
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  
  const maxDim = Math.max(sizeX, sizeY, sizeZ);
  const likelyFeet = maxDim > 500;
  
  // Detect which axis is "up" (height)
  // For a building, height is typically the 2nd or 3rd largest dimension
  // But we can detect by checking which axis has the most regular spacing (floors)
  
  // Sample Y and Z values for floor detection
  const yHist = {};
  const zHist = {};
  const yBinSize = likelyFeet ? 1 : 0.3;
  const zBinSize = likelyFeet ? 1 : 0.3;
  
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const posAccessor = prim.getAttribute('POSITION');
      if (!posAccessor) continue;
      const count = posAccessor.getCount();
      const step = Math.max(1, Math.floor(count / 1000));
      for (let i = 0; i < count; i += step) {
        const pos = posAccessor.getElement(i, [0, 0, 0]);
        const yBin = Math.round(pos[1] / yBinSize) * yBinSize;
        const zBin = Math.round(pos[2] / zBinSize) * zBinSize;
        yHist[yBin] = (yHist[yBin] || 0) + 1;
        zHist[zBin] = (zHist[zBin] || 0) + 1;
      }
    }
  }
  
  // Find floor levels on Y axis
  const yFloors = findFloorLevels(yHist, totalVertices, likelyFeet);
  const zFloors = findFloorLevels(zHist, totalVertices, likelyFeet);
  
  // Root node transforms
  let rootTransforms = [];
  const scenes = root.listScenes();
  for (const scene of scenes) {
    for (const child of scene.listChildren()) {
      const t = child.getTranslation();
      const r = child.getRotation();
      const s = child.getScale();
      if (t[0] !== 0 || t[1] !== 0 || t[2] !== 0 || 
          r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || r[3] !== 1 ||
          s[0] !== 1 || s[1] !== 1 || s[2] !== 1) {
        rootTransforms.push({ translation: [...t], rotation: [...r], scale: [...s] });
      }
    }
  }
  
  return {
    name,
    totalVertices,
    meshCount: meshes.length,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    size: { x: sizeX, y: sizeY, z: sizeZ },
    center: { x: centerX, y: centerY, z: centerZ },
    likelyFeet,
    yFloors,
    zFloors,
    rootTransforms: rootTransforms.slice(0, 3),
  };
}

function findFloorLevels(histogram, totalVertices, likelyFeet) {
  const threshold = likelyFeet ? 5 : 1.5; // min distance between floors
  const sortedBins = Object.entries(histogram)
    .map(([v, count]) => ({ v: parseFloat(v), count }))
    .sort((a, b) => b.count - a.count);
  
  const floors = [];
  for (const bin of sortedBins.slice(0, 200)) {
    if (bin.count > totalVertices * 0.0005) {
      let isDuplicate = false;
      for (const existing of floors) {
        if (Math.abs(existing.v - bin.v) < threshold) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) floors.push(bin);
    }
  }
  floors.sort((a, b) => a.v - b.v);
  return floors.slice(0, 40);
}

async function main() {
  const db = await getDb();
  const io = await createIO();
  
  const files = await db.select().from(projectFiles).where(eq(projectFiles.projectId, 60001));
  console.log(`Found ${files.length} files\n`);
  
  // Sort smallest first
  files.sort((a, b) => (a.fileSize || 0) - (b.fileSize || 0));
  
  const results = [];
  
  for (const file of files) {
    const name = file.specialty;
    const fileSize = file.fileSize || 0;
    const sizeMB = fileSize / 1024 / 1024;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${name.toUpperCase()} (${sizeMB.toFixed(1)}MB)`);
    console.log(`${'='.repeat(60)}`);
    
    try {
      const localPath = await downloadFile(file.fileKey, name);
      console.log(`  Parsing with Draco decoder...`);
      const doc = await io.read(localPath);
      const analysis = analyzeDocument(doc, name);
      results.push(analysis);
      
      console.log(`  Vertices: ${analysis.totalVertices.toLocaleString()}`);
      console.log(`  BBox min: [${analysis.bbox.min.map(v => v.toFixed(2)).join(', ')}]`);
      console.log(`  BBox max: [${analysis.bbox.max.map(v => v.toFixed(2)).join(', ')}]`);
      console.log(`  Size: X=${analysis.size.x.toFixed(2)} Y=${analysis.size.y.toFixed(2)} Z=${analysis.size.z.toFixed(2)}`);
      console.log(`  Center: X=${analysis.center.x.toFixed(2)} Y=${analysis.center.y.toFixed(2)} Z=${analysis.center.z.toFixed(2)}`);
      console.log(`  Likely feet: ${analysis.likelyFeet}`);
      
      if (analysis.yFloors.length > 0) {
        console.log(`  Y-axis floor levels (${analysis.yFloors.length}):`);
        for (const f of analysis.yFloors) {
          console.log(`    Y=${f.v.toFixed(2)}m (${f.count} verts)`);
        }
      }
      if (analysis.zFloors.length > 0) {
        console.log(`  Z-axis floor levels (${analysis.zFloors.length}):`);
        for (const f of analysis.zFloors) {
          console.log(`    Z=${f.v.toFixed(2)}m (${f.count} verts)`);
        }
      }
      if (analysis.rootTransforms.length > 0) {
        console.log(`  Root transforms:`);
        for (const rt of analysis.rootTransforms) {
          console.log(`    T=[${rt.translation.map(v => v.toFixed(4)).join(', ')}] R=[${rt.rotation.map(v => v.toFixed(4)).join(', ')}] S=[${rt.scale.map(v => v.toFixed(4)).join(', ')}]`);
        }
      }
      
      doc.dispose();
      // Force GC
      if (global.gc) global.gc();
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({ name, error: err.message, fileSize });
    }
  }
  
  fs.writeFileSync(path.join(WORK_DIR, 'analysis-results.json'), JSON.stringify(results, null, 2));
  
  // Print summary comparison
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('SUMMARY: ALIGNMENT COMPARISON');
  console.log(`${'='.repeat(80)}`);
  console.log(`${'Model'.padEnd(20)} ${'Size X'.padStart(10)} ${'Size Y'.padStart(10)} ${'Size Z'.padStart(10)} ${'Center X'.padStart(10)} ${'Center Y'.padStart(10)} ${'Center Z'.padStart(10)} ${'Feet?'.padStart(6)}`);
  console.log('-'.repeat(86));
  for (const r of results) {
    if (r.error || r.skipped) {
      console.log(`${r.name.padEnd(20)} SKIPPED/ERROR`);
      continue;
    }
    console.log(`${r.name.padEnd(20)} ${r.size.x.toFixed(1).padStart(10)} ${r.size.y.toFixed(1).padStart(10)} ${r.size.z.toFixed(1).padStart(10)} ${r.center.x.toFixed(1).padStart(10)} ${r.center.y.toFixed(1).padStart(10)} ${r.center.z.toFixed(1).padStart(10)} ${(r.likelyFeet ? 'YES' : 'no').padStart(6)}`);
  }
  
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
