import "dotenv/config";
import { getApsToken } from "../server/apsConvert";
import fs from "fs";

const APS_BASE = "https://developer.api.autodesk.com";
const BUCKET_KEY = "ifc-wall-viewer-conversions";

async function main() {
  const token = await getApsToken();
  
  // List objects and find sanitary
  const listRes = await fetch(
    `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects?limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const listData = await listRes.json();
  const objects = listData.items || [];
  
  // Find the most recent sanitary object
  const sanitaryObjs = objects.filter((o: any) => o.objectKey?.includes("-sanitary.rvt"));
  const obj = sanitaryObjs[0]; // Most recent
  
  if (!obj) {
    console.error("No sanitary object found");
    return;
  }
  
  console.log(`Found: ${obj.objectKey} (${(obj.size / 1024 / 1024).toFixed(1)}MB)`);
  
  const base64Urn = Buffer.from(obj.objectId).toString("base64url");
  const manifestRes = await fetch(
    `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  
  const manifest = await manifestRes.json();
  console.log(`Manifest: ${manifest.status}`);
  
  for (const deriv of manifest.derivatives || []) {
    if (deriv.outputType === "ifc" && deriv.status === "success") {
      for (const child of deriv.children || []) {
        if (child.urn?.endsWith(".ifc") || child.role === "ifc") {
          const encodedDerivUrn = encodeURIComponent(child.urn);
          const downloadUrl = `${APS_BASE}/modelderivative/v2/designdata/${base64Urn}/manifest/${encodedDerivUrn}`;
          
          const cmd = `curl -L -H "Authorization: Bearer ${token}" "${downloadUrl}" -o /home/ubuntu/ifc-downloads/sanitary.ifc`;
          fs.writeFileSync("/home/ubuntu/download-sanitary.sh", `#!/bin/bash\n${cmd}\n`);
          console.log("Download script: /home/ubuntu/download-sanitary.sh");
        }
      }
    }
  }
}

main().catch(console.error);
