import { parse } from "@std/jsonc";

/** Reads and validates a package version from JSONC configuration text. */
export function packageVersionFromJsonc(text: string): string {
  const config: unknown = parse(text);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("package configuration must be a JSON object");
  }

  const version = (config as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError(
      "package configuration must define a non-empty version string",
    );
  }
  return version;
}

if (import.meta.main) {
  const configUrl = new URL("../deno.jsonc", import.meta.url);
  console.log(packageVersionFromJsonc(await Deno.readTextFile(configUrl)));
}
