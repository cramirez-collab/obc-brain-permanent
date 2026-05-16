/**
 * Convert RVT files from APS SVF2 format to GLB using forge-convert-utils.
 * This is MUCH faster than IFC→GLB because APS already did the heavy lifting.
 * 
 * Flow: RVT (already uploaded to APS) → SVF2 (already translated) → GLB (local)
 */
import { getApsToken } from "../server/apsConvert";
import { SvfReader, GltfWriter } from "forge-convert-utils";
import fs from "fs";
import path from "path";
import { storagePut } from "../server/storage";
import { getDb } from "../server/db";

const APS_BASE = "https://developer.api.autodesk.com";
const BUCKET_KEY = "ifc-wall-viewer-conversions";

// Map specialty to the object key pattern used in APS
const SPECIALTIES_TO_CONVERT = [
  { specialty: "sanitary", pattern: "sanitary" },
  { specialty: "hydraulic", pattern: "hydraulic" },
  { specialty: "architecture", pattern: "architecture" },
  { specialty: "electrical", pattern: "electrical" },
];

async function listBucketObjects(token: string): Promise<any[]> {
  const res = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`List objects failed: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

function toBase64Urn(objectId: string): string {
  return Buffer.from(objectId).toString("base64url");
}

async function getManifest(token: string, urn: string): Promise<any> {
  const res = await fetch(
    `${APS_BASE}/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Manifest failed: ${res.status}`);
  return res.json();
}

async function convertSvfToGlb(urn: string, outputPath: string): Promise<{ meshCount: number; vertexCount: number }> {
  // Use forge-convert-utils to read SVF from APS and write GLB
  // IAuthOptions accepts either { client_id, client_secret } or { token }
  const auth = { client_id: process.env.APS_CLIENT_ID!, client_secret: process.env.APS_CLIENT_SECRET! };
  
  // First get the manifest to find viewable GUIDs
  const token = await getApsToken();
  const manifest = await getManifest(token, urn);
  
  // Find SVF/SVF2 viewable GUIDs
  const viewableGuids: string[] = [];
  for (const deriv of manifest.derivatives || []) {
    if (deriv.outputType === "svf" || deriv.outputType === "svf2") {
      for (const child of deriv.children || []) {
        if (child.type === "geometry" && child.role === "3d") {
          viewableGuids.push(child.guid);
        }
      }
    }
  }
  
  console.log(`  Found ${viewableGuids.length} viewable(s)`);
  
  if (viewableGuids.length === 0) {
    throw new Error("No 3D viewables found in SVF manifest");
  }
  
  let meshCount = 0;
  let vertexCount = 0;
  
  // Process each viewable
  for (const guid of viewableGuids) {
    console.log(`  Processing viewable: ${guid}`);
    const reader = await SvfReader.FromDerivativeService(urn, guid, auth);
    const fragments = await reader.read();
    
    const writer = new GltfWriter({
      deduplicate: true,
      skipUnusedUvs: true,
      center: false,
      log: () => {},
    } as any);
    
    for await (const fragment of fragments) {
      meshCount++;
      if ((fragment as any).geometry?.getVertexBufferLength) {
        vertexCount += (fragment as any).geometry.getVertexBufferLength() / 3;
      }
      writer.write(fragment);
    }
    
    await writer.close(outputPath);
  }
  
  return { meshCount, vertexCount };
}

async function main() {
  const token = await getApsToken();
  console.log("Got APS token");
  
  // List all objects in the bucket
  const objects = await listBucketObjects(token);
  console.log(`Found ${objects.length} objects in APS bucket`);
  
  for (const spec of SPECIALTIES_TO_CONVERT) {
    console.log(`\n=== Processing ${spec.specialty} ===`);
    
    // Find the matching object
    const obj = objects.find((o: any) => 
      o.objectKey.includes(`-${spec.pattern}.rvt`)
    );
    
    if (!obj) {
      console.log(`  No object found matching "${spec.pattern}", skipping`);
      continue;
    }
    
    console.log(`  Found: ${obj.objectKey} (${(obj.size / 1024 / 1024).toFixed(1)}MB)`);
    
    const urn = toBase64Urn(obj.objectId);
    
    // Check manifest status
    const manifest = await getManifest(token, urn);
    console.log(`  Manifest status: ${manifest.status}, progress: ${manifest.progress}`);
    
    if (manifest.status !== "success") {
      console.log(`  Translation not complete, skipping`);
      continue;
    }
    
    // Check if SVF2 derivative exists
    const hasSvf = manifest.derivatives?.some((d: any) => 
      d.outputType === "svf" || d.outputType === "svf2"
    );
    
    if (!hasSvf) {
      console.log(`  No SVF/SVF2 derivative found. Need to submit SVF2 translation first.`);
      // Submit SVF2 translation
      const jobRes = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-ads-force": "true",
        },
        body: JSON.stringify({
          input: { urn },
          output: {
            formats: [{ type: "svf2", views: ["3d"] }],
          },
        }),
      });
      console.log(`  SVF2 translation submitted: ${jobRes.status}`);
      continue;
    }
    
    // Convert SVF to GLB
    const outputDir = "/home/ubuntu/glb-output";
    fs.mkdirSync(outputDir, { recursive: true });
    const glbPath = path.join(outputDir, `${spec.specialty}.glb`);
    
    console.log(`  Converting SVF → GLB...`);
    try {
      const result = await convertSvfToGlb(urn, glbPath);
      
      const glbSize = fs.statSync(glbPath).size;
      console.log(`  ✓ GLB created: ${result.meshCount} meshes, ${result.vertexCount} verts, ${(glbSize / 1024 / 1024).toFixed(1)}MB`);
      
      // Upload to S3
      console.log(`  Uploading to S3...`);
      const glbBuffer = fs.readFileSync(glbPath);
      const s3Key = `hidalma/${spec.specialty}-${Date.now()}.glb`;
      const { url } = await storagePut(s3Key, glbBuffer, "model/gltf-binary");
      console.log(`  ✓ S3 URL: ${url}`);
      
      // Update DB
      console.log(`  Updating DB...`);
      const db = await getDb();
      const { projectFiles } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      await db.update(projectFiles)
        .set({
          url,
          fileKey: s3Key,
          conversionStatus: "ready",
        })
        .where(
          and(
            eq(projectFiles.projectId, 60001),
            eq(projectFiles.specialty, spec.specialty)
          )
        );
      console.log(`  ✓ DB updated`);
      
    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}`);
    }
  }
  
  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch(console.error);
