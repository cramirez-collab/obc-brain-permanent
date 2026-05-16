/**
 * Load the sanitary GLB with Three.js (same as the viewer does) and check
 * the scene graph structure and matrixWorld values.
 */
// Polyfill for Node.js
if (typeof globalThis.ProgressEvent === 'undefined') {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.lengthComputable = init.lengthComputable || false;
      this.loaded = init.loaded || 0;
      this.total = init.total || 0;
    }
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElementNS: () => ({}) };
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import fs from 'fs';

const buffer = fs.readFileSync('/home/ubuntu/glb-analysis/sanitary.glb');
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
loader.setDRACOLoader(dracoLoader);

loader.parse(arrayBuffer, '', (gltf) => {
  console.log('=== BEFORE updateMatrixWorld ===');
  
  // Check first mesh's matrixWorld
  let firstMesh = null;
  gltf.scene.traverse((child) => {
    if (child.isMesh && !firstMesh) {
      firstMesh = child;
      console.log('First mesh name:', child.name);
      console.log('First mesh matrix:', child.matrix.elements.map(v => v.toFixed(4)));
      console.log('First mesh matrixWorld:', child.matrixWorld.elements.map(v => v.toFixed(4)));
      console.log('First mesh position:', child.position.toArray().map(v => v.toFixed(4)));
    }
  });
  
  // Now update matrixWorld
  gltf.scene.updateMatrixWorld(true);
  
  console.log('\n=== AFTER updateMatrixWorld ===');
  firstMesh = null;
  let meshCount = 0;
  const bbox = new THREE.Box3();
  
  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      meshCount++;
      if (!firstMesh) {
        firstMesh = child;
        console.log('First mesh name:', child.name);
        console.log('First mesh matrix:', child.matrix.elements.map(v => v.toFixed(4)));
        console.log('First mesh matrixWorld:', child.matrixWorld.elements.map(v => v.toFixed(4)));
      }
      
      // Compute bbox using matrixWorld
      const geo = child.geometry;
      if (geo.attributes.position) {
        const pos = geo.attributes.position;
        const v = new THREE.Vector3();
        for (let i = 0; i < Math.min(pos.count, 100); i++) {
          v.fromBufferAttribute(pos, i);
          v.applyMatrix4(child.matrixWorld);
          bbox.expandByPoint(v);
        }
      }
    }
  });
  
  console.log('\nTotal meshes:', meshCount);
  console.log('BBox after matrixWorld:', {
    min: [bbox.min.x.toFixed(2), bbox.min.y.toFixed(2), bbox.min.z.toFixed(2)],
    max: [bbox.max.x.toFixed(2), bbox.max.y.toFixed(2), bbox.max.z.toFixed(2)],
  });
  
  // Now check: what does the viewer do? It copies mesh.matrixWorld to newMesh.matrix
  // and sets matrixAutoUpdate = false. Then computes bbox from the group.
  const group = new THREE.Group();
  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      const newMesh = new THREE.Mesh(child.geometry, child.material);
      newMesh.matrixAutoUpdate = false;
      newMesh.matrix.copy(child.matrixWorld);
      group.add(newMesh);
    }
  });
  
  const groupBbox = new THREE.Box3().setFromObject(group);
  console.log('\nGroup BBox (viewer method):', {
    min: [groupBbox.min.x.toFixed(2), groupBbox.min.y.toFixed(2), groupBbox.min.z.toFixed(2)],
    max: [groupBbox.max.x.toFixed(2), groupBbox.max.y.toFixed(2), groupBbox.max.z.toFixed(2)],
  });
  
  // Check the scene graph hierarchy
  console.log('\n=== SCENE GRAPH ===');
  function printNode(node, depth = 0) {
    const indent = '  '.repeat(depth);
    const hasTransform = !node.matrix.equals(new THREE.Matrix4());
    const hasMesh = node.isMesh;
    const childCount = node.children.length;
    if (depth <= 3 || hasTransform || hasMesh) {
      console.log(`${indent}${node.type} "${node.name}" children=${childCount}${hasMesh ? ' [MESH]' : ''}${hasTransform ? ' [HAS_TRANSFORM]' : ''}`);
      if (hasTransform && depth <= 3) {
        const pos = node.position;
        const rot = node.rotation;
        const scl = node.scale;
        console.log(`${indent}  pos=[${pos.x.toFixed(4)},${pos.y.toFixed(4)},${pos.z.toFixed(4)}] scale=[${scl.x.toFixed(4)},${scl.y.toFixed(4)},${scl.z.toFixed(4)}]`);
      }
    }
    for (const child of node.children) {
      printNode(child, depth + 1);
    }
  }
  printNode(gltf.scene);
  
  process.exit(0);
}, (err) => {
  console.error('Parse error:', err);
  process.exit(1);
});
