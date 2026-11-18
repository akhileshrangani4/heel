import manifest from "../package.json" with { type: "json" };

/** heel's version, from package.json; reported by the admin socket's `ping`. */
export const HEEL_VERSION: string = manifest.version;
