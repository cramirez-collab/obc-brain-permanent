/**
 * Update DB records for Hidalma project files with new fileKeys from storagePut pipeline.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { eq, and, like } from "drizzle-orm";
import { projectFiles, projects } from "../drizzle/schema.ts";

const db = drizzle(process.env.DATABASE_URL);

// Mapping from specialty to new fileKey
const FILE_KEY_MAP = {
  "fire_protection": "hidalma-glb/fire_protection.glb",
  "pluvial": "hidalma-glb/pluvial.glb",
  "sanitary": "hidalma-glb/sanitary.glb",
  "structure": "hidalma-glb/structure.glb",
  "gas": "hidalma-glb/gas.glb",
  "hvac": "hidalma-glb/hvac.glb",
  "architecture": "hidalma-glb/architecture.glb",
  "electrical": "hidalma-glb/electrical.glb",
  "hydraulic": "hidalma-glb/hydraulic.glb",
};

// File sizes from the pipeline (approximate MB)
const FILE_SIZES = {
  "fire_protection": 3.4 * 1024 * 1024,
  "pluvial": 13.6 * 1024 * 1024,
  "sanitary": 21.7 * 1024 * 1024,
  "structure": 37.0 * 1024 * 1024,
  "gas": 117.5 * 1024 * 1024,
  "hvac": 201.2 * 1024 * 1024,
  "architecture": 350.7 * 1024 * 1024,
  "electrical": 797.8 * 1024 * 1024,
  "hydraulic": 912.9 * 1024 * 1024,
};

async function main() {
  // Find Hidalma project
  const [project] = await db.select().from(projects).where(like(projects.name, "%Hidalma%")).limit(1);
  if (!project) {
    console.error("Hidalma project not found!");
    process.exit(1);
  }
  console.log(`Found project: ${project.name} (ID: ${project.id})`);

  // Get all files for this project
  const files = await db.select().from(projectFiles).where(eq(projectFiles.projectId, project.id));
  console.log(`Found ${files.length} files`);

  for (const file of files) {
    const newFileKey = FILE_KEY_MAP[file.specialty];
    if (!newFileKey) {
      console.log(`  [SKIP] ${file.specialty} - no mapping found`);
      continue;
    }

    const fileSize = Math.round(FILE_SIZES[file.specialty] || 0);
    
    console.log(`  Updating ${file.specialty} (ID: ${file.id}): fileKey=${newFileKey}, fileSize=${(fileSize/1024/1024).toFixed(1)}MB`);
    
    await db.update(projectFiles)
      .set({ 
        fileKey: newFileKey,
        url: newFileKey, // url field also needs to be updated
        fileSize: fileSize,
        conversionStatus: "ready",
      })
      .where(eq(projectFiles.id, file.id));
  }

  // Update project status
  await db.update(projects)
    .set({ status: "ready" })
    .where(eq(projects.id, project.id));

  console.log("\nAll files updated successfully!");
  
  // Verify
  const updated = await db.select({
    id: projectFiles.id,
    specialty: projectFiles.specialty,
    fileKey: projectFiles.fileKey,
    fileSize: projectFiles.fileSize,
  }).from(projectFiles).where(eq(projectFiles.projectId, project.id));
  
  for (const f of updated) {
    console.log(`  ${f.specialty}: key=${f.fileKey}, size=${(f.fileSize/1024/1024).toFixed(1)}MB`);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
