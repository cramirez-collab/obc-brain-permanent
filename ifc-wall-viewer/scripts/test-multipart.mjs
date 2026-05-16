import dotenv from "dotenv";
dotenv.config();
import fs from "fs";

const PART_SIZE = 5 * 1024 * 1024;
const clientId = process.env.APS_CLIENT_ID;
const clientSecret = process.env.APS_CLIENT_SECRET;
const bucketKey = "ifc-wall-viewer-conversions";

const tokenRes = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: "data:read data:write bucket:read bucket:create" })
});
const { access_token } = await tokenRes.json();

// Use actual fire_protection RVT file
const filePath = "/home/ubuntu/hidalma-rvt/HMA-01-OBJETIVA-PCI-01-AB.rvt";
const fileBuffer = fs.readFileSync(filePath);
const totalParts = Math.ceil(fileBuffer.length / PART_SIZE);
console.log("File size:", fileBuffer.length, "Total parts:", totalParts);

const objectKey = "test-fire-" + Date.now() + ".rvt";

// Request parts in batches of 25, reusing uploadKey
let uploadKey = null;
let partNum = 1;

while (partNum <= totalParts) {
  const batchSize = Math.min(25, totalParts - partNum + 1);
  console.log(`\nRequesting URLs for parts ${partNum} to ${partNum + batchSize - 1}...`);
  
  let url = `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?firstPart=${partNum}&parts=${batchSize}&minutesExpiration=60`;
  if (uploadKey) url += `&uploadKey=${encodeURIComponent(uploadKey)}`;
  
  const signRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const signData = await signRes.json();
  if (!uploadKey) uploadKey = signData.uploadKey;
  console.log("Got", signData.urls.length, "URLs");

  for (let i = 0; i < signData.urls.length; i++) {
    const globalIdx = partNum - 1 + i;
    const start = globalIdx * PART_SIZE;
    const end = Math.min(start + PART_SIZE, fileBuffer.length);
    const partData = Buffer.from(fileBuffer.subarray(start, end));
    
    const putRes = await fetch(signData.urls[i], {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(partData.length) },
      body: partData,
    });
    await putRes.text();
    process.stdout.write(`Part ${globalIdx + 1}:${putRes.status} `);
  }
  console.log("");
  partNum += batchSize;
}

// Finalize
console.log("\nFinalizing...");
const completeRes = await fetch(
  `https://developer.api.autodesk.com/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uploadKey }),
  }
);
const data = await completeRes.json();
console.log("Complete status:", completeRes.status, "size:", data.size);
if (data.reason) {
  const pending = data.parts?.filter(p => p.status !== "Ok");
  console.log("Error:", data.reason, "Pending parts:", pending?.length);
}
