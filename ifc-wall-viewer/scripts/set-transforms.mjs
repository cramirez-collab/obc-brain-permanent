import { getDb } from "../server/db.ts";
import { projectFiles } from "../drizzle/schema.ts";
import { eq, and } from "drizzle-orm";

const PROJECT_ID = 60001;

// Transform values based on analysis:
// - 7 APS models: root transforms baked in GLB (scale 0.3048 + rot -90° X)
//   → Three.js applies automatically → no additional transform needed
// - Hydraulic & Electrical: NO root transforms, raw feet Z-up
//   → Need scale=0.3048 + rotX=-90 to match APS models
const transforms = {
  fire_protection: { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  pluvial:         { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  structure:       { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  sanitary:        { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  gas:             { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  hvac:            { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  architecture:    { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 1.0 },
  hydraulic:       { rotX: -90, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 0.3048 },
  electrical:      { rotX: -90, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0, modelScale: 0.3048 },
};

async function main() {
  const db = await getDb();
  
  for (const [specialty, t] of Object.entries(transforms)) {
    const result = await db.update(projectFiles)
      .set({
        rotX: t.rotX,
        rotY: t.rotY,
        rotZ: t.rotZ,
        posX: t.posX,
        posY: t.posY,
        posZ: t.posZ,
        modelScale: t.modelScale,
      })
      .where(and(
        eq(projectFiles.projectId, PROJECT_ID),
        eq(projectFiles.specialty, specialty),
      ));
    
    console.log(`${specialty}: set rotX=${t.rotX}, scale=${t.modelScale}`);
  }
  
  console.log("\nAll transforms saved to DB.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
