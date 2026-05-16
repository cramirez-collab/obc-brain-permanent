import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  createProject,
  getProjectsByUser,
  getProjectById,
  updateProjectStatus,
  deleteProject,
  addProjectFile,
  getProjectFiles,
  updateProjectFile,
  getProjectFileById,
  createObservation,
  getObservationsByProject,
  getObservationById,
  updateObservation,
  createChatMessage,
  getChatMessages,
  createRfi,
  getRfisByProject,
  getRfiById,
  updateRfi,
  getNextRfiNumber,
  addRfiAttachment,
  getRfiAttachments,
  getAllUsers,
  getInspectionMarks,
  bulkSaveInspectionMarks,
  deleteProjectFile,
  createAnnotation3d,
  getAnnotations3d,
  updateAnnotation3d,
  deleteAnnotation3d,
} from "./db";
import { storagePut, storageGet } from "./storage";
import { nanoid } from "nanoid";
import { notifyOwner } from "./_core/notification";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  project: router({
    list: publicProcedure.query(async ({ ctx }) => {
      // If authenticated, show user's projects; otherwise show all
      if (ctx.user) return getProjectsByUser(ctx.user.id);
      // For unauthenticated users, return all projects (public viewer)
      const { getDb } = await import("./db");
      const db = await getDb();
      if (!db) return [];
      const { projects } = await import("../drizzle/schema");
      return db.select().from(projects).orderBy(projects.createdAt);
    }),

    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const project = await getProjectById(input.id);
        if (!project) return null;
        const files = await getProjectFiles(input.id);
        return { ...project, files };
      }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const id = await createProject({
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          status: "processing",
        });
        return { id };
      }),

    addFile: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        specialty: z.string(),
        label: z.string(),
        url: z.string(),
        fileKey: z.string(),
        color: z.string(),
        transparent: z.boolean().default(false),
        opacity: z.number().default(100),
        showEdges: z.boolean().default(false),
        vertexCount: z.number().optional(),
        fileSize: z.number().optional(),
        lodUrl: z.string().optional(),
        conversionStatus: z.enum(["ready", "pending_conversion"]).default("ready"),
        originalFormat: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await addProjectFile({
          projectId: input.projectId,
          specialty: input.specialty,
          label: input.label,
          url: input.url,
          fileKey: input.fileKey,
          color: input.color,
          transparent: input.transparent ? 1 : 0,
          opacity: input.opacity,
          showEdges: input.showEdges ? 1 : 0,
          vertexCount: input.vertexCount ?? 0,
          fileSize: input.fileSize ?? 0,
          lodUrl: input.lodUrl ?? null,
          conversionStatus: input.conversionStatus,
          originalFormat: input.originalFormat ?? null,
        });
        // Notify owner when a new file is added
        const project = await getProjectById(input.projectId);
        const sizeMB = input.fileSize ? (input.fileSize / 1024 / 1024).toFixed(1) : "?";
        notifyOwner({
          title: `\uD83D\uDCC1 Nuevo archivo en ${project?.name || "proyecto"}`,
          content: `Especialidad: ${input.label} (${input.specialty})\nTama\u00f1o: ${sizeMB} MB\nFormato: ${input.originalFormat || "GLB"}`,
        }).catch(() => {});
        return { success: true };
      }),

    deleteFile: protectedProcedure
      .input(z.object({ fileId: z.number() }))
      .mutation(async ({ input }) => {
        await deleteProjectFile(input.fileId);
        return { success: true };
      }),

    setReady: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await updateProjectStatus(input.id, "ready");
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const project = await getProjectById(input.id);
        if (!project || project.userId !== ctx.user.id) {
          throw new Error("Project not found or unauthorized");
        }
        await deleteProject(input.id);
        return { success: true };
      }),

    // Update inspection status of a file
    updateFileStatus: protectedProcedure
      .input(z.object({
        fileId: z.number(),
        inspectionStatus: z.enum(["pending", "in_progress", "accepted", "rejected"]),
      }))
      .mutation(async ({ input }) => {
        await updateProjectFile(input.fileId, { inspectionStatus: input.inspectionStatus });
        return { success: true };
      }),

    // Re-process a file with updated optimization pipeline
    reprocessFile: protectedProcedure
      .input(z.object({ fileId: z.number() }))
      .mutation(async ({ input }) => {
        const file = await getProjectFileById(input.fileId);
        if (!file) throw new Error("File not found");

        // Download the original GLB from S3
        const response = await fetch(file.url);
        if (!response.ok) throw new Error("Failed to download original file");
        const buffer = Buffer.from(await response.arrayBuffer());

        const { optimizeGLB } = await import("./optimizeGLB");
        const MEP_SPECIALTIES = ["electrical", "mechanical", "plumbing", "hvac", "fire", "fire_protection"];
        const isMEP = MEP_SPECIALTIES.includes(file.specialty);

        const result = await optimizeGLB(buffer, isMEP ? "mep" : undefined);

        // Upload re-processed file to S3
        const { nanoid: genId } = await import("nanoid");
        const fileKey = `projects/${file.projectId}/${file.specialty}-reopt-${genId(8)}.glb`;
        const { url: newUrl } = await storagePut(fileKey, result.buffer, "model/gltf-binary");

        // Update DB record with new URL and stats
        await updateProjectFile(file.id, {
          url: newUrl,
          fileKey,
          fileSize: result.optimizedSize,
        });

        return {
          success: true,
          url: newUrl,
          originalSize: result.originalSize,
          optimizedSize: result.optimizedSize,
          ratio: result.ratio,
          level: result.level,
        };
      }),

    // Get a storage upload URL for direct frontend upload (bypasses proxy size limits)
    getUploadUrl: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        specialty: z.string(),
        fileType: z.enum(["glb", "ifc", "rvt"]),
        fileName: z.string(),
      }))
      .mutation(async ({ input }) => {
        const ext = input.fileType;
        const fileKey = `projects/${input.projectId}/${input.specialty}-${nanoid(8)}.${ext}`;
        // Return the storage proxy upload URL + auth header for direct frontend upload
        const { ENV } = await import("./_core/env");
        const baseUrl = ENV.forgeApiUrl.replace(/\/+$/, "");
        const uploadUrl = `${baseUrl}/v1/storage/upload?path=${encodeURIComponent(fileKey)}`;
        return {
          uploadUrl,
          fileKey,
          authToken: ENV.forgeApiKey,
        };
      }),

    // Process an already-uploaded file (IFC conversion, GLB optimization)
    processUploadedFile: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        specialty: z.string(),
        fileKey: z.string(),
        fileType: z.enum(["glb", "ifc", "rvt"]),
        fileSize: z.number(),
        fileUrl: z.string(),
      }))
      .mutation(async ({ input }) => {
        if (input.fileType === "rvt") {
          // RVT → IFC → GLB via Autodesk Platform Services
          console.log(`[RVT Convert] Starting RVT→IFC→GLB pipeline for ${input.specialty} (${(input.fileSize / 1024 / 1024).toFixed(1)}MB)`);

          // Download RVT from S3
          const rvtResponse = await fetch(input.fileUrl);
          if (!rvtResponse.ok) throw new Error("Failed to download RVT from storage");
          const rvtBuffer = Buffer.from(await rvtResponse.arrayBuffer());

          // Convert RVT → IFC → GLB via APS
          const { convertRVTtoGLB } = await import("./apsConvert");
          const convResult = await convertRVTtoGLB(rvtBuffer, `${input.specialty}.rvt`, (p) => {
            console.log(`[RVT Convert] ${p.step}${p.progress ? ` (${p.progress})` : ""}`);
          });

          // Optimize the GLB
          const { optimizeGLB, generateLOD } = await import("./optimizeGLB");
          let finalBuffer: Uint8Array = convResult.glbBuffer;
          if (convResult.glbBuffer.length > 50_000) {
            try {
              const opt = await optimizeGLB(convResult.glbBuffer);
              finalBuffer = opt.buffer;
            } catch (e) { /* use unoptimized */ }
          }

          // Generate LOD for large files
          let lodUrl: string | null = null;
          if (convResult.glbBuffer.length > 20 * 1024 * 1024) {
            try {
              const lod = await generateLOD(convResult.glbBuffer);
              const lodKey = `projects/${input.projectId}/${input.specialty}-lod-${nanoid(8)}.glb`;
              const lodResult = await storagePut(lodKey, lod.buffer, "model/gltf-binary");
              lodUrl = lodResult.url;
            } catch (e) { /* skip LOD */ }
          }

          // Also store the intermediate IFC for reference
          const ifcKey = `projects/${input.projectId}/${input.specialty}-converted-${nanoid(8)}.ifc`;
          await storagePut(ifcKey, convResult.ifcBuffer, "application/x-step");

          // Upload final GLB
          const glbKey = `projects/${input.projectId}/${input.specialty}-${nanoid(8)}.glb`;
          const { url } = await storagePut(glbKey, finalBuffer, "model/gltf-binary");

          console.log(`[RVT Convert] Pipeline complete: ${convResult.conversionSteps.join(" → ")}`);

          return {
            url,
            fileKey: glbKey,
            fileSize: finalBuffer.length,
            lodUrl,
            convertedFrom: "RVT",
            meshCount: convResult.meshCount,
            vertexCount: convResult.vertexCount,
            conversionSteps: convResult.conversionSteps,
          };
        }

        if (input.fileType === "ifc") {
          // IFC: download from S3, convert to GLB, re-upload optimized
          const response = await fetch(input.fileUrl);
          if (!response.ok) throw new Error("Failed to download IFC from storage");
          const buffer = Buffer.from(await response.arrayBuffer());

          const { convertIFCtoGLB } = await import("./convertIFC");
          const result = await convertIFCtoGLB(buffer);

          const { optimizeGLB, generateLOD } = await import("./optimizeGLB");
          let finalBuffer: Uint8Array = result.glbBuffer;
          if (result.glbBuffer.length > 50_000) {
            try {
              const opt = await optimizeGLB(result.glbBuffer);
              finalBuffer = opt.buffer;
            } catch (e) { /* use unoptimized */ }
          }

          let lodUrl: string | null = null;
          if (result.glbBuffer.length > 20 * 1024 * 1024) {
            try {
              const lod = await generateLOD(result.glbBuffer);
              const lodKey = `projects/${input.projectId}/${input.specialty}-lod-${nanoid(8)}.glb`;
              const lodResult = await storagePut(lodKey, lod.buffer, "model/gltf-binary");
              lodUrl = lodResult.url;
            } catch (e) { /* skip LOD */ }
          }

          const glbKey = `projects/${input.projectId}/${input.specialty}-${nanoid(8)}.glb`;
          const { url } = await storagePut(glbKey, finalBuffer, "model/gltf-binary");

          return {
            url,
            fileKey: glbKey,
            fileSize: finalBuffer.length,
            lodUrl,
            convertedFrom: "IFC",
            meshCount: result.meshCount,
            vertexCount: result.vertexCount,
          };
        }

        // GLB: download, optimize, re-upload
        const response = await fetch(input.fileUrl);
        if (!response.ok) throw new Error("Failed to download GLB from storage");
        const buffer = Buffer.from(await response.arrayBuffer());

        const { optimizeGLB, generateLOD } = await import("./optimizeGLB");
        let finalBuffer: Uint8Array | Buffer = buffer;
        if (buffer.length > 50_000) {
          try {
            const opt = await optimizeGLB(buffer);
            finalBuffer = opt.buffer;
          } catch (e) { /* use original */ }
        }

        let lodUrl: string | null = null;
        if (buffer.length > 20 * 1024 * 1024) {
          try {
            const lod = await generateLOD(buffer);
            const lodKey = `projects/${input.projectId}/${input.specialty}-lod-${nanoid(8)}.glb`;
            const lodResult = await storagePut(lodKey, lod.buffer, "model/gltf-binary");
            lodUrl = lodResult.url;
          } catch (e) { /* skip LOD */ }
        }

        const glbKey = `projects/${input.projectId}/${input.specialty}-opt-${nanoid(8)}.glb`;
        const { url } = await storagePut(glbKey, finalBuffer, "model/gltf-binary");

        return {
          url,
          fileKey: glbKey,
          fileSize: (finalBuffer as any).length || finalBuffer.length,
          lodUrl,
        };
      }),

    // Upload GLB file to S3 and register in DB
    uploadGlb: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        specialty: z.string(),
        label: z.string(),
        color: z.string(),
        transparent: z.boolean().default(false),
        opacity: z.number().default(100),
        showEdges: z.boolean().default(false),
        fileBase64: z.string(),
        fileName: z.string(),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const fileKey = `projects/${input.projectId}/${input.specialty}-${nanoid(8)}.glb`;
        const { url } = await storagePut(fileKey, buffer, "model/gltf-binary");

        await addProjectFile({
          projectId: input.projectId,
          specialty: input.specialty,
          label: input.label,
          url,
          fileKey,
          color: input.color,
          transparent: input.transparent ? 1 : 0,
          opacity: input.opacity,
          showEdges: input.showEdges ? 1 : 0,
          fileSize: buffer.length,
        });

        return { url, fileKey };
      }),

    // Update per-model transform (rotation, position, scale) for alignment
    updateFileTransform: protectedProcedure
      .input(z.object({
        fileId: z.number(),
        rotX: z.number().optional(),
        rotY: z.number().optional(),
        rotZ: z.number().optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        posZ: z.number().optional(),
        modelScale: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { fileId, ...transform } = input;
        await updateProjectFile(fileId, transform);
        return { success: true };
      }),
  }),

  // ── Storage URL (presigned on-demand) ──
  storage: router({
    getFileUrl: publicProcedure
      .input(z.object({ fileKey: z.string() }))
      .query(async ({ input }) => {
        const result = await storageGet(input.fileKey);
        return { url: result.url };
      }),
  }),

  // ── Observations (Bitácora) ──
  observation: router({
    list: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => getObservationsByProject(input.projectId)),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => getObservationById(input.id)),

    create: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        category: z.enum(["general", "estructura", "arquitectura", "instalaciones", "seguridad", "calidad"]).default("general"),
        priority: z.enum(["baja", "media", "alta", "critica"]).default("media"),
        location: z.string().optional(),
        photoUrl: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const id = await createObservation({
          projectId: input.projectId,
          userId: ctx.user.id,
          title: input.title,
          description: input.description ?? null,
          category: input.category,
          priority: input.priority,
          location: input.location ?? null,
          photoUrl: input.photoUrl ?? null,
        });
        return { id };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["abierta", "en_revision", "resuelta", "cerrada"]).optional(),
        priority: z.enum(["baja", "media", "alta", "critica"]).optional(),
        description: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateObservation(id, data);
        return { success: true };
      }),
  }),

  // ── Chat ──
  chat: router({
    list: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        observationId: z.number().optional(),
        rfiId: z.number().optional(),
      }))
      .query(async ({ input }) => getChatMessages(input.projectId, {
        observationId: input.observationId,
        rfiId: input.rfiId,
      })),

    send: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        observationId: z.number().optional(),
        rfiId: z.number().optional(),
        message: z.string().min(1),
        imageUrl: z.string().optional(),
        mentions: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const id = await createChatMessage({
          projectId: input.projectId,
          observationId: input.observationId ?? null,
          rfiId: input.rfiId ?? null,
          userId: ctx.user.id,
          message: input.message,
          imageUrl: input.imageUrl ?? null,
          mentions: input.mentions ?? null,
        });
        // Notify owner on new chat messages
        const context = input.rfiId ? `RFI #${input.rfiId}` : input.observationId ? `Observaci\u00f3n #${input.observationId}` : "Chat general";
        notifyOwner({
          title: `\uD83D\uDCAC Nuevo mensaje en ${context}`,
          content: `${ctx.user.name || "Usuario"}: ${input.message.substring(0, 200)}`,
        }).catch(() => {});
        return { id };
      }),

    uploadImage: protectedProcedure
      .input(z.object({
        fileBase64: z.string(),
        fileName: z.string(),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.fileName.split(".").pop() || "jpg";
        const fileKey = `chat-images/${nanoid(12)}.${ext}`;
        const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        const { url } = await storagePut(fileKey, buffer, mime);
        return { url };
      }),
  }),

  // ── RFI ──
  rfi: router({
    list: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => getRfisByProject(input.projectId)),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const rfi = await getRfiById(input.id);
        if (!rfi) return null;
        const attachments = await getRfiAttachments(input.id);
        return { ...rfi, attachments };
      }),

    create: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        subject: z.string().min(1).max(500),
        description: z.string().optional(),
        category: z.enum(["diseno", "estructura", "instalaciones", "arquitectura", "coordinacion", "otro"]).default("otro"),
        priority: z.enum(["baja", "media", "alta", "urgente"]).default("media"),
        assignedToUserId: z.number().optional(),
        dueDate: z.date().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const number = await getNextRfiNumber(input.projectId);
        const id = await createRfi({
          projectId: input.projectId,
          createdByUserId: ctx.user.id,
          assignedToUserId: input.assignedToUserId ?? null,
          number,
          subject: input.subject,
          description: input.description ?? null,
          category: input.category,
          priority: input.priority,
          status: "borrador",
          dueDate: input.dueDate ?? null,
        });
        return { id, number };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["borrador", "enviada", "en_revision", "respondida", "cerrada"]).optional(),
        response: z.string().optional(),
        priority: z.enum(["baja", "media", "alta", "urgente"]).optional(),
        assignedToUserId: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        if (data.response) {
          (data as any).respondedByUserId = ctx.user.id;
          (data as any).respondedAt = new Date();
        }
        await updateRfi(id, data);
        // Notify owner on RFI status changes
        if (data.status) {
          notifyOwner({
            title: `\uD83D\uDCCB RFI #${id} actualizada`,
            content: `${ctx.user.name || "Usuario"} cambi\u00f3 estado a: ${data.status}${data.response ? " con respuesta" : ""}`,
          }).catch(() => {});
        }
        return { success: true };
      }),

    addAttachment: protectedProcedure
      .input(z.object({
        rfiId: z.number(),
        fileBase64: z.string(),
        fileName: z.string(),
        markupBase64: z.string().optional(),
        caption: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const ext = input.fileName.split(".").pop() || "jpg";
        const fileKey = `rfi-attachments/${input.rfiId}/${nanoid(8)}.${ext}`;
        const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        const { url: imageUrl } = await storagePut(fileKey, buffer, mime);

        let markupUrl: string | null = null;
        if (input.markupBase64) {
          const markupBuffer = Buffer.from(input.markupBase64, "base64");
          const markupKey = `rfi-attachments/${input.rfiId}/markup-${nanoid(8)}.png`;
          const result = await storagePut(markupKey, markupBuffer, "image/png");
          markupUrl = result.url;
        }

        const id = await addRfiAttachment({
          rfiId: input.rfiId,
          userId: ctx.user.id,
          imageUrl,
          markupUrl,
          caption: input.caption ?? null,
        });
        return { id, imageUrl, markupUrl };
      }),

    getAttachments: protectedProcedure
      .input(z.object({ rfiId: z.number() }))
      .query(async ({ input }) => getRfiAttachments(input.rfiId)),
  }),

  // ── Report ──
  report: router({
    getData: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => {
        const project = await getProjectById(input.projectId);
        if (!project) return null;
        const files = await getProjectFiles(input.projectId);
        const obs = await getObservationsByProject(input.projectId);
        const rfis = await getRfisByProject(input.projectId);
        const users = await getAllUsers();
        // Get attachments for each RFI
        const rfisWithAttachments = await Promise.all(
          rfis.map(async (r: any) => {
            const attachments = await getRfiAttachments(r.id);
            return { ...r, attachments };
          })
        );
        return { project, files, observations: obs, rfis: rfisWithAttachments, users };
      }),
  }),

  // ── Users (for mentions / assignment) ──
  users: router({
    list: protectedProcedure.query(async () => getAllUsers()),
  }),

  // ── Inspection Marks (Avance persistence) ──
  inspectionMarks: router({
    get: protectedProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => getInspectionMarks(input.projectId)),

    save: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        marks: z.array(z.object({
          fileId: z.number(),
          meshName: z.string(),
          meshIndex: z.number(),
        })),
      }))
      .mutation(async ({ input, ctx }) => {
        const count = await bulkSaveInspectionMarks(input.projectId, ctx.user.id, input.marks);
        return { saved: count };
      }),
  }),

  // ── Annotations 3D (persisted model annotations with categories) ──
  annotations3d: router({
    list: publicProcedure
      .input(z.object({ projectId: z.number() }))
      .query(async ({ input }) => getAnnotations3d(input.projectId)),

    create: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        text: z.string().min(1),
        category: z.enum(["observacion", "defecto", "aprobado", "informativo"]).default("observacion"),
        floorLabel: z.string().optional(),
        posX: z.number(),
        posY: z.number(),
        posZ: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const id = await createAnnotation3d({
          projectId: input.projectId,
          userId: ctx.user.id,
          text: input.text,
          category: input.category,
          floorLabel: input.floorLabel ?? null,
          posX: input.posX,
          posY: input.posY,
          posZ: input.posZ,
        });
        return { id };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        text: z.string().optional(),
        category: z.enum(["observacion", "defecto", "aprobado", "informativo"]).optional(),
        resolved: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const data: Record<string, unknown> = {};
        if (input.text !== undefined) data.text = input.text;
        if (input.category !== undefined) data.category = input.category;
        if (input.resolved !== undefined) data.resolved = input.resolved ? 1 : 0;
        await updateAnnotation3d(input.id, data as any);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteAnnotation3d(input.id);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
