/**
 * Upload a completed GLB file to S3 and update the DB record.
 * Usage: npx tsx scripts/upload-glb-to-s3.ts <specialty> <glb_path>
 * Example: npx tsx scripts/upload-glb-to-s3.ts sanitary /home/ubuntu/glb-output/sanitary.glb
 */
import "dotenv/config";
import { storagePut } from "../server/storage";
import { db } from "../server/db";
import { projectFiles } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import fs from "fs";

const HIDALMA_PROJECT_ID = 60001;

// Map specialty names to DB specialty values
const SPECIALTY_MAP: Record<string, string> = {
  architecture: "architecture",
  electrical: "electrical",
  hydraulic: "hydraulic",
  sanitary: "sanitary",
};

async function main() {
  const specialty = process.argv[2];
  const glbPath = process.argv[3];

  if (!specialty || !glbPath) {
    console.error("Usage: npx tsx scripts/upload-glb-to-s3.ts <specialty> <glb_path>");
    process.exit(1);
  }

  const dbSpecialty = SPECIALTY_MAP[specialty];
  if (!dbSpecialty) {
    console.error(`Unknown specialty: ${specialty}. Valid: ${Object.keys(SPECIALTY_MAP).join(", ")}`);
    process.exit(1);
  }

  // Read GLB file
  const glbBuffer = fs.readFileSync(glbPath);
  const sizeMB = glbBuffer.length / 1024 / 1024;
  console.log(`GLB file: ${glbPath} (${sizeMB.toFixed(1)}MB)`);

  // Upload to S3
  const fileKey = `projects/${HIDALMA_PROJECT_ID}/${specialty}-${Date.now()}.glb`;
  console.log(`Uploading to S3: ${fileKey}...`);
  const { url } = await storagePut(fileKey, glbBuffer, "model/gltf-binary");
  console.log(`S3 URL: ${url}`);

  // Update DB record
  console.log(`Updating DB for project ${HIDALMA_PROJECT_ID}, specialty ${dbSpecialty}...`);
  const result = await db
    .update(projectFiles)
    .set({
      url: url,
      fileKey: fileKey,
      conversionStatus: "ready",
    })
    .where(
      and(
        eq(projectFiles.projectId, HIDALMA_PROJECT_ID),
        eq(projectFiles.specialty, dbSpecialty)
      )
    );

  console.log(`DB updated. Rows affected: ${(result as any)[0]?.affectedRows ?? "unknown"}`);
  console.log(`✓ ${specialty} complete!`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
