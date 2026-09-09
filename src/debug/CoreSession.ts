import type { CoreConfig, CoreId, TargetStateName } from "./types.js";

export class CoreSession {
  readonly coreId: CoreId;
  readonly coreName: string;
  readonly corePattern?: string;
  connected = false;
  active = false;
  state: TargetStateName = "Disconnected";
  pc?: string;

  constructor(config: CoreConfig) {
    this.coreId = config.coreId;
    this.coreName = config.coreName;
    this.corePattern = config.corePattern;
  }
}
