import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";

import {
  DESIGN_BROWSER_PARTITION,
  createDesignBrowserCdpController,
  redactBrowserBody,
  redactBrowserHeaders,
  redactBrowserUrl,
} from "../../src/main/browser-cdp.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../..");

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params?: unknown }> = [];
  screenshotData = "";

  attach = vi.fn(() => {
    this.attached = true;
  });

  detach = vi.fn(() => {
    this.attached = false;
    this.emit("detach", {}, "target closed");
  });

  isAttached = vi.fn(() => this.attached);

  sendCommand = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    this.commands.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "DOM.getDocument") {
      return {
        root: {
          attributes: [],
          backendNodeId: 1,
          childNodeCount: 0,
          localName: "html",
          nodeId: 1,
          nodeName: "HTML",
          nodeType: 1,
          nodeValue: "",
        },
      };
    }
    if (method === "Network.getResponseBody") {
      return { body: '{"token":"secret","safe":"ok"}', base64Encoded: false };
    }
    if (method === "Page.captureScreenshot") {
      return { data: this.screenshotData };
    }
    return {};
  });
}

class FakeGuest extends EventEmitter {
  debugger = new FakeDebugger();
  id = 42;
  destroyed = false;
  session = {
    getPartition: () => DESIGN_BROWSER_PARTITION,
  };

  getTitle(): string {
    return "Example";
  }

  getType(): string {
    return "webview";
  }

  getURL(): string {
    return "https://example.com/";
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

describe("Design Browser CDP controller", () => {
  it("redacts sensitive headers and structured body fields", () => {
    expect(redactBrowserHeaders({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Content-Type": "application/json",
      "X-API-Key": "private",
      "Set-Cookie": "session=secret",
    })).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "Content-Type": "application/json",
      "X-API-Key": "[redacted]",
      "Set-Cookie": "[redacted]",
    });
    expect(redactBrowserBody(
      '{"profile":{"password":"secret","name":"Ada"},"accessToken":"secret"}',
      "application/json",
    )).toBe('{"profile":{"password":"[redacted]","name":"Ada"},"accessToken":"[redacted]"}');
    expect(redactBrowserBody(
      "email=ada%40example.com&password=secret",
      "application/x-www-form-urlencoded",
    )).toBe("email=ada%40example.com&password=%5Bredacted%5D");
  });

  it("redacts URL credentials and sensitive query parameters", () => {
    const redactedUrl = redactBrowserUrl(
      "https://alice:private@example.com/api?token=private&safe=value",
    );
    expect(redactedUrl).not.toContain("alice");
    expect(redactedUrl).not.toContain("private");
    expect(redactedUrl).toContain("safe=value");
    expect(redactBrowserBody(
      "api_key=private client_secret=private access_key=private",
      "text/plain",
    )).toBe(
      "api_key=[redacted] client_secret=[redacted] access_key=[redacted]",
    );
  });

  it("attaches approved guests, enables bounded domains, and requires approved mutations", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);

    await controller.attachGuest(guest as unknown as WebContents);
    expect(guest.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(guest.debugger.commands.map(({ method }) => method)).toEqual(expect.arrayContaining([
      "Page.enable",
      "Runtime.enable",
      "DOM.enable",
      "Network.enable",
      "Log.enable",
    ]));

    expect(controller.registerTarget({
      projectId: "project-1",
      tabId: "tab-1",
      url: "https://example.com/",
      webContentsId: 42,
    })).toMatchObject({ ok: true, target: { attached: true, tabId: "tab-1" } });

    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "snapshot", depth: 2 },
    })).resolves.toMatchObject({
      ok: true,
      operation: "snapshot",
      value: { document: { nodeName: "HTML" } },
    });
    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "navigate", url: "https://example.org/" },
    })).resolves.toEqual({
      ok: false,
      reason: "invalid or unapproved browser operation",
    });
    await expect(controller.execute({
      tabId: "tab-1",
      operation: { approved: true, kind: "navigate", url: "file:///etc/passwd" },
    })).resolves.toEqual({
      ok: false,
      reason: "invalid or unapproved browser operation",
    });

    guest.destroyed = true;
    guest.emit("destroyed");
    expect(controller.listTargets()).toEqual({ ok: true, targets: [] });
  });

  it("waits for the requested navigation readiness event", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({
      projectId: "project-1",
      tabId: "tab-1",
      url: "https://example.com/",
      webContentsId: 42,
    });

    let settled = false;
    const navigating = controller.execute({
      tabId: "tab-1",
      operation: {
        approved: true,
        kind: "navigate",
        url: "https://example.com/next",
        waitUntil: "networkidle",
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    guest.emit("did-stop-loading");
    await expect(navigating).resolves.toMatchObject({
      ok: true,
      operation: "navigate",
      value: { url: "https://example.com/next" },
    });
  });

  it("retains redacted network evidence and failure details", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({
      projectId: "project-1",
      tabId: "tab-1",
      url: "https://example.com/",
      webContentsId: 42,
    });

    guest.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "request-1",
      request: {
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        method: "POST",
        postData: '{"password":"secret","safe":"value"}',
        url: "https://example.com/api",
      },
      timestamp: 1,
      type: "Fetch",
    });
    guest.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "request-1",
      response: {
        headers: { "Set-Cookie": "session=secret", "Content-Type": "application/json" },
        status: 500,
        statusText: "Server Error",
      },
    });
    guest.debugger.emit("message", {}, "Network.loadingFinished", {
      requestId: "request-1",
      timestamp: 2,
    });
    await Promise.resolve();

    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "network", limit: 10 },
    })).resolves.toMatchObject({
      ok: true,
      operation: "network",
      value: {
        requests: [{
          requestBody: '{"password":"[redacted]","safe":"value"}',
          requestHeaders: { Authorization: "[redacted]" },
          responseBody: '{"token":"[redacted]","safe":"ok"}',
          responseHeaders: { "Set-Cookie": "[redacted]" },
        }],
      },
    });
    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "network", resourceType: "Document" },
    })).resolves.toMatchObject({
      ok: true,
      value: { requests: [] },
    });
    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "network", requestId: "request-1" },
    })).resolves.toMatchObject({
      ok: true,
      value: { requests: [{ requestId: "request-1", resourceType: "Fetch" }] },
    });
  });

  it("rejects screenshots that cannot fit through the bounded daemon JSON channel", async () => {
    const guest = new FakeGuest();
    guest.debugger.screenshotData = "A".repeat(3 * 1024 * 1024);
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({
      projectId: "project-1",
      tabId: "tab-1",
      url: "https://example.com/",
      webContentsId: 42,
    });

    await expect(controller.execute({
      tabId: "tab-1",
      operation: { kind: "screenshot" },
    })).resolves.toEqual({
      ok: false,
      reason: "browser screenshot exceeds the 3 MiB command result limit",
    });
  });

  it("keeps the runtime on Electron debugger IPC without a remote debugging port", () => {
    const runtime = readFileSync(join(desktopRoot, "src/main/runtime.ts"), "utf8");
    const cdp = readFileSync(join(desktopRoot, "src/main/browser-cdp.ts"), "utf8");
    const preload = readFileSync(join(desktopRoot, "src/main/preload.cts"), "utf8");

    expect(runtime).toContain('window.webContents.on("did-attach-webview"');
    expect(runtime).toContain("browserCdp.attachGuest(guestWebContents)");
    expect(runtime).toContain("requireMainWindowSender(event)");
    expect(runtime).toContain("Allow the agent to control this browser tab?");
    expect(runtime).toContain("browser command expired before execution");
    expect(cdp).toContain('guest.debugger.attach("1.3")');
    expect(cdp).toContain('guest.getType() === "webview"');
    expect(cdp).toContain("guest.session === designBrowserSession");
    expect(cdp).not.toContain("--remote-debugging-port");
    expect(runtime).not.toContain("--remote-debugging-port");
    expect(preload).toContain("'browser:register-target'");
    expect(preload).toContain("'browser:unregister-target'");
    expect(preload).toContain("'browser:list-targets'");
    expect(preload).toContain("'browser:execute'");
  });
});
