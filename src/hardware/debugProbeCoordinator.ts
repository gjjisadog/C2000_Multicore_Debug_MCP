import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DebugMcpError } from "../utils/errors.js";

export interface DebugProbeLease {
  leaseId: string;
  queuePositionAtEntry: number;
  waitedMs: number;
  probe?: DebugProbeResource;
  release(): Promise<void>;
}

export interface DebugProbeCoordinator {
  acquire(label: string, selection?: DebugProbeSelection): Promise<DebugProbeLease>;
}

export interface DebugProbeResource {
  probeId: string;
  serialNumber: string;
  ccxmlPath: string;
}

export interface DebugProbeSelection {
  probeId?: string;
  preferredProbeIds?: string[];
  allowAutoProbeAllocation?: boolean;
}

export class DebugProbePoolCoordinator implements DebugProbeCoordinator {
  private nextTieBreak = 0;

  constructor(
    private readonly rootDir: string,
    private readonly probes: DebugProbeResource[],
    private readonly timeoutMs = 600_000,
    private readonly pollMs = 250
  ) {
    if (probes.length === 0) throw new DebugMcpError("ProbeNotFound", "The debug probe pool has no enabled boards");
    const ids = new Set<string>();
    const serials = new Set<string>();
    for (const probe of probes) {
      if (ids.has(probe.probeId)) throw new DebugMcpError("DuplicateProbeId", `Duplicate probeId: ${probe.probeId}`);
      if (serials.has(probe.serialNumber)) throw new DebugMcpError("DuplicateProbeId", `Duplicate XDS110 serialNumber: ${probe.serialNumber}`);
      ids.add(probe.probeId);
      serials.add(probe.serialNumber);
    }
  }

  async acquire(label: string, selection: DebugProbeSelection = {}): Promise<DebugProbeLease> {
    if (!selection.probeId && !selection.allowAutoProbeAllocation) {
      throw new DebugMcpError("ProbeSelectionRequired", "Multi-board mode requires probeId or allowAutoProbeAllocation=true", { availableProbeIds: this.probes.map(item => item.probeId) });
    }
    const candidates = this.candidates(selection);
    const loads = await Promise.all(candidates.map(async probe => ({ probe, load: await probeLoad(path.join(this.rootDir, "probes", safeId(probe.probeId))) })));
    const minimum = Math.min(...loads.map(item => item.load));
    const leastLoaded = loads.filter(item => item.load === minimum);
    const chosen = leastLoaded[this.nextTieBreak++ % leastLoaded.length].probe;
    const lease = await new FileDebugProbeCoordinator(path.join(this.rootDir, "probes", safeId(chosen.probeId)), this.timeoutMs, this.pollMs).acquire(label);
    return { ...lease, probe: chosen };
  }

  private candidates(selection: DebugProbeSelection): DebugProbeResource[] {
    if (selection.probeId) {
      const probe = this.probes.find(item => item.probeId === selection.probeId);
      if (!probe) throw new DebugMcpError("ProbeNotFound", `Unknown or disabled probeId: ${selection.probeId}`, { availableProbeIds: this.probes.map(item => item.probeId) });
      return [probe];
    }
    if (selection.preferredProbeIds?.length) {
      const preferred = selection.preferredProbeIds.map(id => this.probes.find(item => item.probeId === id)).filter((item): item is DebugProbeResource => Boolean(item));
      if (preferred.length) return preferred;
    }
    return this.probes;
  }
}

export class FileDebugProbeCoordinator implements DebugProbeCoordinator {
  constructor(
    private readonly rootDir: string,
    private readonly timeoutMs = 600_000,
    private readonly pollMs = 250
  ) {}

  async acquire(label: string): Promise<DebugProbeLease> {
    const queueDir = path.join(this.rootDir, "queue");
    const activeDir = path.join(this.rootDir, "active");
    await mkdir(queueDir, { recursive: true });
    const leaseId = `${Date.now().toString().padStart(16, "0")}-${process.pid}-${randomUUID()}`;
    const ticketPath = path.join(queueDir, `${leaseId}.json`);
    await writeFile(ticketPath, JSON.stringify({ leaseId, pid: process.pid, label, createdAt: new Date().toISOString() }), { flag: "wx" });
    const cleanupWaitingTicket = () => rmSync(ticketPath, { force: true });
    process.once("exit", cleanupWaitingTicket);
    const startedAt = Date.now();
    const initialTickets = await tickets(queueDir);
    const queuePositionAtEntry = initialTickets.indexOf(path.basename(ticketPath)) + 1;

    while (Date.now() - startedAt < this.timeoutMs) {
      const currentTickets = await tickets(queueDir);
      if (currentTickets[0] === path.basename(ticketPath)) {
        await clearStaleActiveLease(activeDir);
        try {
          await mkdir(activeDir);
          const ownerPath = path.join(activeDir, "owner.json");
          await writeFile(ownerPath, JSON.stringify({ leaseId, pid: process.pid, label, acquiredAt: new Date().toISOString() }));
          process.removeListener("exit", cleanupWaitingTicket);
          const cleanupOnExit = () => {
            removeActiveLeaseIfOwned(activeDir, leaseId);
            rmSync(ticketPath, { force: true });
          };
          process.once("exit", cleanupOnExit);
          let released = false;
          return {
            leaseId,
            queuePositionAtEntry,
            waitedMs: Date.now() - startedAt,
            release: async () => {
              if (released) return;
              released = true;
              process.removeListener("exit", cleanupOnExit);
              await rm(activeDir, { recursive: true, force: true });
              await rm(ticketPath, { force: true });
            }
          };
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      await delay(this.pollMs);
    }
    process.removeListener("exit", cleanupWaitingTicket);
    await rm(ticketPath, { force: true });
    throw new DebugMcpError("ProbeQueueTimeout", `Timed out waiting for the shared XDS110 lease`, { label, timeoutMs: this.timeoutMs, queuePositionAtEntry });
  }
}

async function tickets(queueDir: string): Promise<string[]> {
  const names = (await readdir(queueDir)).filter(name => name.endsWith(".json")).sort();
  const live: string[] = [];
  for (const name of names) {
    const ticketPath = path.join(queueDir, name);
    try {
      const ticket = JSON.parse(await readFile(ticketPath, "utf8")) as { pid?: unknown };
      if (typeof ticket.pid === "number" && processExists(ticket.pid)) live.push(name);
      else await rm(ticketPath, { force: true });
    } catch (error) {
      if (!isMissing(error)) await rm(ticketPath, { force: true });
    }
  }
  return live;
}

function removeActiveLeaseIfOwned(activeDir: string, leaseId: string): void {
  try {
    const owner = JSON.parse(readFileSync(path.join(activeDir, "owner.json"), "utf8")) as { leaseId?: unknown };
    if (owner.leaseId === leaseId) rmSync(activeDir, { recursive: true, force: true });
  } catch {
    // Another process may already have recovered or released this lease.
  }
}

async function clearStaleActiveLease(activeDir: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(path.join(activeDir, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid === "number" && processExists(owner.pid)) return;
    await rm(activeDir, { recursive: true, force: true });
  } catch (error) {
    if (isMissing(error)) return;
    await rm(activeDir, { recursive: true, force: true });
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function probeLoad(rootDir: string): Promise<number> {
  let queued = 0;
  try { queued = (await readdir(path.join(rootDir, "queue"))).filter(name => name.endsWith(".json")).length; } catch { /* Empty queue. */ }
  try { await readFile(path.join(rootDir, "active", "owner.json"), "utf8"); return queued + 1; } catch { return queued; }
}

function safeId(value: string): string { return encodeURIComponent(value); }
