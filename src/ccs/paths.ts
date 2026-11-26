import path from "node:path";

export function resolveXds100SerialPath(ccsInstallPath: string, platform: NodeJS.Platform = process.platform): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(ccsInstallPath, "ccs_base", "common", "uscif", platform === "win32" ? "xds100serial.exe" : "xds100serial");
}

export function resolveXdsdfuPath(ccsInstallPath: string, platform: NodeJS.Platform = process.platform): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    ccsInstallPath,
    "ccs_base",
    "common",
    "uscif",
    "xds110",
    platform === "win32" ? "xdsdfu.exe" : "xdsdfu"
  );
}

/** Resolve the CCS utility used to enumerate and identify XDS2xx probes. */
export function resolveXds2xxConfPath(ccsInstallPath: string, platform: NodeJS.Platform = process.platform): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    ccsInstallPath,
    "ccs_base",
    "common",
    "uscif",
    "xds2xx",
    platform === "win32" ? "xds2xx_conf.exe" : "xds2xx_conf"
  );
}
