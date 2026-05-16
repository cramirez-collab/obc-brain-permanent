import { int, float, mysqlEnum, mysqlTable, text, timestamp, varchar, json } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", ["processing", "ready", "error"]).default("processing").notNull(),
  thumbnail: text("thumbnail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

export const projectFiles = mysqlTable("project_files", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  specialty: varchar("specialty", { length: 64 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  url: text("url").notNull(),
  fileKey: text("fileKey").notNull(),
  color: varchar("color", { length: 16 }).notNull(),
  transparent: int("transparent").default(0).notNull(),
  opacity: int("opacity").default(100).notNull(),
  showEdges: int("showEdges").default(0).notNull(),
  vertexCount: int("vertexCount").default(0),
  fileSize: int("fileSize").default(0),
  lodUrl: text("lodUrl"),
  gzFileKey: text("gzFileKey"),
  // Per-model transform corrections (applied in viewer)
  rotX: float("rotX").default(0).notNull(),
  rotY: float("rotY").default(0).notNull(),
  rotZ: float("rotZ").default(0).notNull(),
  posX: float("posX").default(0).notNull(),
  posY: float("posY").default(0).notNull(),
  posZ: float("posZ").default(0).notNull(),
  modelScale: float("modelScale").default(1).notNull(),
  inspectionStatus: mysqlEnum("inspectionStatus", ["pending", "in_progress", "accepted", "rejected"]).default("pending").notNull(),
  conversionStatus: mysqlEnum("conversionStatus", ["ready", "pending_conversion"]).default("ready").notNull(),
  originalFormat: varchar("originalFormat", { length: 16 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ProjectFile = typeof projectFiles.$inferSelect;
export type InsertProjectFile = typeof projectFiles.$inferInsert;

/* ─── Bitácora de Observaciones ─── */
export const observations = mysqlTable("observations", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  category: mysqlEnum("category", ["general", "estructura", "arquitectura", "instalaciones", "seguridad", "calidad"]).default("general").notNull(),
  priority: mysqlEnum("priority", ["baja", "media", "alta", "critica"]).default("media").notNull(),
  status: mysqlEnum("status", ["abierta", "en_revision", "resuelta", "cerrada"]).default("abierta").notNull(),
  location: text("location"), // JSON: {x,y,z} position in model or floor label
  photoUrl: text("photoUrl"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Observation = typeof observations.$inferSelect;
export type InsertObservation = typeof observations.$inferInsert;

/* ─── Chat / Mensajes por Observación o Proyecto ─── */
export const chatMessages = mysqlTable("chat_messages", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  observationId: int("observationId"), // null = project-level chat
  rfiId: int("rfiId"), // null = not linked to RFI
  userId: int("userId").notNull(),
  message: text("message").notNull(),
  imageUrl: text("imageUrl"), // optional attached image
  mentions: text("mentions"), // JSON array of mentioned user IDs
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

/* ─── RFI (Request for Information) ─── */
export const rfis = mysqlTable("rfis", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  assignedToUserId: int("assignedToUserId"),
  number: int("number").notNull(), // sequential per project
  subject: varchar("subject", { length: 500 }).notNull(),
  description: text("description"),
  category: mysqlEnum("category", ["diseno", "estructura", "instalaciones", "arquitectura", "coordinacion", "otro"]).default("otro").notNull(),
  priority: mysqlEnum("priority", ["baja", "media", "alta", "urgente"]).default("media").notNull(),
  status: mysqlEnum("status", ["borrador", "enviada", "en_revision", "respondida", "cerrada"]).default("borrador").notNull(),
  dueDate: timestamp("dueDate"),
  response: text("response"),
  respondedByUserId: int("respondedByUserId"),
  respondedAt: timestamp("respondedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Rfi = typeof rfis.$inferSelect;
export type InsertRfi = typeof rfis.$inferInsert;

/* ─── RFI Attachments (fotos con markup) ─── */
export const rfiAttachments = mysqlTable("rfi_attachments", {
  id: int("id").autoincrement().primaryKey(),
  rfiId: int("rfiId").notNull(),
  userId: int("userId").notNull(),
  imageUrl: text("imageUrl").notNull(),
  markupUrl: text("markupUrl"), // URL of the annotated/marked-up version
  caption: text("caption"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type RfiAttachment = typeof rfiAttachments.$inferSelect;
export type InsertRfiAttachment = typeof rfiAttachments.$inferInsert;

/* ─── Inspection Marks (painted meshes for Avance) ─── */
export const inspectionMarks = mysqlTable("inspection_marks", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  fileId: int("fileId").notNull(), // references projectFiles.id
  meshName: varchar("meshName", { length: 512 }).notNull(), // mesh.name from GLB
  meshIndex: int("meshIndex").notNull(), // index within the file's mesh list for identification
  userId: int("userId").notNull(), // who marked it
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InspectionMark = typeof inspectionMarks.$inferSelect;
export type InsertInspectionMark = typeof inspectionMarks.$inferInsert;

/* ─── Anotaciones 3D en el Modelo ─── */
export const annotations3d = mysqlTable("annotations_3d", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull(),
  userId: int("userId").notNull(),
  text: text("text").notNull(),
  category: mysqlEnum("category", ["observacion", "defecto", "aprobado", "informativo"]).default("observacion").notNull(),
  floorLabel: varchar("floorLabel", { length: 64 }),
  posX: float("posX").notNull(),
  posY: float("posY").notNull(),
  posZ: float("posZ").notNull(),
  resolved: int("resolved").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Annotation3d = typeof annotations3d.$inferSelect;
export type InsertAnnotation3d = typeof annotations3d.$inferInsert;
