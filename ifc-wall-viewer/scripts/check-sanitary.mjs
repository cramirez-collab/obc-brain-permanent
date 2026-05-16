/**
 * Check the sanitary model's mesh hierarchy and vertex ranges
 * to understand why it renders as 0.6m instead of ~80m
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const WORK_DIR = '/home/ubuntu/glb-analysis';

async function main() {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const doc = await io.read(`${WORK_DIR}/sanitary.glb`);
  const root = doc.getRoot();
  const scenes = root.listScenes();
  
  let totalVerts = 0;
  let globalMin = [Infinity, Infinity, Infinity];
  let globalMax = [-Infinity, -Infinity, -Infinity];
  let meshCount = 0;
  
  function processNode(node, depth = 0) {
    const indent = '  '.repeat(depth);
    const t = node.getTranslation();
    const r = node.getRotation();
    const s = node.getScale();
    const name = node.getName() || '(unnamed)';
    
    const hasTransform = t.some(v => v !== 0) || r.some((v, i) => i < 3 ? v !== 0 : v !== 1) || s.some(v => v !== 1);
    if (hasTransform || depth <= 2) {
      console.log(`${indent}Node: ${name}`);
      if (hasTransform) {
        console.log(`${indent}  T=[${t.map(v=>v.toFixed(4))}] R=[${r.map(v=>v.toFixed(4))}] S=[${s.map(v=>v.toFixed(4))}]`);
      }
    }
    
    const mesh = node.getMesh();
    if (mesh) {
      meshCount++;
      for (const prim of mesh.listPrimitives()) {
        const posAccessor = prim.getAttribute('POSITION');
        if (!posAccessor) continue;
        const count = posAccessor.getCount();
        totalVerts += count;
        
        for (let i = 0; i < count; i++) {
          const pos = posAccessor.getElement(i, [0, 0, 0]);
          for (let j = 0; j < 3; j++) {
            if (pos[j] < globalMin[j]) globalMin[j] = pos[j];
            if (pos[j] > globalMax[j]) globalMax[j] = pos[j];
          }
        }
      }
    }
    
    for (const child of node.listChildren()) {
      processNode(child, depth + 1);
    }
  }
  
  for (const scene of scenes) {
    console.log(`Scene: ${scene.getName() || '(default)'}`);
    for (const child of scene.listChildren()) {
      processNode(child, 1);
    }
  }
  
  console.log(`\nTotal meshes: ${meshCount}`);
  console.log(`Total vertices: ${totalVerts}`);
  console.log(`Raw vertex range: min=[${globalMin.map(v=>v.toFixed(2))}] max=[${globalMax.map(v=>v.toFixed(2))}]`);
  console.log(`Raw size: [${(globalMax[0]-globalMin[0]).toFixed(2)}, ${(globalMax[1]-globalMin[1]).toFixed(2)}, ${(globalMax[2]-globalMin[2]).toFixed(2)}]`);
  
  // After root transform (scale 0.3048, rotX -90°):
  const s = 0.3048;
  console.log(`\nAfter root scale (0.3048):`);
  console.log(`  min=[${(globalMin[0]*s).toFixed(2)}, ${(globalMin[1]*s).toFixed(2)}, ${(globalMin[2]*s).toFixed(2)}]`);
  console.log(`  max=[${(globalMax[0]*s).toFixed(2)}, ${(globalMax[1]*s).toFixed(2)}, ${(globalMax[2]*s).toFixed(2)}]`);
  
  // After rotX -90° (Y→Z, Z→-Y):
  console.log(`After root scale + rotX(-90°):`);
  console.log(`  X: ${(globalMin[0]*s).toFixed(2)} to ${(globalMax[0]*s).toFixed(2)}`);
  console.log(`  Y (was Z): ${(globalMin[2]*s).toFixed(2)} to ${(globalMax[2]*s).toFixed(2)}`);
  console.log(`  Z (was -Y): ${(-globalMax[1]*s).toFixed(2)} to ${(-globalMin[1]*s).toFixed(2)}`);
  
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
