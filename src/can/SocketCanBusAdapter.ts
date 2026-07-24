import type { CanAdapterInfo } from "./CanBusAdapter.js";
import { UnavailableCanBusAdapter } from "./UnavailableCanBusAdapter.js";

/**
 * Integration seam for a real SocketCAN bridge. It deliberately fails closed
 * in this repository because no host CAN library/device contract is bundled.
 * It never synthesizes frames, captures, or independent-verification claims.
 */
export class SocketCanBusAdapter extends UnavailableCanBusAdapter {
  readonly name = "socketcan-skeleton";
  readonly independentBusVerification = false;

  override info(): CanAdapterInfo {
    return {
      name: this.name,
      independentBusVerification: false,
      availability: "unavailable",
      transport: "hardware",
      reason: "SocketCAN integration seam is present, but no host CAN backend is configured"
    };
  }
}
