import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.execute(
    'SELECT id, specialty, rotX, rotY, rotZ, posX, posY, posZ, modelScale FROM project_files WHERE projectId = 60001 ORDER BY id'
  );
  console.table(rows);
  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
