import { storageGet } from "../server/storage.ts";

const result = await storageGet("310519663201051818/hidalma-structure-new.glb");
console.log("Full URL:", result.url);
console.log("Key:", result.key);

// Test if the URL is accessible
const resp = await fetch(result.url, { method: "HEAD" });
console.log("Status:", resp.status);
console.log("Content-Length:", resp.headers.get("content-length"));
