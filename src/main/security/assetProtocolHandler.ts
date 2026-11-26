import fs from "node:fs";
import path from "node:path";
import { protocol } from "electron";
import { evaluateAssetProtocolRequest } from "./assetProtocolCore.js";

export * from "./assetProtocolCore.js";

/**
 * Must be called synchronously BEFORE Electron app 'ready'.
 */
export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "mf-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function setupAssetProtocolHandler(
  previewSession: Electron.Session,
  activeSessionId: string,
  sessionRootDir: string,
  allowedEntrySegments: string[]
): void {
  const canonicalSessionRoot = fs.realpathSync(path.resolve(sessionRootDir));
  const expectedEntryPath = "/" + allowedEntrySegments.join("/");

  previewSession.protocol.handle("mf-asset", async (request) => {
    try {
      const reqWithOrigin = request as Request & { initiatorOrigin?: string | null };
      return await evaluateAssetProtocolRequest(
        {
          method: request.method,
          url: request.url,
          initiatorOrigin: reqWithOrigin.initiatorOrigin,
          rangeHeader: request.headers.get("Range"),
        },
        activeSessionId,
        canonicalSessionRoot,
        expectedEntryPath
      );
    } catch (err) {
      console.error("[SECURITY] Protocol handler error:", err);
      return new Response("Internal Security Error", { status: 500 });
    }
  });
}
