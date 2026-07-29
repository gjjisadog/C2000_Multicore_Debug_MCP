import type { DebugSessionManager } from "../debug/DebugSessionManager.js";
import { DebugMcpError } from "../utils/errors.js";
import {
  ERAD_SCHEMA_VERSION,
  eradCapabilitiesSchema,
  eradResourceSelectionSchema,
  type EradCapabilities,
  type EradResourceSelection
} from "./EradSchemas.js";

const PAGE = "DATA";
const GLOBAL_BASE = 0x0005e800;
const BUS_BASE = 0x0005e900;
const COUNTER_BASE = 0x0005e980;
const GLOBAL_ENABLE = GLOBAL_BASE + 0x4;
const GLOBAL_COUNTER_RESET = GLOBAL_BASE + 0x6;
const GLOBAL_OWNER = GLOBAL_BASE + 0xa;
const OWNER_NONE = 0;
const OWNER_APPLICATION = 1;
const OWNER_DEBUGGER = 2;

interface EradContext {
  manager: DebugSessionManager;
  sessionId: string;
  coreId: number;
  device: string;
}

export interface EradConfiguredState {
  resources: EradResourceSelection;
  savedConfiguration: Record<string, unknown>;
  overwritten: boolean;
}

export interface EradRawRead {
  count: number;
  totalCycles: number;
  maxCycles: number;
  overflowResources: string[];
}

export interface EradBackend {
  capabilities(context: EradContext): Promise<EradCapabilities>;
  configure(
    context: EradContext,
    input: {
      startAddress: number;
      endAddress: number;
      resources?: EradResourceSelection;
      allowOverwrite: boolean;
    }
  ): Promise<EradConfiguredState>;
  start(context: EradContext, resources: EradResourceSelection): Promise<void>;
  stopAndRead(context: EradContext, resources: EradResourceSelection): Promise<EradRawRead>;
  restore(context: EradContext, resources: EradResourceSelection, saved: Record<string, unknown>): Promise<"RESTORED" | "NOT_REQUIRED">;
}

export class F28p65xEradRegisterBackend implements EradBackend {
  async capabilities(context: EradContext): Promise<EradCapabilities> {
    if (!isF28p65x(context.device)) return unsupportedCapabilities(context.device);
    const owner = await read16(context, GLOBAL_OWNER) & 0x3;
    const enabled = await read16(context, GLOBAL_ENABLE);
    const occupiedBusComparators: number[] = [];
    const occupiedCounters: number[] = [];
    for (let instance = 1; instance <= 8; instance += 1) {
      const base = busBase(instance);
      const [mask, reference, control, status] = await Promise.all([
        read32(context, base),
        read32(context, base + 0x2),
        read16(context, base + 0x6),
        read16(context, base + 0x7)
      ]);
      if ((enabled & busEnableBit(instance)) !== 0 || ((status >>> 14) & 0x3) !== 0 ||
          mask !== 0 || reference !== 0 || control !== 0) {
        occupiedBusComparators.push(instance);
      }
    }
    for (let instance = 1; instance <= 4; instance += 1) {
      const base = counterBase(instance);
      const [control, reference, input1, input2, condition, status] = await Promise.all([
        read16(context, base),
        read32(context, base + 0x2),
        read16(context, base + 0x8),
        read16(context, base + 0xa),
        read16(context, base + 0xb),
        read16(context, base + 0x1)
      ]);
      if ((enabled & counterEnableBit(instance)) !== 0 || ((status >>> 12) & 0xf) !== 0 ||
          control !== 0 || reference !== 0 || input1 !== 0 || input2 !== 0 || condition !== 0) {
        occupiedCounters.push(instance);
      }
    }
    return eradCapabilitiesSchema.parse({
      schemaVersion: ERAD_SCHEMA_VERSION,
      supported: owner !== OWNER_APPLICATION,
      device: context.device,
      supportedDevices: ["F28P65x"],
      addressUnitBits: 16,
      registerPage: PAGE,
      busComparatorCount: 8,
      counterCount: 4,
      supportsPcRange: true,
      supportsCycleCount: true,
      supportsEventCount: true,
      supportsMaxCycles: true,
      supportsMinCycles: false,
      supportsClaTaskTiming: false,
      supportsInterruptNesting: false,
      supportsCrossCoreSynchronization: false,
      supportsIpcSingleCycleLatency: false,
      ownership: ownerName(owner),
      occupiedBusComparators,
      occupiedCounters,
      reason: owner === OWNER_APPLICATION
        ? "ERAD is owned by the target application; debugger profiling refuses to take ownership."
        : null
    });
  }

  async configure(
    context: EradContext,
    input: {
      startAddress: number;
      endAddress: number;
      resources?: EradResourceSelection;
      allowOverwrite: boolean;
    }
  ): Promise<EradConfiguredState> {
    assertF28p65x(context.device);
    if (input.startAddress === input.endAddress) {
      throw new DebugMcpError("EradAddressRangeInvalid", "ERAD start and end PC addresses must be distinct");
    }
    const capabilities = await this.capabilities(context);
    if (!capabilities.supported) {
      throw new DebugMcpError("EradOwnershipConflict", capabilities.reason ?? "ERAD is unavailable", {
        ownership: capabilities.ownership
      });
    }
    const resources = input.resources ?? selectFreeResources(capabilities);
    eradResourceSelectionSchema.parse(resources);
    const conflicts = selectedConflicts(resources, capabilities);
    if (conflicts.length > 0 && !input.allowOverwrite) {
      throw new DebugMcpError("EradResourceConflict", "Selected ERAD resources are already configured or enabled", {
        conflicts,
        allowOverwrite: false
      });
    }
    if (input.allowOverwrite && !input.resources) {
      throw new DebugMcpError("EradOverwriteSelectionRequired", "Explicit overwrite requires explicit ERAD resource selection");
    }
    const savedConfiguration = await snapshot(context, resources);
    try {
      await disableSelected(context, resources);
      const currentOwner = await read16(context, GLOBAL_OWNER) & 0x3;
      if (currentOwner === OWNER_NONE) await write16(context, GLOBAL_OWNER, OWNER_DEBUGGER);
      if ((await read16(context, GLOBAL_OWNER) & 0x3) !== OWNER_DEBUGGER) {
        throw new DebugMcpError("EradOwnershipConflict", "Debugger ownership could not be established");
      }
      await configureBus(context, resources.startBusComparator, input.startAddress);
      await configureBus(context, resources.endBusComparator, input.endAddress);
      const startEvent = resources.startBusComparator - 1;
      const endEvent = resources.endBusComparator - 1;
      await configureRangeCounter(context, resources.maxCounter, startEvent, endEvent, false);
      await configureRangeCounter(context, resources.cumulativeCounter, startEvent, endEvent, true);
      await configureEventCounter(context, resources.eventCounter, startEvent);
      await clearAndReset(context, resources);
      return { resources, savedConfiguration, overwritten: conflicts.length > 0 };
    } catch (error) {
      await this.restore(context, resources, savedConfiguration).catch(() => undefined);
      throw error;
    }
  }

  async start(context: EradContext, resources: EradResourceSelection): Promise<void> {
    assertF28p65x(context.device);
    await clearAndReset(context, resources);
    const current = await read16(context, GLOBAL_ENABLE);
    await write16(context, GLOBAL_ENABLE, current | selectedEnableMask(resources));
  }

  async stopAndRead(context: EradContext, resources: EradResourceSelection): Promise<EradRawRead> {
    assertF28p65x(context.device);
    await disableSelected(context, resources);
    const entries: Array<[string, number]> = [
      ["maxCounter", resources.maxCounter],
      ["cumulativeCounter", resources.cumulativeCounter],
      ["eventCounter", resources.eventCounter]
    ];
    const overflowResources: string[] = [];
    for (const [name, instance] of entries) {
      if ((await read16(context, counterBase(instance) + 0x1) & 0x2) !== 0) overflowResources.push(name);
    }
    return {
      count: await read32(context, counterBase(resources.eventCounter) + 0x4),
      totalCycles: await read32(context, counterBase(resources.cumulativeCounter) + 0x4),
      maxCycles: await read32(context, counterBase(resources.maxCounter) + 0x6),
      overflowResources
    };
  }

  async restore(
    context: EradContext,
    resources: EradResourceSelection,
    saved: Record<string, unknown>
  ): Promise<"RESTORED" | "NOT_REQUIRED"> {
    if (saved.required === false) return "NOT_REQUIRED";
    assertF28p65x(context.device);
    await disableSelected(context, resources);
    const buses = arrayRecords(saved.busComparators);
    for (const item of buses) {
      const instance = Number(item.instance);
      const base = busBase(instance);
      await write32(context, base, Number(item.mask));
      await write32(context, base + 0x2, Number(item.reference));
      await write16(context, base + 0x6, Number(item.control));
    }
    const counters = arrayRecords(saved.counters);
    for (const item of counters) {
      const instance = Number(item.instance);
      const base = counterBase(instance);
      await write16(context, base, Number(item.control));
      await write32(context, base + 0x2, Number(item.reference));
      await write32(context, base + 0x4, Number(item.count));
      await write32(context, base + 0x6, Number(item.maxCount));
      await write16(context, base + 0x8, Number(item.inputSelect));
      await write16(context, base + 0xa, Number(item.inputSelect2));
      await write16(context, base + 0xb, Number(item.inputCondition));
    }
    const currentEnable = await read16(context, GLOBAL_ENABLE);
    const mask = selectedEnableMask(resources);
    await write16(context, GLOBAL_ENABLE, (currentEnable & ~mask) | (Number(saved.globalEnable) & mask));
    if (Number(saved.owner) !== OWNER_DEBUGGER && (await read16(context, GLOBAL_OWNER) & 0x3) === OWNER_DEBUGGER) {
      await write16(context, GLOBAL_OWNER, Number(saved.owner));
    }
    return "RESTORED";
  }
}

export class MockEradBackend implements EradBackend {
  private readonly states = new Map<string, {
    resources: EradResourceSelection;
    running: boolean;
    overwritten: boolean;
  }>();

  constructor(private readonly options: {
    occupiedBusComparators?: number[];
    occupiedCounters?: number[];
    count?: number;
    totalCycles?: number;
    maxCycles?: number;
    overflowResources?: string[];
  } = {}) {}

  async capabilities(context: EradContext): Promise<EradCapabilities> {
    if (!isF28p65x(context.device)) return unsupportedCapabilities(context.device);
    return eradCapabilitiesSchema.parse({
      schemaVersion: ERAD_SCHEMA_VERSION,
      supported: true,
      device: context.device,
      supportedDevices: ["F28P65x"],
      addressUnitBits: 16,
      registerPage: PAGE,
      busComparatorCount: 8,
      counterCount: 4,
      supportsPcRange: true,
      supportsCycleCount: true,
      supportsEventCount: true,
      supportsMaxCycles: true,
      supportsMinCycles: false,
      supportsClaTaskTiming: false,
      supportsInterruptNesting: false,
      supportsCrossCoreSynchronization: false,
      supportsIpcSingleCycleLatency: false,
      ownership: "DEBUGGER",
      occupiedBusComparators: this.options.occupiedBusComparators ?? [],
      occupiedCounters: this.options.occupiedCounters ?? [],
      reason: null
    });
  }

  async configure(
    context: EradContext,
    input: { resources?: EradResourceSelection; allowOverwrite: boolean }
  ): Promise<EradConfiguredState> {
    assertF28p65x(context.device);
    const caps = await this.capabilities(context);
    const resources = input.resources ?? selectFreeResources(caps);
    eradResourceSelectionSchema.parse(resources);
    const conflicts = selectedConflicts(resources, caps);
    if (conflicts.length && !input.allowOverwrite) {
      throw new DebugMcpError("EradResourceConflict", "Mock ERAD resources are occupied", { conflicts });
    }
    const savedConfiguration = { required: conflicts.length > 0, mock: true, conflicts };
    this.states.set(key(context), { resources, running: false, overwritten: conflicts.length > 0 });
    return { resources, savedConfiguration, overwritten: conflicts.length > 0 };
  }

  async start(context: EradContext, resources: EradResourceSelection): Promise<void> {
    const state = this.states.get(key(context));
    if (!state || JSON.stringify(state.resources) !== JSON.stringify(resources)) {
      throw new DebugMcpError("EradProfileNotConfigured", "Mock ERAD profile is not configured for this session/core");
    }
    state.running = true;
  }

  async stopAndRead(context: EradContext): Promise<EradRawRead> {
    const state = this.states.get(key(context));
    if (!state) throw new DebugMcpError("EradProfileNotConfigured", "Mock ERAD profile is not configured");
    state.running = false;
    return {
      count: this.options.count ?? 10,
      totalCycles: this.options.totalCycles ?? 1000,
      maxCycles: this.options.maxCycles ?? 120,
      overflowResources: this.options.overflowResources ?? []
    };
  }

  async restore(context: EradContext, _resources: EradResourceSelection, saved: Record<string, unknown>): Promise<"RESTORED" | "NOT_REQUIRED"> {
    this.states.delete(key(context));
    return saved.required === true ? "RESTORED" : "NOT_REQUIRED";
  }
}

function unsupportedCapabilities(device: string): EradCapabilities {
  return eradCapabilitiesSchema.parse({
    schemaVersion: ERAD_SCHEMA_VERSION,
    supported: false,
    device,
    supportedDevices: ["F28P65x"],
    addressUnitBits: 16,
    registerPage: PAGE,
    busComparatorCount: 0,
    counterCount: 0,
    supportsPcRange: false,
    supportsCycleCount: false,
    supportsEventCount: false,
    supportsMaxCycles: false,
    supportsMinCycles: false,
    supportsClaTaskTiming: false,
    supportsInterruptNesting: false,
    supportsCrossCoreSynchronization: false,
    supportsIpcSingleCycleLatency: false,
    ownership: "UNKNOWN",
    occupiedBusComparators: [],
    occupiedCounters: [],
    reason: `Unsupported device '${device}'. First-version ERAD profiling is F28P65x-only.`
  });
}

function selectFreeResources(capabilities: EradCapabilities): EradResourceSelection {
  const buses = range(1, 8).filter(item => !capabilities.occupiedBusComparators.includes(item));
  const counters = range(1, 4).filter(item => !capabilities.occupiedCounters.includes(item));
  if (buses.length < 2 || counters.length < 3) {
    throw new DebugMcpError("EradResourcesUnavailable", "ERAD profiling requires two free bus comparators and three free counters", {
      freeBusComparators: buses,
      freeCounters: counters
    });
  }
  return {
    startBusComparator: buses[0]!,
    endBusComparator: buses[1]!,
    maxCounter: counters[0]!,
    cumulativeCounter: counters[1]!,
    eventCounter: counters[2]!
  };
}

function selectedConflicts(resources: EradResourceSelection, capabilities: EradCapabilities): string[] {
  const conflicts: string[] = [];
  for (const [name, instance] of [
    ["startBusComparator", resources.startBusComparator],
    ["endBusComparator", resources.endBusComparator]
  ] as const) {
    if (capabilities.occupiedBusComparators.includes(instance)) conflicts.push(`${name}:${instance}`);
  }
  for (const [name, instance] of [
    ["maxCounter", resources.maxCounter],
    ["cumulativeCounter", resources.cumulativeCounter],
    ["eventCounter", resources.eventCounter]
  ] as const) {
    if (capabilities.occupiedCounters.includes(instance)) conflicts.push(`${name}:${instance}`);
  }
  return conflicts;
}

async function snapshot(context: EradContext, resources: EradResourceSelection): Promise<Record<string, unknown>> {
  return {
    required: true,
    owner: await read16(context, GLOBAL_OWNER) & 0x3,
    globalEnable: await read16(context, GLOBAL_ENABLE),
    busComparators: await Promise.all([resources.startBusComparator, resources.endBusComparator].map(async instance => {
      const base = busBase(instance);
      return {
        instance,
        mask: await read32(context, base),
        reference: await read32(context, base + 0x2),
        control: await read16(context, base + 0x6)
      };
    })),
    counters: await Promise.all([resources.maxCounter, resources.cumulativeCounter, resources.eventCounter].map(async instance => {
      const base = counterBase(instance);
      return {
        instance,
        control: await read16(context, base),
        reference: await read32(context, base + 0x2),
        count: await read32(context, base + 0x4),
        maxCount: await read32(context, base + 0x6),
        inputSelect: await read16(context, base + 0x8),
        inputSelect2: await read16(context, base + 0xa),
        inputCondition: await read16(context, base + 0xb)
      };
    }))
  };
}

async function configureBus(context: EradContext, instance: number, reference: number): Promise<void> {
  const base = busBase(instance);
  await write32(context, base, 0);
  await write32(context, base + 0x2, reference);
  await write16(context, base + 0x6, 0x2); // VPC bus, equality, no halt, no interrupt.
}

async function configureRangeCounter(
  context: EradContext,
  instance: number,
  startEvent: number,
  endEvent: number,
  cumulative: boolean
): Promise<void> {
  const base = counterBase(instance);
  await write32(context, base + 0x2, 0xffff_ffff);
  await write16(context, base + 0x8, startEvent << 8);
  await write16(context, base + 0xa, endEvent);
  await write16(context, base + 0xb, 0);
  await write16(context, base, cumulative ? 0x104 : 0x4);
}

async function configureEventCounter(context: EradContext, instance: number, event: number): Promise<void> {
  const base = counterBase(instance);
  await write32(context, base + 0x2, 0xffff_ffff);
  await write16(context, base + 0x8, event);
  await write16(context, base + 0xa, 0);
  await write16(context, base + 0xb, 0);
  await write16(context, base, 0x800); // Rising-edge event count; no halt/interrupt/reset-on-match.
}

async function clearAndReset(context: EradContext, resources: EradResourceSelection): Promise<void> {
  await write16(context, busBase(resources.startBusComparator) + 0x4, 0x1);
  await write16(context, busBase(resources.endBusComparator) + 0x4, 0x1);
  let resetMask = 0;
  for (const counter of [resources.maxCounter, resources.cumulativeCounter, resources.eventCounter]) {
    await write16(context, counterBase(counter) + 0x9, 0x3);
    await write32(context, counterBase(counter) + 0x6, 0);
    resetMask |= 1 << (counter - 1);
  }
  await write16(context, GLOBAL_COUNTER_RESET, (await read16(context, GLOBAL_COUNTER_RESET)) | resetMask);
}

async function disableSelected(context: EradContext, resources: EradResourceSelection): Promise<void> {
  const current = await read16(context, GLOBAL_ENABLE);
  await write16(context, GLOBAL_ENABLE, current & ~selectedEnableMask(resources));
}

function selectedEnableMask(resources: EradResourceSelection): number {
  return busEnableBit(resources.startBusComparator) |
    busEnableBit(resources.endBusComparator) |
    counterEnableBit(resources.maxCounter) |
    counterEnableBit(resources.cumulativeCounter) |
    counterEnableBit(resources.eventCounter);
}

function busBase(instance: number): number {
  return BUS_BASE + (instance - 1) * 0x8;
}

function counterBase(instance: number): number {
  return COUNTER_BASE + (instance - 1) * 0x10;
}

function busEnableBit(instance: number): number {
  return 1 << (instance - 1);
}

function counterEnableBit(instance: number): number {
  return 1 << (7 + instance);
}

function read16(context: EradContext, address: number): Promise<number> {
  return context.manager.readMemory(context.sessionId, context.coreId, PAGE, address, 16);
}

function read32(context: EradContext, address: number): Promise<number> {
  return context.manager.readMemory(context.sessionId, context.coreId, PAGE, address, 32);
}

function write16(context: EradContext, address: number, value: number): Promise<void> {
  return context.manager.writeMemory(context.sessionId, context.coreId, PAGE, address, value & 0xffff, 16);
}

function write32(context: EradContext, address: number, value: number): Promise<void> {
  return context.manager.writeMemory(context.sessionId, context.coreId, PAGE, address, value >>> 0, 32);
}

function assertF28p65x(device: string): void {
  if (!isF28p65x(device)) {
    throw new DebugMcpError("EradDeviceUnsupported", "First-version ERAD profiling supports F28P65x only", {
      device,
      supportedDevices: ["F28P65x"]
    });
  }
}

function isF28p65x(device: string): boolean {
  return /F28P65/i.test(device);
}

function ownerName(owner: number): EradCapabilities["ownership"] {
  if (owner === OWNER_NONE) return "NO_OWNER";
  if (owner === OWNER_APPLICATION) return "APPLICATION";
  if (owner === OWNER_DEBUGGER) return "DEBUGGER";
  return "UNKNOWN";
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[]
    : [];
}

function key(context: Pick<EradContext, "sessionId" | "coreId">): string {
  return `${context.sessionId}:${context.coreId}`;
}
