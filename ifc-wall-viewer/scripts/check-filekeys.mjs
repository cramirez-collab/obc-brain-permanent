import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { projectFiles } from "../drizzle/schema.ts";
import { eq } from "drizzle-orm";

const conn = await mysql.createConnection({
  uri: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});
const db = drizzle(conn);
const rows = await db.select({
  specialty: projectFiles.specialty,
  fileKey: projectFiles.fileKey,
  url: projectFiles.url,
}).from(projectFiles).where(eq(projectFiles.projectId, 60001));

for (const r of rows) {
  console.log(`${r.specialty}: fileKey=${r.fileKey} | url=${r.url.substring(0, 80)}...`);
}
await conn.end();
