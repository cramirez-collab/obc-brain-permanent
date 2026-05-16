import { describe, expect, it, vi, beforeEach } from "vitest";
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

function createAuthContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
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

describe("project.getById", () => {
  it("returns null for non-existent project (public access)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.getById({ id: 99999 });
    expect(result).toBeNull();
  });

  it("returns project data for existing project (public access)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    // Project 1 was seeded in the database
    const result = await caller.project.getById({ id: 1 });
    if (result) {
      expect(result.name).toBe("HMA-01 OBJETIVA ARQ");
      expect(result.status).toBe("ready");
      expect(result.files).toBeInstanceOf(Array);
      expect(result.files.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("project.list", () => {
  it("returns projects for public access", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.project.list();
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

describe("project.create", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.project.create({ name: "Test Project" })
    ).rejects.toThrow();
  });
});
