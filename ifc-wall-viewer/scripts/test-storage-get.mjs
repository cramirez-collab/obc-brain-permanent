import dotenv from "dotenv";
dotenv.config();

const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL.replace(/\/+$/, "");
const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY;

async function storageGetUrl(fileKey) {
  const url = new URL("v1/storage/downloadUrl", FORGE_API_URL + "/");
  url.searchParams.set("path", fileKey);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${FORGE_API_KEY}` },
  });
  const data = await res.json();
  return data.url;
}

// Test with structure file
const key = "projects/60001/structure-kwmuub53.glb";
console.log("Getting presigned URL for:", key);
const presignedUrl = await storageGetUrl(key);
console.log("Presigned URL:", presignedUrl.substring(0, 120));

// Test if it works
const headRes = await fetch(presignedUrl, { method: "HEAD" });
console.log("Status:", headRes.status, "Size:", headRes.headers.get("content-length"));
