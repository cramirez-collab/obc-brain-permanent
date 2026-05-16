import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { eq } from 'drizzle-orm';
import { optimizeGLB } from './server/optimizeGLB.ts';
import { storagePut } from './server/storage.ts';

// MEP specialties that need re-optimization
const MEP_SPECIALTIES = ['hvac', 'plumbing', 'electrical', 'mechanical', 'fire_protection'];

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const db = drizzle(conn, { mode: 'default' });

  // Get all project files
  const files = await db.execute('SELECT id, specialty, url, original_url, file_size, file_name FROM project_files');
  const rows = files[0];

  console.log(`Found ${rows.length} files total`);

  for (const row of rows) {
    const { id, specialty, url, original_url, file_size, file_name } = row;
    const isMEP = MEP_SPECIALTIES.includes(specialty);
    const level = isMEP ? 'mep' : undefined; // Use auto-detect for non-MEP

    // Use original_url if available, otherwise current url
    const sourceUrl = original_url || url;
    console.log(`\n[${id}] ${specialty} (${file_name}) - ${isMEP ? 'MEP' : 'standard'} pipeline`);
    console.log(`  Source: ${sourceUrl}`);

    try {
      // Download original file
      console.log(`  Downloading...`);
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      console.log(`  Downloaded: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);

      // Re-optimize
      console.log(`  Optimizing with ${isMEP ? 'meshopt (lossless)' : 'standard'} pipeline...`);
      const result = await optimizeGLB(buffer, level);
      console.log(`  Result: ${(result.optimizedSize / 1024 / 1024).toFixed(2)}MB (${((1 - result.ratio) * 100).toFixed(0)}% reduction)`);

      // Upload to S3
      const suffix = Math.random().toString(36).substring(2, 10);
      const baseName = file_name.replace(/\.glb$/i, '');
      const key = `310519663201051818/reopt/${baseName}-meshopt-${suffix}.glb`;
      console.log(`  Uploading to S3...`);
      const { url: newUrl } = await storagePut(key, Buffer.from(result.buffer), 'model/gltf-binary');
      console.log(`  New URL: ${newUrl}`);

      // Update DB
      await db.execute(
        `UPDATE project_files SET url = ?, file_size = ? WHERE id = ?`,
        [newUrl, result.optimizedSize, id]
      );
      console.log(`  DB updated ✓`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  await conn.end();
  console.log('\nDone!');
}

main().catch(console.error);
