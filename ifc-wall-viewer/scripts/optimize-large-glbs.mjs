#!/usr/bin/env node
/**
 * Optimize large GLB files (Electrical & Hydraulic):
 * 1. Download original from S3
 * 2. Generate LOD version (simplified ~2-5% triangles) for instant preview
 * 3. Compress original with gzip for faster download (~60-70% reduction)
 * 4. Upload LOD + gzip to S3
 * 5. Update DB with gzFileKey and lodUrl
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, weld, simplify, quantize, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const WORK_DIR = '/tmp/glb-optimize';

const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL?.replace(/\/+$/, '');
const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY;

if (!FORGE_URL || !FORGE_KEY) {
  console.error('Missing BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY');
  process.exit(1);
}

const FILES = [
  { specialty: 'electrical', fileKey: 'hidalma/electrical-draco-v3.glb', id: 60002 },
  { specialty: 'hydraulic', fileKey: 'hidalma/hydraulic-draco-v3.glb', id: 60005 },
];

async function getDownloadUrl(fileKey) {
  const url = new URL('v1/storage/downloadUrl', FORGE_URL + '/');
  url.searchParams.set('path', fileKey);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FORGE_KEY}` },
  });
  if (!res.ok) throw new Error(`Failed to get download URL: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.url;
}

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
  const data = await res.json();
  return data.url;
}

async function downloadGLB(fileKey, outputPath) {
  if (existsSync(outputPath)) {
    const size = statSync(outputPath).size;
    if (size > 1_000_000) {
      console.log(`  Already downloaded: ${(size / 1024 / 1024).toFixed(1)}MB`);
      return;
    }
  }
  
  const dlUrl = await getDownloadUrl(fileKey);
  console.log(`  Downloading...`);
  
  const res = await fetch(dlUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
  console.log(`  Downloaded: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
}

async function generateLOD(inputPath, outputPath, targetRatio = 0.02) {
  console.log(`  Generating LOD (${(targetRatio * 100).toFixed(1)}% of original triangles)...`);
  
  await MeshoptSimplifier.ready;
  
  const io = new NodeIO();
  const doc = await io.read(inputPath);
  
  let totalTris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (idx) totalTris += idx.getCount() / 3;
    }
  }
  console.log(`  Original: ${totalTris.toLocaleString()} triangles`);
  
  // Aggressive simplification for LOD
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
  
  await io.write(outputPath, doc);
  const size = statSync(outputPath).size;
  console.log(`  LOD file: ${(size / 1024 / 1024).toFixed(1)}MB`);
  return size;
}

async function main() {
  console.log('=== Optimizing Large GLB Files ===\n');
  
  for (const file of FILES) {
    console.log(`\n--- ${file.specialty.toUpperCase()} (id=${file.id}) ---`);
    
    const originalPath = path.join(WORK_DIR, `${file.specialty}-original.glb`);
    const lodPath = path.join(WORK_DIR, `${file.specialty}-lod.glb`);
    const gzPath = path.join(WORK_DIR, `${file.specialty}-original.glb.gz`);
    
    // Step 1: Download original
    console.log('\n1. Download original:');
    await downloadGLB(file.fileKey, originalPath);
    
    const origSize = statSync(originalPath).size;
    
    // Step 2: Generate LOD
    console.log('\n2. Generate LOD:');
    let lodSize = 0;
    try {
      lodSize = await generateLOD(originalPath, lodPath, 0.02);
    } catch (err) {
      console.error(`  LOD generation failed: ${err.message}`);
      try {
        console.log('  Retrying with 5% ratio...');
        lodSize = await generateLOD(originalPath, lodPath, 0.05);
      } catch (err2) {
        console.error(`  LOD generation failed again: ${err2.message}`);
      }
    }
    
    // Step 3: Gzip original
    console.log('\n3. Compress with gzip:');
    const origBuffer = readFileSync(originalPath);
    const gzBuffer = gzipSync(origBuffer, { level: 9 });
    writeFileSync(gzPath, gzBuffer);
    const gzSize = gzBuffer.length;
    console.log(`  Gzip: ${(origSize / 1024 / 1024).toFixed(1)}MB → ${(gzSize / 1024 / 1024).toFixed(1)}MB (${((1 - gzSize / origSize) * 100).toFixed(0)}% reduction)`);
    
    // Step 4: Upload LOD to S3
    if (lodSize > 0) {
      console.log('\n4. Upload LOD to S3:');
      const lodFileKey = `hidalma/${file.specialty}-lod.glb`;
      try {
        const lodUrl = await uploadToS3(lodFileKey, readFileSync(lodPath), 'model/gltf-binary');
        console.log(`  LOD uploaded: ${lodUrl?.substring(0, 80)}...`);
        
        // Update DB
        const mysql = await import('mysql2/promise');
        const conn = await mysql.createConnection(process.env.DATABASE_URL);
        await conn.execute(
          'UPDATE project_files SET lodUrl = ? WHERE id = ?',
          [lodUrl, file.id]
        );
        console.log(`  DB updated: lodUrl set for id=${file.id}`);
        await conn.end();
      } catch (err) {
        console.error(`  LOD upload failed: ${err.message}`);
      }
    }
    
    // Step 5: Upload gzip to S3
    console.log('\n5. Upload gzip to S3:');
    const gzFileKey = `hidalma/${file.specialty}-draco-v3.glb.gz`;
    try {
      const gzUrl = await uploadToS3(gzFileKey, gzBuffer, 'application/gzip');
      console.log(`  Gzip uploaded: ${gzUrl?.substring(0, 80)}...`);
      
      // Update DB
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(process.env.DATABASE_URL);
      await conn.execute(
        'UPDATE project_files SET gzFileKey = ? WHERE id = ?',
        [gzFileKey, file.id]
      );
      console.log(`  DB updated: gzFileKey set for id=${file.id}`);
      await conn.end();
    } catch (err) {
      console.error(`  Gzip upload failed: ${err.message}`);
    }
    
    // Summary
    console.log(`\n  Summary for ${file.specialty}:`);
    console.log(`    Original: ${(origSize / 1024 / 1024).toFixed(1)}MB`);
    if (lodSize > 0) console.log(`    LOD: ${(lodSize / 1024 / 1024).toFixed(1)}MB (${((lodSize / origSize) * 100).toFixed(1)}% of original)`);
    console.log(`    Gzip: ${(gzSize / 1024 / 1024).toFixed(1)}MB (${((1 - gzSize / origSize) * 100).toFixed(0)}% smaller)`);
  }
  
  console.log('\n=== All optimizations complete ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
