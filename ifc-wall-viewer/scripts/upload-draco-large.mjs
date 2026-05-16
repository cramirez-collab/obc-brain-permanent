import { storagePut } from "../server/storage.ts";
import { getDb } from "../server/db.ts";
import { projectFiles } from "../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { readFileSync } from "fs";

const files = [
  {
    name: "electrical",
    path: "/home/ubuntu/glb-draco-large/electrical-draco.glb",
    newKey: "hidalma/electrical-draco-v3.glb",
    specialty: "electrical",
  },
  {
    name: "hydraulic",
    path: "/home/ubuntu/glb-draco-large/hydraulic-draco.glb",
    newKey: "hidalma/hydraulic-draco-v3.glb",
    specialty: "hydraulic",
  },
];

const db = await getDb();

for (const f of files) {
  console.log(`Uploading ${f.name}...`);
  const data = readFileSync(f.path);
  console.log(`  Read ${(data.length / 1024 / 1024).toFixed(1)} MB`);
  
  const { url } = await storagePut(f.newKey, data, "model/gltf-binary");
  console.log(`  Uploaded: ${url}`);
  
  // Update DB fileKey and fileSize
  const rows = await db.select().from(projectFiles).where(eq(projectFiles.specialty, f.specialty));
  if (rows.length > 0) {
    const fileId = rows[0].id;
    await db.update(projectFiles).set({
      fileKey: f.newKey,
      fileSize: data.length,
      gzFileKey: null, // No longer needed since Draco is better
    }).where(eq(projectFiles.id, fileId));
    console.log(`  DB updated: fileId=${fileId}, fileKey=${f.newKey}, size=${(data.length/1024/1024).toFixed(1)}MB`);
  } else {
    console.log(`  WARNING: No file found for specialty ${f.specialty}`);
  }
}

console.log("DONE");
process.exit(0);
