import { UnavailableCanBusAdapter } from "./UnavailableCanBusAdapter.js";

/** Explicit safe-default adapter name for deployments that have not integrated physical CAN I/O. */
export class NoopCanBusAdapter extends UnavailableCanBusAdapter {}
