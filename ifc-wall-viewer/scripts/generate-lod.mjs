#!/usr/bin/env node
/**
 * Generate LOD for Draco-compressed GLB files.
 * Uses gltf-transform with KHR_draco_mesh_compression extension.
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { dedup, weld, simplify, quantize, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const WORK_DIR = '/tmp/glb-optimize';
const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL?.replace(/\/+$/, '');
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

const FILES = [
  { specialty: 'electrical', fileKey: 'hidalma/electrical-draco-v3.glb', id: 60002 },
  { specialty: 'hydraulic', fileKey: 'hidalma/hydraulic-draco-v3.glb', id: 60005 },
];

async function uploadToS3(fileKey, buffer, contentType = 'application/octet-stream') {
  const url = new URL('v1/storage/upload', FORGE_URL + '/');
  url.searchParams.set('path', fileKey);
  const blob = new Blob([buffer], { type: contentType });
  const form = new FormData();
  form.append('file', blob, fileKey.split('/').pop());
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FORGE_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()).url;
}

async function generateLOD(inputPath, outputPath, targetRatio) {
  console.log(`  Reading with Draco support...`);
  
  await MeshoptSimplifier.ready;
  
  // Initialize Draco decoder/encoder
  const decoderModule = await draco3d.createDecoderModule();
  const encoderModule = await draco3d.createEncoderModule();
  
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      'draco3d.decoder': decoderModule,
      'draco3d.encoder': encoderModule,
    });
  
  const doc = await io.read(inputPath);
  
  let totalTris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) totalTris += idx.getCount() / 3;
    }
  }
  console.log(`  Original: ${totalTris.toLocaleString()} triangles`);
  
  // Remove Draco extension before simplification (simplify works on raw geometry)
  // Then re-encode with Draco after simplification
  const dracoExt = doc.getRoot().listExtensionsUsed()
    .find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
  if (dracoExt) {
    dracoExt.dispose();
    console.log(`  Removed Draco extension for simplification`);
  }
  
  // Apply simplification pipeline
  console.log(`  Simplifying to ${(targetRatio * 100).toFixed(1)}%...`);
  await doc.transform(
    dedup(),
    weld({ tolerance: 0.001 }),
    simplify({ simplifier: MeshoptSimplifier, ratio: targetRatio, error: 0.01 }),
    prune(),
    quantize(),
  );
  
  let lodTris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) lodTris += idx.getCount() / 3;
    }
  }
  console.log(`  LOD: ${lodTris.toLocaleString()} triangles (${((lodTris / totalTris) * 100).toFixed(1)}%)`);
  
  // Re-apply Draco compression for smaller file size
  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
    });
  
  await io.write(outputPath, doc);
  const size = statSync(outputPath).size;
  console.log(`  LOD file: ${(size / 1024 / 1024).toFixed(1)}MB`);
  return size;
}

async function main() {
  console.log('=== Generating LOD for Large GLB Files ===\n');
  
  for (const file of FILES) {
    console.log(`\n--- ${file.specialty.toUpperCase()} ---`);
    
    const originalPath = path.join(WORK_DIR, `${file.specialty}-original.glb`);
    const lodPath = path.join(WORK_DIR, `${file.specialty}-lod.glb`);
    
    if (!existsSync(originalPath)) {
      console.log(`  Original not found at ${originalPath}, skipping`);
      continue;
    }
    
    const origSize = statSync(originalPath).size;
    console.log(`  Original: ${(origSize / 1024 / 1024).toFixed(1)}MB`);
    
    let lodSize = 0;
    try {
      lodSize = await generateLOD(originalPath, lodPath, 0.03); // 3% of triangles
    } catch (err) {
      console.error(`  LOD failed: ${err.message}`);
      console.error(err.stack);
      continue;
    }
    
    // Upload LOD to S3
    console.log(`\n  Uploading LOD to S3...`);
    const lodFileKey = `hidalma/${file.specialty}-lod.glb`;
    try {
      const lodUrl = await uploadToS3(lodFileKey, readFileSync(lodPath), 'model/gltf-binary');
      console.log(`  LOD uploaded: ${lodUrl?.substring(0, 80)}...`);
      
      // Update DB
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(process.env.DATABASE_URL);
      await conn.execute('UPDATE project_files SET lodUrl = ? WHERE id = ?', [lodUrl, file.id]);
      console.log(`  DB updated: lodUrl set for id=${file.id}`);
      await conn.end();
    } catch (err) {
      console.error(`  Upload failed: ${err.message}`);
    }
    
    console.log(`\n  Summary: ${(origSize / 1024 / 1024).toFixed(1)}MB → LOD ${(lodSize / 1024 / 1024).toFixed(1)}MB (${((lodSize / origSize) * 100).toFixed(1)}%)`);
  }
  
  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
