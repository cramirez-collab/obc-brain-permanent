/**
 * Detect floor levels from the Structure model by analyzing vertex Y coordinates
 * after applying root node transforms (matrixWorld).
 * This mimics exactly what Three.js does in the viewer.
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'fs';

const WORK_DIR = '/home/ubuntu/glb-analysis';

async function createIO() {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  return io;
}

// Multiply a 4x4 matrix by a vec3 (homogeneous)
function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const m = matrix;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

// Build a 4x4 matrix from TRS (column-major, like glTF)
function buildMatrix(translation, rotation, scale) {
  const [tx, ty, tz] = translation;
  const [qx, qy, qz, qw] = rotation;
  const [sx, sy, sz] = scale;
  
  // Rotation matrix from quaternion
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  
  // Column-major 4x4
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// Multiply two 4x4 matrices (column-major)
function multiplyMatrices(a, b) {
  const result = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        result[i + j * 4] += a[i + k * 4] * b[k + j * 4];
      }
    }
  }
  return result;
}

async function analyzeModel(io, filePath, modelName) {
  console.log(`\nAnalyzing ${modelName}...`);
  const doc = await io.read(filePath);
  const root = doc.getRoot();
  
  // Get root node transforms
  const scenes = root.listScenes();
  const rootNodes = [];
  for (const scene of scenes) {
    for (const child of scene.listChildren()) {
      rootNodes.push(child);
    }
  }
  
  // Collect all Y values after applying node transforms
  const yValues = [];
  
  for (const rootNode of rootNodes) {
    const t = rootNode.getTranslation();
    const r = rootNode.getRotation();
    const s = rootNode.getScale();
    const rootMatrix = buildMatrix(t, r, s);
    
    // Process all meshes under this root node
    function processNode(node, parentMatrix) {
      const nt = node.getTranslation();
      const nr = node.getRotation();
      const ns = node.getScale();
      const nodeMatrix = buildMatrix(nt, nr, ns);
      const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix);
      
      const mesh = node.getMesh();
      if (mesh) {
        for (const prim of mesh.listPrimitives()) {
          const posAccessor = prim.getAttribute('POSITION');
          if (!posAccessor) continue;
          const count = posAccessor.getCount();
          // Sample every Nth vertex for speed
          const step = Math.max(1, Math.floor(count / 500));
          for (let i = 0; i < count; i += step) {
            const pos = posAccessor.getElement(i, [0, 0, 0]);
            const transformed = transformPoint(worldMatrix, pos);
            yValues.push(transformed[1]); // Y after transform
          }
        }
      }
      
      for (const child of node.listChildren()) {
        processNode(child, worldMatrix);
      }
    }
    
    processNode(rootNode, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }
  
  console.log(`  Sampled ${yValues.length} Y values`);
  
  // Find min/max
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  console.log(`  Y range: ${minY.toFixed(2)}m to ${maxY.toFixed(2)}m (height: ${(maxY - minY).toFixed(2)}m)`);
  
  // Create histogram with 0.1m bins
  const binSize = 0.1;
  const histogram = {};
  for (const y of yValues) {
    const bin = Math.round(y / binSize) * binSize;
    histogram[bin] = (histogram[bin] || 0) + 1;
  }
  
  // Find peaks (floor levels) - floors have many vertices at similar Y
  const sortedBins = Object.entries(histogram)
    .map(([v, count]) => ({ y: parseFloat(v), count }))
    .sort((a, b) => b.count - a.count);
  
  // Extract floor levels: significant peaks with minimum 1.5m spacing
  const MIN_FLOOR_SPACING = 2.0; // meters
  const floors = [];
  const threshold = yValues.length * 0.001; // 0.1% of total vertices
  
  for (const bin of sortedBins) {
    if (bin.count < threshold) continue;
    let isDuplicate = false;
    for (const existing of floors) {
      if (Math.abs(existing.y - bin.y) < MIN_FLOOR_SPACING) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) floors.push({ y: bin.y, count: bin.count });
  }
  
  floors.sort((a, b) => a.y - b.y);
  
  console.log(`\n  Detected ${floors.length} floor levels:`);
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i];
    const spacing = i > 0 ? (f.y - floors[i-1].y).toFixed(2) : '-';
    console.log(`    ${i}: Y=${f.y.toFixed(2)}m (${f.count} verts) spacing=${spacing}m`);
  }
  
  return { modelName, minY, maxY, floors };
}

async function main() {
  const io = await createIO();
  
  // Analyze structure model (reference)
  const structPath = `${WORK_DIR}/structure.glb`;
  const archPath = `${WORK_DIR}/architecture.glb`;
  
  const results = [];
  
  if (fs.existsSync(structPath)) {
    results.push(await analyzeModel(io, structPath, 'structure'));
  }
  if (fs.existsSync(archPath)) {
    results.push(await analyzeModel(io, archPath, 'architecture'));
  }
  
  // Also analyze gas and hvac for cross-reference
  const gasPath = `${WORK_DIR}/gas.glb`;
  const hvacPath = `${WORK_DIR}/hvac.glb`;
  if (fs.existsSync(gasPath)) {
    results.push(await analyzeModel(io, gasPath, 'gas'));
  }
  if (fs.existsSync(hvacPath)) {
    results.push(await analyzeModel(io, hvacPath, 'hvac'));
  }
  
  // Save results
  fs.writeFileSync(`${WORK_DIR}/floor-detection-results.json`, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${WORK_DIR}/floor-detection-results.json`);
  
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
