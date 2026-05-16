/**
 * Get IFC download URLs from APS for the 4 pending specialties.
 * The RVTs were already uploaded and converted to IFC in APS.
 * We need to find them in the bucket and get their manifest/derivative URLs.
 */
import "dotenv/config";
import { getApsToken } from "../server/apsConvert";
import fs from "fs";

const APS_BASE = "https://developer.api.autodesk.com";
const BUCKET_KEY = "ifc-wall-viewer-conversions";

// The 4 pending specialties
const PENDING = ["architecture", "electrical", "hydraulic", "sanitary"];

async function main() {
  const token = await getApsToken();
  console.log("Token obtained");

  // List all objects in the bucket
  const listRes = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!listRes.ok) {
    console.error("Failed to list bucket objects:", await listRes.text());
    return;
  }

  const listData = await listRes.json();
  const objects = listData.items || [];
  console.log(`Found ${objects.length} objects in bucket`);

  // Map specialty keywords to objects
  const specialtyMap: Record<string, string> = {
    architecture: "architecture",
    electrical: "electrical",
    hydraulic: "hydraulic",
    sanitary: "sanitary",
  };

  const curlCommands: string[] = [];

  for (const specialty of PENDING) {
    const keyword = specialtyMap[specialty];
    // Find the object matching this specialty
    const obj = objects.find((o: any) => 
      o.objectKey?.includes(`-${keyword}.rvt`)
    );

    if (!obj) {
      console.log(`No object found for ${specialty} (keyword: ${keyword})`);
      // List all object keys for debugging
      console.log("Available objects:", objects.map((o: any) => o.objectKey).join("\n"));
      continue;
    }

    console.log(`\nFound ${specialty}: ${obj.objectKey} (${(obj.size / 1024 / 1024).toFixed(1)}MB)`);

    // Get the manifest for this object
    const base64Urn = Buffer.from(obj.objectId).toString("base64url");
    const manifestRes = await fetch(
      `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!manifestRes.ok) {
      console.log(`  No manifest for ${specialty}: ${manifestRes.status}`);
      continue;
    }

    const manifest = await manifestRes.json();
    console.log(`  Manifest status: ${manifest.status}, progress: ${manifest.progress}`);

    if (manifest.status !== "success") {
      console.log(`  Translation not complete for ${specialty}`);
      continue;
    }

    // Find IFC derivative
    for (const deriv of manifest.derivatives || []) {
      if (deriv.outputType === "ifc" && deriv.status === "success") {
        for (const child of deriv.children || []) {
          if (child.urn?.endsWith(".ifc") || child.role === "ifc") {
            const encodedDerivUrn = encodeURIComponent(child.urn);
            const downloadUrl = `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest/${encodedDerivUrn}`;
            
            console.log(`  IFC derivative found: ${child.urn}`);
            curlCommands.push(
              `curl -L -H "Authorization: Bearer ${token}" "${downloadUrl}" -o /home/ubuntu/ifc-downloads/${specialty}.ifc`
            );
          }
        }
      }
    }
  }

  if (curlCommands.length > 0) {
    const script = "#!/bin/bash\nmkdir -p /home/ubuntu/ifc-downloads\n" + 
      curlCommands.map((cmd, i) => `echo "Downloading ${PENDING[i]}..."\n${cmd}\necho "Done ${PENDING[i]}"`).join("\n") + "\n";
    fs.writeFileSync("/home/ubuntu/download-pending-ifcs.sh", script);
    console.log(`\nGenerated download script: /home/ubuntu/download-pending-ifcs.sh`);
    console.log(`Run: bash /home/ubuntu/download-pending-ifcs.sh`);
  }
}

main().catch(console.error);
