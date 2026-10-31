import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";

import {
  DESIGN_BROWSER_PARTITION,
  createDesignBrowserCdpController,
  executeDesignBrowserRequest,
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
  evaluateResult: unknown = { result: { type: "string", value: "Example" } };
  querySelectorNodeId = 0;
  responses: Record<string, unknown> = {};

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
    if (method in this.responses) return this.responses[method];
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
    if (method === "Runtime.evaluate") return this.evaluateResult;
    if (method === "DOM.querySelector") return { nodeId: this.querySelectorNodeId };
    if (method === "DOM.describeNode") {
      return {
        node: {
          attributes: ["id", "app"],
          backendNodeId: 7,
          children: [{ backendNodeId: 8, localName: "span", nodeId: 8, nodeName: "SPAN", nodeType: 1, nodeValue: "" }],
          localName: "main",
          nodeId: 7,
          nodeName: "MAIN",
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
  it("denies capture CPU changes by default even with renderer approved=true", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "project", tabId: "tab", webContentsId: guest.id, url: guest.getURL() });
    try {
      expect(await controller.execute({ tabId: "tab", operation: { kind: "devtools", action: "capture-throttle", approved: true,
        params: { nativeApprovalId: "forged", reportId: "report", cpu: 2 } } })).toMatchObject({ ok: false, reason: expect.stringContaining("native confirmation") });
      expect(guest.debugger.commands.some((command) => command.method === "Emulation.setCPUThrottlingRate")).toBe(false);
    } finally { controller.close(); }
  });

  it("invalidates a native CPU grant when the same guest navigates away and back", async () => {
    const guest = new FakeGuest();
    guest.debugger.evaluateResult = { result: { value: { visible: true, timeOriginMs: 100, observerAvailable: true, shifts: [], loaf: [], animations: [] } } };
    let confirmedGeneration: unknown;
    let probing = true;
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session, (request) => {
      const generation = (request as unknown as { navigationGeneration?: number }).navigationGeneration;
      if (probing) { confirmedGeneration = generation; return false; }
      return generation === confirmedGeneration;
    });
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "project", tabId: "tab", webContentsId: guest.id, url: guest.getURL() });
    try {
      const started = await controller.execute({ tabId: "tab", operation: { kind: "devtools", action: "render-start", params: {} } });
      const reportId = ((started as { value: { result: { reportId: string } } }).value.result).reportId;
      const request = { tabId: "tab", operation: { kind: "devtools", action: "capture-throttle", approved: true, params: { nativeApprovalId: "approval", reportId, cpu: 4 } } };
      expect(await controller.execute(request)).toMatchObject({ ok: false });
      probing = false;
      guest.emit("did-start-navigation", {}, "https://example.com/other", false, true);
      guest.emit("did-start-navigation", {}, guest.getURL(), false, true);
      expect(await controller.execute(request)).toMatchObject({ ok: false, reason: expect.stringContaining("native confirmation") });
      expect(guest.debugger.commands.some((command) => command.method === "Emulation.setCPUThrottlingRate")).toBe(false);
    } finally { controller.close(); }
  });

  it.each(["host-hidden", "observer-lost"])("reports %s without confusing host visibility and missing observer evidence", async (cause) => {
    const guest = new FakeGuest();
    guest.debugger.evaluateResult = { result: { value: { visible: true, timeOriginMs: 100, observerAvailable: true, inputSupported: true, inputs: [], shifts: [], loaf: [], animations: [] } } };
    guest.debugger.responses["Profiler.stop"] = { profile: { startTime: 0, nodes: [], samples: [], timeDeltas: [] } };
    const originalSend = guest.debugger.sendCommand;
    guest.debugger.sendCommand = vi.fn(async (method, params) => {
      const result = await originalSend(method, params);
      if (method === "Tracing.end") guest.debugger.emit("message", {}, "Tracing.tracingComplete", {});
      return result;
    });
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    const registration = { projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id };
    const run = (action: string) => controller.execute({ tabId: "tab-1", operation: { kind: "devtools", action, params: {} } });
    try {
      controller.registerTarget({ ...registration, active: true });
      expect((await run("render-start")).ok).toBe(true);
      guest.debugger.emit("message", {}, "Tracing.dataCollected", { value: [
        { name: "thread_name", ph: "M", pid: 1, tid: 1, args: { name: "CrRendererMain" } },
        { name: "RunTask", ph: "X", pid: 1, tid: 1, ts: 1_000, dur: 5_000 },
      ] });
      if (cause === "host-hidden") {
        controller.registerTarget({ ...registration, active: false });
        controller.registerTarget({ ...registration, active: true });
      } else {
        guest.debugger.evaluateResult = { result: { value: { observerAvailable: false, shifts: [], loaf: [], animations: [] } } };
      }
      expect(await run("render-stop")).toMatchObject({ ok: true, value: { result: { performanceReport: {
        completeness: "partial", coverage: { reasons: cause === "host-hidden"
          ? expect.arrayContaining(["target-hidden"])
          : expect.not.arrayContaining(["target-hidden"]) },
      } } } });
    } finally { controller.close(); }
  });

  it("executes fresh approved commands on the registered guest without another approval step", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.commands.length = 0;

    await expect(executeDesignBrowserRequest(controller, {
      tabId: "tab-1", expiresAt: Date.now() + 10_000,
      operation: { kind: "scroll", deltaY: 100, approved: true },
    })).resolves.toMatchObject({ ok: true, operation: "scroll" });
    expect(guest.debugger.commands).toEqual([{
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY: 100 },
    }]);

    guest.debugger.commands.length = 0;
    await expect(executeDesignBrowserRequest(controller, {
      tabId: "tab-1", expiresAt: Date.now() + 10_000,
      operation: { kind: "scroll", deltaY: 100 },
    })).resolves.toMatchObject({ ok: false, reason: "invalid or unapproved browser operation" });
    await expect(executeDesignBrowserRequest(controller, {
      tabId: "unknown-tab", expiresAt: Date.now() + 10_000,
      operation: { kind: "scroll", deltaY: 100, approved: true },
    })).resolves.toMatchObject({ ok: false });
    expect(guest.debugger.commands).toEqual([]);
    controller.close();
  });

  it.each(["click", "type", "scroll", "navigate", "evaluate"])("rejects missing, invalid and expired %s deadlines before execution", async (kind) => {
    const execute = vi.fn();
    for (const expiresAt of [undefined, NaN, Infinity, "tomorrow", Date.now() - 1]) {
      await expect(executeDesignBrowserRequest({ execute }, {
        tabId: "tab-1", expiresAt, operation: { kind, approved: true },
      })).resolves.toEqual({ ok: false, reason: "browser command expired before execution" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps read-only inspection available without mutation approval or a deadline", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    await expect(executeDesignBrowserRequest(controller, {
      tabId: "tab-1", operation: { kind: "snapshot", depth: 2 },
    })).resolves.toMatchObject({ ok: true, operation: "snapshot" });
    controller.close();
  });
  it("requires explicit main-process provenance for native popup targets sharing the browser session", async () => {
    const guest = new FakeGuest();
    vi.spyOn(guest, 'getType').mockReturnValue('window');
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await expect(controller.attachGuest(guest as unknown as WebContents)).rejects.toThrow('not approved');
    expect(controller.registerTarget({ projectId: 'p1', tabId: '__browser__:2', url: guest.getURL(), webContentsId: guest.id })).toMatchObject({ ok: false });
    await controller.attachPopup(guest as unknown as WebContents);
    expect(controller.registerTarget({ projectId: 'p1', tabId: '__browser__:2', url: guest.getURL(), webContentsId: guest.id })).toMatchObject({ ok: true });
    expect(controller.listTargets()).toMatchObject({ ok: true, targets: [{ tabId: '__browser__:2' }] });
    controller.close();
    expect(controller.listTargets()).toEqual({ ok: true, targets: [] });
  });
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

  it("redacts OAuth callback query values from captured network URLs and redirect headers", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });

    const callback = "https://example.com/callback?code=synthetic_code&state=synthetic_state&view=compact&postcode=123";
    guest.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "oauth-callback",
      request: { headers: { Referer: callback }, method: "GET", url: callback },
      timestamp: 1,
      type: "Document",
    });
    guest.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "oauth-callback",
      response: { headers: { Location: callback }, status: 302, statusText: "Found" },
    });

    const result = await controller.execute({ tabId: "tab-1", operation: { kind: "network", requestId: "oauth-callback" } });
    const safeCallback = "https://example.com/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&view=compact&postcode=123";
    expect(result).toMatchObject({
      ok: true,
      value: { requests: [{ url: safeCallback, requestHeaders: { Referer: safeCallback }, responseHeaders: { Location: safeCallback } }] },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("synthetic_code");
    expect(serialized).not.toContain("synthetic_state");
    expect(serialized).toContain("view=compact");
    expect(serialized).toContain("postcode=123");
    controller.close();
  });

  it("redacts callback values in relative URLs and fragments without changing other fields", () => {
    expect(redactBrowserUrl("/callback?Code=synthetic_code&STATE=synthetic_state&view=compact"))
      .toBe("/callback?Code=[redacted]&STATE=[redacted]&view=compact");
    expect(redactBrowserUrl("https://example.com/#code=synthetic_code&state=synthetic_state&view=compact"))
      .toBe("https://example.com/#code=[redacted]&state=[redacted]&view=compact");
    expect(redactBrowserUrl("https://example.com/#%63ode=synthetic_code&%73tate=synthetic_state&view=compact"))
      .toBe("https://example.com/#%63ode=[redacted]&%73tate=[redacted]&view=compact");
    expect(redactBrowserUrl("https://example.com/#access_token=synthetic_access&%74oken=synthetic_token&state=synthetic_state&view=compact"))
      .toBe("https://example.com/#access_token=[redacted]&%74oken=[redacted]&state=[redacted]&view=compact");
  });

  it("redacts OAuth values in captured plain and malformed JSON bodies", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.responses["Network.getResponseBody"] = {
      body: '{"code":"synthetic_code","state":"synthetic_state","view":"compact"',
      base64Encoded: false,
    };
    guest.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "oauth-plain",
      request: {
        headers: { "Content-Type": "text/plain" },
        method: "POST",
        postData: "code=synthetic_code&state=synthetic_state&view=compact",
        url: "https://example.com/token",
      },
      type: "Fetch",
    });
    guest.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "oauth-plain",
      response: { headers: { "Content-Type": "application/json" }, status: 200 },
    });
    guest.debugger.emit("message", {}, "Network.loadingFinished", { requestId: "oauth-plain" });
    await Promise.resolve();

    const result = await controller.execute({ tabId: "tab-1", operation: { kind: "network", requestId: "oauth-plain" } });
    expect(result).toMatchObject({
      ok: true,
      value: { requests: [{
        requestBody: "code=[redacted]&state=[redacted]&view=compact",
        responseBody: '{"code":"[redacted]","state":"[redacted]","view":"compact"',
      }] },
    });
    expect(JSON.stringify(result)).not.toMatch(/synthetic_(?:code|state)/);
    controller.close();
  });

  it("redacts OAuth values from captured form requests and JSON responses", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.responses["Network.getResponseBody"] = {
      body: '{"code":"synthetic_code","nested":{"state":"synthetic_state"},"view":"compact","postcode":"123"}',
      base64Encoded: false,
    };
    guest.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "oauth-token",
      request: {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        postData: "code=synthetic_code&state=synthetic_state&view=compact&postcode=123",
        url: "https://example.com/token",
      },
      type: "Fetch",
    });
    guest.debugger.emit("message", {}, "Network.responseReceived", {
      requestId: "oauth-token",
      response: { headers: { "Content-Type": "application/json" }, status: 200 },
    });
    guest.debugger.emit("message", {}, "Network.loadingFinished", { requestId: "oauth-token" });
    await Promise.resolve();

    const result = await controller.execute({ tabId: "tab-1", operation: { kind: "network", requestId: "oauth-token" } });
    expect(result).toMatchObject({
      ok: true,
      value: { requests: [{
        requestBody: "code=%5Bredacted%5D&state=%5Bredacted%5D&view=compact&postcode=123",
        responseBody: '{"code":"[redacted]","nested":{"state":"[redacted]"},"view":"compact","postcode":"123"}',
      }] },
    });
    expect(JSON.stringify(result)).not.toMatch(/synthetic_(?:code|state)/);
    controller.close();
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

  it("walks the DOM deeper than the old 8-level cap and roots a snapshot at a selector", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.commands.length = 0;

    await controller.execute({ tabId: "tab-1", operation: { kind: "snapshot" } });
    await controller.execute({ tabId: "tab-1", operation: { kind: "snapshot", depth: 40 } });
    await controller.execute({ tabId: "tab-1", operation: { kind: "snapshot", depth: 999 } });
    expect(guest.debugger.commands.map((command) => command.params)).toEqual([
      { depth: 12, pierce: true },
      { depth: 40, pierce: true },
      { depth: 64, pierce: true },
    ]);

    await expect(controller.execute({ tabId: "tab-1", operation: { kind: "snapshot", selector: "#missing" } }))
      .resolves.toEqual({ ok: true, operation: "snapshot", tabId: "tab-1", value: null });
    guest.debugger.querySelectorNodeId = 7;
    guest.debugger.commands.length = 0;
    const subtree = await controller.execute({ tabId: "tab-1", operation: { kind: "snapshot", selector: "#app", depth: 20 } });
    expect(guest.debugger.commands.at(-1)).toEqual({ method: "DOM.describeNode", params: { depth: 20, nodeId: 7, pierce: true } });
    expect(subtree).toMatchObject({
      ok: true,
      value: { document: { nodeName: "MAIN", children: [{ nodeName: "SPAN" }] }, truncated: false },
    });
    controller.close();
  });

  it("runs approved scripts in the page and returns their JSON value or exception", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.commands.length = 0;
    const run = (operation: Record<string, unknown>) =>
      executeDesignBrowserRequest(controller, { tabId: "tab-1", expiresAt: Date.now() + 10_000, operation });

    await expect(run({ kind: "evaluate", approved: true, expression: "document.title" })).resolves.toEqual({
      ok: true, operation: "evaluate", tabId: "tab-1", value: { truncated: false, type: "string", value: "Example" },
    });
    expect(guest.debugger.commands).toEqual([{
      method: "Runtime.evaluate",
      params: { awaitPromise: true, expression: "document.title", returnByValue: true, userGesture: true },
    }]);

    guest.debugger.evaluateResult = { result: { type: "object", subtype: "null", value: null } };
    await expect(run({ kind: "evaluate", approved: true, expression: "null" }))
      .resolves.toMatchObject({ ok: true, value: { type: "null", value: null } });
    guest.debugger.evaluateResult = { result: { type: "number", unserializableValue: "NaN", description: "NaN" } };
    await expect(run({ kind: "evaluate", approved: true, expression: "NaN" }))
      .resolves.toMatchObject({ ok: true, value: { type: "number", value: "NaN" } });
    guest.debugger.evaluateResult = { result: { type: "string", value: "x".repeat(300 * 1024) } };
    await expect(run({ kind: "evaluate", approved: true, expression: "big" }))
      .resolves.toMatchObject({ ok: true, value: { truncated: true } });
    guest.debugger.evaluateResult = {
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
    };
    await expect(run({ kind: "evaluate", approved: true, expression: "nope" }))
      .resolves.toEqual({ ok: false, reason: "ReferenceError: nope is not defined" });

    guest.debugger.commands.length = 0;
    for (const operation of [
      { kind: "evaluate", expression: "document.title" },
      { kind: "evaluate", approved: true, expression: "   " },
      { kind: "evaluate", approved: true, expression: "x".repeat(100_001) },
    ]) {
      await expect(run(operation)).resolves.toMatchObject({ ok: false, reason: "invalid or unapproved browser operation" });
    }
    expect(guest.debugger.commands).toEqual([]);
    controller.close();
  });

  it("runs devtools actions: reads freely, mutations need approval, a deadline, and valid params", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.commands.length = 0;
    const run = (operation: Record<string, unknown>, expiresAt: number | undefined = Date.now() + 10_000) =>
      executeDesignBrowserRequest(controller, { tabId: "tab-1", ...(expiresAt === undefined ? {} : { expiresAt }), operation });

    // A read needs neither approval nor a deadline.
    await expect(run({ kind: "devtools", action: "status", params: {} }, undefined)).resolves.toMatchObject({
      ok: true, operation: "devtools", value: { action: "status", result: { throttle: null, emulation: null } },
    });

    // A mutation without approval, past its deadline, with bad params, or unknown never reaches CDP.
    await expect(run({ kind: "devtools", action: "throttle", params: { cpu: 4 } }))
      .resolves.toMatchObject({ ok: false, reason: "invalid or unapproved browser operation" });
    await expect(run({ kind: "devtools", action: "throttle", approved: true, params: { cpu: 4 } }, Date.now() - 1))
      .resolves.toEqual({ ok: false, reason: "browser command expired before execution" });
    await expect(run({ kind: "devtools", action: "throttle", approved: true, params: { cpu: 99 } }))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("cpu must be") });
    await expect(run({ kind: "devtools", action: "raw-cdp", approved: true, params: {} }))
      .resolves.toMatchObject({ ok: false, reason: "invalid or unapproved browser operation" });
    expect(guest.debugger.commands).toEqual([]);

    await expect(run({ kind: "devtools", action: "throttle", approved: true, params: { cpu: 4, network: "slow-3g" } }))
      .resolves.toMatchObject({ ok: true, value: { result: { throttle: { cpu: 4, network: "slow-3g" } } } });
    expect(guest.debugger.commands).toEqual([
      { method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } },
      { method: "Network.emulateNetworkConditions", params: { downloadThroughput: 50_000, latency: 2_000, offline: false, uploadThroughput: 50_000 } },
    ]);

    // Reset turns off exactly what is on, and status reflects it.
    guest.debugger.commands.length = 0;
    await expect(run({ kind: "devtools", action: "reset", approved: true, params: {} }))
      .resolves.toMatchObject({ ok: true, value: { result: { status: { throttle: null } } } });
    expect(guest.debugger.commands.map((command) => command.method)).toEqual([
      "Emulation.setCPUThrottlingRate", "Network.emulateNetworkConditions",
    ]);
    controller.close();
  });

  it("clears only the current page's cookies and origin data, never the whole partition", async () => {
    const guest = new FakeGuest();
    const controller = createDesignBrowserCdpController(guest.session as unknown as Session);
    await controller.attachGuest(guest as unknown as WebContents);
    controller.registerTarget({ projectId: "p1", tabId: "tab-1", url: guest.getURL(), webContentsId: guest.id });
    guest.debugger.responses["Network.getCookies"] = { cookies: [{ name: "sid", value: "secret", domain: ".example.com", path: "/" }] };
    guest.debugger.evaluateResult = { result: { type: "boolean", value: true } };
    guest.debugger.commands.length = 0;
    const result = await executeDesignBrowserRequest(controller, {
      tabId: "tab-1", expiresAt: Date.now() + 10_000,
      operation: { kind: "devtools", action: "storage-clear", approved: true, params: { types: ["cookies", "indexeddb", "local-storage"] } },
    });
    expect(result).toMatchObject({ ok: true, value: { result: { cleared: ["cookies", "indexeddb", "local-storage"], origin: "https://example.com" } } });
    const methods = guest.debugger.commands.map((command) => command.method);
    expect(guest.debugger.commands).toContainEqual({
      method: "Network.deleteCookies", params: { domain: ".example.com", name: "sid", path: "/" },
    });
    expect(guest.debugger.commands).toContainEqual({
      method: "Storage.clearDataForOrigin", params: { origin: "https://example.com", storageTypes: "indexeddb,local_storage" },
    });
    expect(methods).not.toContain("Network.clearBrowserCookies");
    expect(methods).not.toContain("Storage.clearCookies");
    // Cookie values are credentials: the usage report lists names only.
    expect(JSON.stringify(result)).not.toContain("secret");
    controller.close();
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
    expect(runtime).not.toContain("Allow the agent to control this browser tab?");
    expect(runtime).toContain("executeDesignBrowserRequest(browserCdp, request)");
    expect(cdp).toContain("browser command expired before execution");
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
