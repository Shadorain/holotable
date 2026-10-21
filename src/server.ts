import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";
import { isAllowedRemoteAddress, isTailscaleAddress, resolveBoardUrls } from "./access.ts";
import { HttpError, type BoardService, type ProjectSpec } from "./board.ts";
import { CLOSE_OUTCOMES, type NewOperationSpec } from "./commands.ts";
import type { Access, ClosedOutcome, Delivery, Fleet, Frontend, Kind, Settings, Tracker } from "./core/types.ts";
import { notifyChanged, onChanged } from "./core/notify.ts";
import type { Run } from "./ports.ts";
import { ActionError } from "./runtime/errors.ts";
const MAX_BODY = 5 * 1024 * 1024;
// Any flat file in web/ with a known type; the name pattern keeps requests inside that folder.
const ASSET_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
};
function assetFor(pathname: string): readonly [string, string] | null {
  if (pathname === "/") return ["index.html", ASSET_TYPES.html as string];
  if (pathname === "/intel") return ["intel.html", ASSET_TYPES.html as string];
  const match = /^\/([a-z0-9][a-z0-9-]*)\.(js|css|svg)$/.exec(pathname);
  return match ? [`${match[1]}.${match[2]}`, ASSET_TYPES[match[2] as string] as string] : null;
}

export interface BoardServer {
  url: string;
  urls: string[];
  close(): Promise<void>;
  rebind(settings: Pick<Settings, "access" | "port">): Promise<{ url: string; urls: string[] }>;
}

function respond(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
const fail = (res: ServerResponse, status: number, error: string) => respond(res, status, JSON.stringify({ error }));

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep draining an oversized body: aborting the read mid-stream makes Bun answer an empty 200.
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size <= MAX_BODY) chunks.push(part);
  }
  if (size > MAX_BODY) throw new HttpError(413, "Request body exceeds 5 MiB limit");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HttpError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${key} must be a non-empty string`);
  return value;
}

function requireParam(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new HttpError(400, `${key} is required`);
  return value;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}
/** Returns the JSON body of a 200 answer, unless it already answered `res` itself. */
type Route = (ctx: RouteContext) => unknown;

/** On these routes a failure that is not an HttpError is the caller's input being rejected: 400, not 500. */
function asBadRequest(route: Route): Route {
  return async (ctx) => {
    try {
      return await route(ctx);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  };
}

const assetCache = new Map<string, { mtimeMs: number; body: string }>();
/** A web/ file's text, re-read only when its mtime moves so edits show without a restart; null when missing. */
async function readAsset(name: string): Promise<string | null> {
  const file = new URL(`../web/${name}`, import.meta.url);
  try {
    const { mtimeMs } = await stat(file);
    const cached = assetCache.get(name);
    if (cached?.mtimeMs === mtimeMs) return cached.body;
    const body = await readFile(file, "utf8");
    assetCache.set(name, { mtimeMs, body });
    return body;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listenWithFallback(server: Server, desiredPort: number, bindHost: string): Promise<number> {
  if (desiredPort === 0) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onError = (err: unknown) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(0, bindHost, () => {
      server.removeListener("error", onError);
      resolve();
    });
    await promise;
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to get bound port");
    return addr.port;
  }

  const startPort = desiredPort;
  // A taken port (an older board, another app) moves the board to one of the next ten.
  const endPort = Math.min(desiredPort + 10, 65535);

  for (let port = startPort; port <= endPort; port++) {
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const onError = (err: unknown) => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, bindHost, () => {
        server.removeListener("error", onError);
        resolve();
      });
      await promise;
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to get bound port");
      return addr.port;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && port < endPort) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to bind to port ${desiredPort}`);
}

async function buildAcceptedHosts(port: number, access: Access, run?: Run): Promise<Set<string>> {
  const aliases = new Set<string>();
  const add = (value: string) => {
    const formatted = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
    aliases.add(`${formatted}:${port}`.toLowerCase());
    aliases.add(formatted.toLowerCase());
  };
  add("localhost");
  add("127.0.0.1");
  add("::1");

  if (access === "tailscale" || access === "network") {
    add(hostname());
    const ifaces = networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const entry of entries ?? []) {
        if (access === "network" || isTailscaleAddress(entry.address)) {
          add(entry.address);
        }
      }
    }
    if (run) {
      try {
        const result = await run("tailscale", ["status", "--json"], process.cwd());
        if (result.code === 0 && result.stdout) {
          const status = JSON.parse(result.stdout) as {
            Self?: { DNSName?: string; TailscaleIPs?: string[] };
          };
          if (status.Self?.DNSName) {
            const raw = status.Self.DNSName;
            add(raw);
            const noDot = raw.replace(/\.$/, "");
            add(noDot);
            const short = noDot.split(".")[0];
            if (short) add(short);
          }
          if (Array.isArray(status.Self?.TailscaleIPs)) {
            for (const ip of status.Self.TailscaleIPs) add(ip);
          }
        }
      } catch {
        // Ignored
      }
    }
  }

  return aliases;
}

export interface StartServerInput {
  service: BoardService;
  settings: {
    access?: Access;
    port: number;
  };
  /** API token, also the URL fragment. Random when absent (tests, throwaway servers). */
  token?: string;
  run?: Run;
  onRebind?: (url: string, urls: string[]) => Promise<void> | void;
  onShutdown?: () => Promise<void>;
}

export async function startServer(input: StartServerInput): Promise<BoardServer> {
  const { service } = input;
  let currentAccess: Access = input.settings.access ?? "tailscale";
  let bindHost = currentAccess === "local" ? "127.0.0.1" : "0.0.0.0";
  const token = input.token ?? randomBytes(32).toString("hex");
  const instance = randomBytes(16).toString("hex");
  const tokenBytes = Buffer.from(token, "utf8");
  let acceptedHosts = new Set<string>();
  let currentUrls: string[] = [];
  let currentUrl = "";
  let actualPort = 0;
  let currentServer: Server;
  const streams = new Set<ServerResponse>();
  const pending = new Set<Promise<void | ServerResponse>>();

  const routes: Record<string, Route> = {
    // Push channel: one event per change, debounced; the page refetches on receipt.
    "GET /api/stream": ({ res }) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        connection: "keep-alive",
      });
      res.flushHeaders();
      let blocked = !res.write(": ready\n\n");
      let dirty = false;
      let pushTimer: ReturnType<typeof setTimeout> | undefined;
      const push = () => {
        dirty = true;
        if (blocked || pushTimer !== undefined || res.destroyed) return;
        pushTimer = setTimeout(() => {
          pushTimer = undefined;
          if (res.destroyed || res.writableEnded || blocked) return;
          dirty = false;
          blocked = !res.write('data: {"type":"changed"}\n\n');
        }, 250);
      };
      res.on("drain", () => {
        blocked = false;
        if (dirty) push();
      });
      const off = onChanged(push);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded && !blocked)
          blocked = !res.write(": ping\n\n");
      }, 25_000);
      res.once("close", () => {
        off();
        clearInterval(heartbeat);
        clearTimeout(pushTimer);
      });
      // Long-lived: closeAllConnections does not reap streaming responses, so the
      // server tracks and destroys them itself on close and rebind.
      streams.add(res);
      res.once("close", () => streams.delete(res));
    },

    "GET /api/service": () => ({ pid: process.pid, instance }),
    "POST /api/service/stop": async ({ req, res }) => {
      if (!input.onShutdown) throw new HttpError(503, "Service shutdown is unavailable");
      const body = await readBody(req);
      if (body.pid !== process.pid || body.instance !== instance)
        throw new HttpError(409, "Board instance changed; refusing to stop it");
      res.once("finish", () => {
        void input.onShutdown?.().catch((error) => console.error(`holotable: shutdown: ${error}`));
      });
      respond(res, 202, JSON.stringify({ stopping: true }));
    },

    "GET /api/setup": () => service.setup(),
    "GET /api/operations": () => service.operations(),
    "GET /api/intel/sources": () => service.intelSources(),
    "GET /api/intel/rollup": () => service.intelRollup(),
    "GET /api/intel": ({ url }) => {
      const op = url.searchParams.get("op");
      const archive = url.searchParams.get("archive");
      if ((!op && !archive) || (op !== null && archive !== null) || url.searchParams.getAll("op").length > 1 || url.searchParams.getAll("archive").length > 1)
        throw new HttpError(400, "Provide exactly one op or archive");
      return service.intel(op ? { op } : { archive: archive! });
    },
    "POST /api/operations": asBadRequest(async ({ req }) => {
      if (!service.createOperation) throw new HttpError(404, "Operation creation is unavailable");
      const body = await readBody(req);
      const project = typeof body.project === "string" && body.project.length ? body.project : undefined;
      // With a project the repo/base come from it; without one both are required.
      let repo: string | undefined;
      if (body.repo !== undefined) {
        repo = requireString(body, "repo");
        if (!isAbsolute(repo)) throw new HttpError(400, "repo must be an absolute path");
        const resolved = await realpath(repo).catch(() => null);
        if (resolved === null) throw new HttpError(400, `repo ${repo} does not exist`);
        repo = resolved;
      } else if (!project) throw new HttpError(400, "repo is required (or pass a project)");
      let base: string | undefined;
      if (body.base !== undefined) base = requireString(body, "base");
      else if (!project) throw new HttpError(400, "base is required (or pass a project)");
      const integration = body.integration;
      if (integration !== undefined && (typeof integration !== "string" || !isAbsolute(integration)))
        throw new HttpError(400, "integration must be an absolute path");
      for (const key of ["tracker", "fleet", "frontend", "delivery"])
        if (body[key] !== undefined && typeof body[key] !== "string") throw new HttpError(400, `${key} must be a string`);
      const spec: NewOperationSpec = {
        id: requireString(body, "id"),
        ...(repo !== undefined ? { repo } : {}),
        ...(base !== undefined ? { base } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof integration === "string" ? { integration } : {}),
        ...(typeof body.pause === "boolean" ? { pause: body.pause } : {}),
        ...(typeof body.tracker === "string" ? { tracker: body.tracker as Tracker } : {}),
        ...(typeof body.fleet === "string" ? { fleet: body.fleet as Fleet } : {}),
        ...(typeof body.frontend === "string" ? { frontend: body.frontend as Frontend } : {}),
        ...(typeof body.delivery === "string" ? { delivery: body.delivery as Delivery } : {}),
        ...(typeof body.brief === "string" ? { brief: body.brief } : {}),
        ...(typeof body.seed === "string" ? { seed: body.seed } : {}),
        ...(typeof body.recover === "boolean" ? { recover: body.recover } : {}),
      };
      const created = await service.createOperation(spec);
      return { id: created.id };
    }),
    "GET /api/repos": () => service.repos(),
    "POST /api/projects/detect": asBadRequest(async ({ req }) => service.detect(requireString(await readBody(req), "repo"))),
    "GET /api/projects": () => service.projects(),
    "POST /api/projects": asBadRequest(async ({ req }) => {
      const body = await readBody(req);
      const repo = requireString(body, "repo");
      for (const key of ["id", "name", "base", "integration", "tracker", "fleet", "frontend", "delivery", "worktreeRoot"])
        if (body[key] !== undefined && typeof body[key] !== "string") throw new HttpError(400, `${key} must be a string`);
      if (body.pause !== undefined && typeof body.pause !== "boolean") throw new HttpError(400, "pause must be a boolean");
      const spec: ProjectSpec = {
        repo,
        ...(typeof body.base === "string" ? { base: body.base } : {}),
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.integration === "string" ? { integration: body.integration } : {}),
        ...(typeof body.pause === "boolean" ? { pause: body.pause } : {}),
        ...(typeof body.tracker === "string" ? { tracker: body.tracker } : {}),
        ...(typeof body.fleet === "string" ? { fleet: body.fleet } : {}),
        ...(typeof body.frontend === "string" ? { frontend: body.frontend } : {}),
        ...(typeof body.delivery === "string" ? { delivery: body.delivery } : {}),
        ...(typeof body.worktreeRoot === "string" ? { worktreeRoot: body.worktreeRoot } : {}),
      };
      return service.createProject(spec);
    }),
    "GET /api/project-config": ({ url }) => service.projectConfig(requireParam(url, "project")),
    "POST /api/project-config": asBadRequest(async ({ req }) => {
      const body = await readBody(req);
      return service.setProjectField(requireString(body, "project"), requireString(body, "field"), requireString(body, "value"));
    }),
    "POST /api/projects/remove": asBadRequest(async ({ req }) => {
      await service.deleteProject(requireString(await readBody(req), "id"));
      return { ok: true };
    }),
    "POST /api/project-graph": async ({ req }) => {
      const body = await readBody(req);
      const project = requireString(body, "project");
      const op = requireString(body, "op");
      if (op !== "install" && op !== "restart") throw new HttpError(400, 'op must be "install" or "restart"');
      return op === "install" ? service.installGraphService(project) : service.restartGraphService(project);
    },
    "GET /api/notes": ({ url }) => service.notes(requireParam(url, "op")),
    "PUT /api/notes": asBadRequest(async ({ req }) => {
      const body = await readBody(req);
      const op = requireString(body, "op");
      // Empty notes are allowed: clearing the pad is a normal edit.
      if (typeof body.text !== "string") throw new HttpError(400, "text must be a string");
      const text = body.text;
      const base = body.base !== undefined ? requireString(body, "base") : "";
      return service.setNotes(op, text, base);
    }),
    "GET /api/drafts": ({ url }) => {
      const id = url.searchParams.get("id");
      return id ? service.draft(id) : service.listDrafts();
    },
    "POST /api/drafts": asBadRequest(async ({ req }) => {
      if (!service.createDraft) throw new HttpError(404, "Drafts are unavailable");
      const body = await readBody(req);
      const text = requireString(body, "text");
      for (const key of ["project", "repo"]) if (body[key] !== undefined && typeof body[key] !== "string") throw new HttpError(400, `${key} must be a string`);
      if (body.model !== undefined && body.model !== null && typeof body.model !== "string")
        throw new HttpError(400, "model must be a string or null");
      return service.createDraft({
        text,
        ...(typeof body.project === "string" ? { project: body.project } : {}),
        ...(typeof body.repo === "string" ? { repo: body.repo } : {}),
        ...(body.model !== undefined ? { model: body.model as string | null } : {}),
      });
    }),
    "POST /api/drafts/close": asBadRequest(async ({ req }) => {
      await service.closeDraft(requireString(await readBody(req), "id"));
      return { ok: true };
    }),
    "GET /api/plan": async ({ url }) => {
      const op = url.searchParams.get("op");
      const contact = url.searchParams.get("contact");
      if (!op || !contact) throw new HttpError(400, "op and contact are required");
      const plan = await service.plan?.(op, contact);
      if (!plan) throw new HttpError(404, "No plan");
      return plan;
    },
    "GET /api/brief": ({ url }) => service.brief(requireParam(url, "op")),
    "PUT /api/brief": async ({ req }) => {
      const body = await readBody(req);
      if (typeof body.text !== "string") throw new HttpError(400, "text must be a string");
      await service.setBrief(requireString(body, "op"), body.text);
      return { brief: body.text };
    },
    "GET /api/tracker/search": ({ url }) => {
      const q = url.searchParams.get("q");
      if (q === null) throw new HttpError(400, "q is required");
      return service.trackerSearch({ op: url.searchParams.get("op"), project: url.searchParams.get("project"), q });
    },
    "GET /api/tracker/issue": ({ url }) => {
      const op = url.searchParams.get("op");
      const ticket = url.searchParams.get("ticket");
      if (!op || !ticket) throw new HttpError(400, "op and ticket are required");
      return service.trackerIssue(op, ticket);
    },
    "POST /api/zones": async ({ req }) => {
      const body = await readBody(req);
      return { id: await service.addZone(requireString(body, "op"), requireString(body, "label").trim()) };
    },
    "POST /api/contacts": asBadRequest(async ({ req }) => {
      const body = await readBody(req);
      const blockedBy = body.blockedBy;
      if (blockedBy !== undefined && (!Array.isArray(blockedBy) || blockedBy.some((t) => typeof t !== "string")))
        throw new HttpError(400, "blockedBy must be an array of tickets");
      const kind = body.kind;
      if (kind !== undefined && typeof kind !== "string") throw new HttpError(400, "kind must be a string");
      const title = body.title;
      if (title !== undefined && title !== null && typeof title !== "string") throw new HttpError(400, "title must be a string or null");
      const description = body.description;
      if (description !== undefined && description !== null && typeof description !== "string") throw new HttpError(400, "description must be a string or null");
      const options = body.options;
      if (options !== undefined && (!Array.isArray(options) || options.some((t) => typeof t !== "string")))
        throw new HttpError(400, "options must be an array of strings");
      const recommended = body.recommended;
      if (recommended !== undefined && typeof recommended !== "string") throw new HttpError(400, "recommended must be a string");
      const added = await service.addContact(requireString(body, "op"), {
        ticket: requireString(body, "ticket"),
        zone: requireString(body, "zone"),
        ...(kind !== undefined ? { kind: kind as Kind } : {}),
        ...(title !== undefined ? { title: title as string | null } : {}),
        ...(description !== undefined ? { description: description as string | null } : {}),
        ...(blockedBy !== undefined ? { blockedBy: blockedBy as string[] } : {}),
        ...(options !== undefined ? { options: options as string[] } : {}),
        ...(recommended !== undefined ? { recommended: recommended as string } : {}),
      });
      return { ticket: added.ticket };
    }),
    "GET /api/projection": ({ url }) => service.projection(requireParam(url, "op")),
    "GET /api/usage": ({ url }) => {
      if (!service.usage) throw new HttpError(404, "Usage sampling is unavailable");
      return service.usage(url.searchParams.get("op"));
    },
    "GET /api/history": ({ url }) => service.history(requireParam(url, "op")),
    "GET /api/models": ({ url }) => service.models(url.searchParams.get("refresh") === "1", url.searchParams.get("usage") === "1"),
    "GET /api/settings": () => service.settings(),
    "PUT /api/settings": async ({ req }) => {
      const body = await readBody(req);
      const value = body.value;
      if (value !== null && typeof value !== "string") throw new HttpError(400, "value must be a string or null");
      const key = requireString(body, "key");
      const updated = await service.setSetting(key, value);
      if (key === "access" || key === "port") {
        const rebindResult = await doRebind({
          access: updated.settings.access,
          port: updated.settings.port,
        });
        updated.urls = rebindResult.urls;
      }
      return updated;
    },
    "GET /api/operation-config": ({ url }) => service.operationConfig(requireParam(url, "op")),
    "POST /api/operation-config": async ({ req }) => {
      const body = await readBody(req);
      const value = body.value;
      if (typeof value !== "string") throw new HttpError(400, "value must be a string");
      return service.setOperationField(requireString(body, "op"), requireString(body, "field"), value);
    },
    "GET /api/operation": async ({ url }) => {
      const op = requireParam(url, "op");
      const cfg = await service.operationConfig(op);
      const brief = await service.brief(op);
      return { cfg, brief: brief.brief, seed: brief.seed, createdAt: brief.createdAt };
    },
    "POST /api/refresh": async ({ req }) => {
      const op = requireString(await readBody(req), "op");
      await service.projection(op); // 404 for unknown operations
      await service.refresh?.(op);
      return { ok: true };
    },
    "POST /api/actions": async ({ req }) => {
      const body = await readBody(req);
      const op = requireString(body, "op");
      const action = requireString(body, "action");
      const contact = typeof body.contact === "string" ? body.contact : "";
      const args = body.args;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
        throw new HttpError(400, "args must be an object");
      if (args && "model" in args && args.model !== undefined && args.model !== null && typeof args.model !== "string")
        throw new HttpError(400, "args.model must be a string or null");
      if (!service.action) throw new HttpError(404, "No action runtime");
      const projection = await service.projection(op);
      const view = projection.contacts.find((c) => c.ticket === contact);
      const offered = view?.actions.find((a) => a.id === action);
      if (contact && !view) throw new HttpError(404, `No contact "${contact}" in ${op}`);
      if (contact && (!offered || !offered.enabled))
        throw new HttpError(409, offered?.reason ?? `Action "${action}" is not available for ${contact}`);
      try {
        if (service.action) await service.action({ op, contact, action, args: (args as Record<string, unknown> | undefined) ?? {} });
      } finally {
        // A failed action can still have changed state (a launch that stopped halfway).
        await service.settle?.(op).catch(() => undefined);
      }
      return { ok: true };
    },
    "GET /api/abort-preview": ({ url }) => {
      if (!service.end) throw new HttpError(404, "No wind-down runtime");
      return service.end.preview(requireParam(url, "op"));
    },
    "POST /api/abort": async ({ req }) => {
      if (!service.end) throw new HttpError(404, "No wind-down runtime");
      const body = await readBody(req);
      return service.end.abort(requireString(body, "op"), body.confirm as string);
    },
    "POST /api/close": async ({ req }) => {
      if (!service.end) throw new HttpError(404, "No wind-down runtime");
      const body = await readBody(req);
      const outcome = requireString(body, "outcome");
      if (!(CLOSE_OUTCOMES as readonly string[]).includes(outcome))
        throw new HttpError(400, `outcome must be one of ${CLOSE_OUTCOMES.join(", ")}`);
      return service.end.close(requireString(body, "op"), outcome as ClosedOutcome);
    },
    "GET /api/archive": () => service.archive(),
    "GET /api/archive/report": ({ url }) => service.archiveReport(requireParam(url, "key")),
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!isAllowedRemoteAddress(req.socket.remoteAddress, currentAccess)) {
        return fail(res, 403, "Access rejected");
      }
      const host = req.headers.host;
      if (!host || !acceptedHosts.has(host.toLowerCase())) return fail(res, 403, "Invalid host");
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const pathname = url.pathname;
      const asset = assetFor(pathname);
      if (method === "GET" && asset) {
        const body = await readAsset(asset[0]);
        if (body === null) return fail(res, 404, "Not found");
        return respond(res, 200, body, asset[1]);
      }
      if (!pathname.startsWith("/api/")) return fail(res, 404, "Not found");
      const supplied = req.headers["x-holotable-token"];
      const suppliedBytes = typeof supplied === "string" ? Buffer.from(supplied, "utf8") : Buffer.alloc(0);
      if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes))
        return fail(res, 401, "Unauthorized");

      if (method !== "GET") {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin ?? "");
        } catch {
          return fail(res, 403, "Invalid origin");
        }
        if (
          origin.protocol !== "http:" ||
          origin.host.toLowerCase() !== host.toLowerCase() ||
          !acceptedHosts.has(origin.host.toLowerCase())
        )
          return fail(res, 403, "Cross-origin request rejected");
      }

      const route = routes[`${method} ${pathname}`];
      if (!route) return fail(res, 404, "Not found");
      const body = await route({ req, res, url });
      if (!res.headersSent) respond(res, 200, JSON.stringify(body));
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return fail(res, error.status, error.message);
      if (error instanceof ActionError) return fail(res, error.status, `${error.code}: ${error.message}`);
      const message = error instanceof Error ? error.message : String(error);
      return fail(res, 500, message);
    }
  };
  function trackRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) notifyChanged();
    });
    const task = handleRequest(req, res);
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  }

  async function doRebind(newSettings: { access: Access; port: number }): Promise<{ url: string; urls: string[] }> {
    currentAccess = newSettings.access;
    bindHost = currentAccess === "local" ? "127.0.0.1" : "0.0.0.0";

    const oldServer = currentServer;
    for (const res of streams) res.destroy();
    oldServer.close();

    const newServer = createServer(trackRequest);
    try {
      actualPort = await listenWithFallback(newServer, newSettings.port, bindHost);
      currentServer = newServer;
      acceptedHosts = await buildAcceptedHosts(actualPort, currentAccess, input.run);
      currentUrls = await resolveBoardUrls({ port: actualPort, token, access: currentAccess, run: input.run });
      currentUrl = currentUrls[0] ?? `http://127.0.0.1:${actualPort}/#${token}`;
      if (input.onRebind) {
        await input.onRebind(currentUrl, currentUrls);
      }
      return { url: currentUrl, urls: currentUrls };
    } catch (err) {
      currentServer = createServer(trackRequest);
      actualPort = await listenWithFallback(currentServer, actualPort, bindHost);
      throw err;
    }
  }

  currentServer = createServer(trackRequest);
  actualPort = await listenWithFallback(currentServer, input.settings.port, bindHost);
  acceptedHosts = await buildAcceptedHosts(actualPort, currentAccess, input.run);
  currentUrls = await resolveBoardUrls({ port: actualPort, token, access: currentAccess, run: input.run });
  currentUrl = currentUrls[0] ?? `http://127.0.0.1:${actualPort}/#${token}`;

  return {
    get url() {
      return currentUrl;
    },
    get urls() {
      return currentUrls;
    },
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      for (const res of streams) res.destroy();
      currentServer.close((error) => (error ? reject(error) : resolve()));
      currentServer.closeAllConnections();
      return promise.then(async () => {
        await Promise.allSettled(pending);
      });
    },
    rebind: doRebind,
  };
}
