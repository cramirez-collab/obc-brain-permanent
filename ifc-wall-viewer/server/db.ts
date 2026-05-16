import { eq, desc, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, projects, projectFiles, observations, chatMessages, rfis, rfiAttachments, inspectionMarks, annotations3d, type InsertProject, type InsertProjectFile, type InsertObservation, type InsertChatMessage, type InsertRfi, type InsertRfiAttachment, type InsertInspectionMark, type InsertAnnotation3d } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ── Project queries ──

export async function createProject(data: InsertProject) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(projects).values(data);
  return result[0].insertId;
}

export async function getProjectsByUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.createdAt));
}

export async function getProjectById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateProjectStatus(id: number, status: "processing" | "ready" | "error") {
  const db = await getDb();
  if (!db) return;
  await db.update(projects).set({ status }).where(eq(projects.id, id));
}

export async function deleteProject(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(projectFiles).where(eq(projectFiles.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
}

// ── ProjectFile queries ──

export async function addProjectFile(data: InsertProjectFile) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(projectFiles).values(data);
}

export async function getProjectFiles(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(projectFiles).where(eq(projectFiles.projectId, projectId));
}

export async function updateProjectFile(id: number, data: Partial<InsertProjectFile>) {
  const db = await getDb();
  if (!db) return;
  await db.update(projectFiles).set(data).where(eq(projectFiles.id, id));
}

export async function getProjectFileById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(projectFiles).where(eq(projectFiles.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function deleteProjectFile(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Also delete related inspection marks
  await db.delete(inspectionMarks).where(eq(inspectionMarks.fileId, id));
  await db.delete(projectFiles).where(eq(projectFiles.id, id));
}

// ── Observations (Bitácora) ──

export async function createObservation(data: InsertObservation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(observations).values(data);
  return result[0].insertId;
}

export async function getObservationsByProject(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(observations).where(eq(observations.projectId, projectId)).orderBy(desc(observations.createdAt));
}

export async function getObservationById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(observations).where(eq(observations.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateObservation(id: number, data: Partial<InsertObservation>) {
  const db = await getDb();
  if (!db) return;
  await db.update(observations).set(data).where(eq(observations.id, id));
}

// ── Chat Messages ──

export async function createChatMessage(data: InsertChatMessage) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(chatMessages).values(data);
  return result[0].insertId;
}

export async function getChatMessages(projectId: number, opts?: { observationId?: number; rfiId?: number }) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [eq(chatMessages.projectId, projectId)];
  if (opts?.observationId) conditions.push(eq(chatMessages.observationId, opts.observationId));
  else if (opts?.rfiId) conditions.push(eq(chatMessages.rfiId, opts.rfiId));
  else {
    // Project-level chat: no observation or rfi link
    conditions.push(sql`${chatMessages.observationId} IS NULL`);
    conditions.push(sql`${chatMessages.rfiId} IS NULL`);
  }
  return db.select().from(chatMessages).where(and(...conditions)).orderBy(chatMessages.createdAt);
}

// ── RFIs ──

export async function createRfi(data: InsertRfi) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(rfis).values(data);
  return result[0].insertId;
}

export async function getRfisByProject(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rfis).where(eq(rfis.projectId, projectId)).orderBy(desc(rfis.createdAt));
}

export async function getRfiById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(rfis).where(eq(rfis.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateRfi(id: number, data: Partial<InsertRfi>) {
  const db = await getDb();
  if (!db) return;
  await db.update(rfis).set(data).where(eq(rfis.id, id));
}

export async function getNextRfiNumber(projectId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 1;
  const result = await db.select({ maxNum: sql<number>`COALESCE(MAX(${rfis.number}), 0)` }).from(rfis).where(eq(rfis.projectId, projectId));
  return (result[0]?.maxNum ?? 0) + 1;
}

// ── RFI Attachments ──

export async function addRfiAttachment(data: InsertRfiAttachment) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(rfiAttachments).values(data);
  return result[0].insertId;
}

export async function getRfiAttachments(rfiId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(rfiAttachments).where(eq(rfiAttachments.rfiId, rfiId)).orderBy(rfiAttachments.createdAt);
}

// ── Users list (for mentions / assignment) ──

export async function getAllUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).orderBy(users.name);
}

// ── Inspection Marks (Avance) ──

export async function getInspectionMarks(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inspectionMarks).where(eq(inspectionMarks.projectId, projectId));
}

export async function addInspectionMark(data: InsertInspectionMark) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(inspectionMarks).values(data);
  return result[0].insertId;
}

export async function removeInspectionMark(projectId: number, fileId: number, meshName: string, meshIndex: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(inspectionMarks).where(
    and(
      eq(inspectionMarks.projectId, projectId),
      eq(inspectionMarks.fileId, fileId),
      eq(inspectionMarks.meshName, meshName),
      eq(inspectionMarks.meshIndex, meshIndex)
    )
  );
}

export async function bulkSaveInspectionMarks(projectId: number, userId: number, marks: { fileId: number; meshName: string; meshIndex: number }[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Clear existing marks for this project
  await db.delete(inspectionMarks).where(eq(inspectionMarks.projectId, projectId));
  // Insert new marks
  if (marks.length > 0) {
    await db.insert(inspectionMarks).values(
      marks.map(m => ({ projectId, userId, fileId: m.fileId, meshName: m.meshName, meshIndex: m.meshIndex }))
    );
  }
  return marks.length;
}

// ── Annotations 3D ──

export async function createAnnotation3d(data: InsertAnnotation3d) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(annotations3d).values(data);
  return result[0].insertId;
}

export async function getAnnotations3d(projectId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(annotations3d).where(eq(annotations3d.projectId, projectId)).orderBy(desc(annotations3d.createdAt));
}

export async function updateAnnotation3d(id: number, data: Partial<InsertAnnotation3d>) {
  const db = await getDb();
  if (!db) return;
  await db.update(annotations3d).set(data).where(eq(annotations3d.id, id));
}

export async function deleteAnnotation3d(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(annotations3d).where(eq(annotations3d.id, id));
}
