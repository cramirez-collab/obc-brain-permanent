import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(userId = 1): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: `test-user-${userId}`,
    email: `test${userId}@example.com`,
    name: `Test User ${userId}`,
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("inspectionMarks", () => {
  describe("inspectionMarks.get", () => {
    it("requires authentication", async () => {
      const ctx = createPublicContext();
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.inspectionMarks.get({ projectId: 1 })
      ).rejects.toThrow();
    });

    it("returns empty array for project with no marks", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);

      const result = await caller.inspectionMarks.get({ projectId: 99999 });
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(0);
    });

    it("returns marks for project with existing marks", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);

      // First save some marks
      await caller.inspectionMarks.save({
        projectId: 1,
        marks: [
          { fileId: 1, meshName: "wall_001", meshIndex: 0 },
          { fileId: 1, meshName: "wall_002", meshIndex: 1 },
          { fileId: 2, meshName: "pipe_001", meshIndex: 0 },
        ],
      });

      // Then retrieve them
      const result = await caller.inspectionMarks.get({ projectId: 1 });
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(3);
      expect(result[0]).toHaveProperty("meshName");
      expect(result[0]).toHaveProperty("fileId");
      expect(result[0]).toHaveProperty("meshIndex");
      expect(result[0]).toHaveProperty("projectId");
    });
  });

  describe("inspectionMarks.save", () => {
    it("requires authentication", async () => {
      const ctx = createPublicContext();
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.inspectionMarks.save({
          projectId: 1,
          marks: [{ fileId: 1, meshName: "test", meshIndex: 0 }],
        })
      ).rejects.toThrow();
    });

    it("saves marks and returns count", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);

      const result = await caller.inspectionMarks.save({
        projectId: 1,
        marks: [
          { fileId: 1, meshName: "wall_001", meshIndex: 0 },
          { fileId: 1, meshName: "wall_002", meshIndex: 1 },
        ],
      });

      expect(result).toEqual({ saved: 2 });
    });

    it("replaces previous marks on re-save (bulk sync)", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);

      // Save initial marks
      await caller.inspectionMarks.save({
        projectId: 1,
        marks: [
          { fileId: 1, meshName: "wall_001", meshIndex: 0 },
          { fileId: 1, meshName: "wall_002", meshIndex: 1 },
          { fileId: 2, meshName: "pipe_001", meshIndex: 0 },
        ],
      });

      // Re-save with different marks (should replace, not append)
      await caller.inspectionMarks.save({
        projectId: 1,
        marks: [
          { fileId: 1, meshName: "wall_003", meshIndex: 2 },
        ],
      });

      const result = await caller.inspectionMarks.get({ projectId: 1 });
      expect(result.length).toBe(1);
      expect(result[0]!.meshName).toBe("wall_003");
    });

    it("can save empty marks array (clear all)", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);

      // Save some marks first
      await caller.inspectionMarks.save({
        projectId: 1,
        marks: [
          { fileId: 1, meshName: "wall_001", meshIndex: 0 },
        ],
      });

      // Clear all marks
      const result = await caller.inspectionMarks.save({
        projectId: 1,
        marks: [],
      });

      expect(result).toEqual({ saved: 0 });

      // Verify cleared
      const marks = await caller.inspectionMarks.get({ projectId: 1 });
      expect(marks.length).toBe(0);
    });
  });
});
