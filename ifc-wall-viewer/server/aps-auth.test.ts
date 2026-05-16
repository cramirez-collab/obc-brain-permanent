import { describe, it, expect } from "vitest";

describe("Autodesk APS Authentication", () => {
  it("should obtain an OAuth2 token with the provided credentials", async () => {
    const clientId = process.env.APS_CLIENT_ID;
    const clientSecret = process.env.APS_CLIENT_SECRET;

    expect(clientId).toBeTruthy();
    expect(clientSecret).toBeTruthy();

    const response = await fetch("https://developer.api.autodesk.com/authentication/v2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        grant_type: "client_credentials",
        scope: "data:read data:write data:create bucket:read bucket:create",
      }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.access_token).toBeTruthy();
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBeGreaterThan(0);
  });
});
