import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { packageVersionFromJsonc } from "../scripts/package_version.ts";

Deno.test("package version reader supports JSONC", () => {
  assertEquals(
    packageVersionFromJsonc(`{
      // Release version
      "version": "1.2.3",
    }`),
    "1.2.3",
  );
});

Deno.test("package version reader rejects invalid configuration", () => {
  assertThrows(() => packageVersionFromJsonc("[]"), TypeError);
  assertThrows(() => packageVersionFromJsonc("{}"), TypeError);
  assertThrows(
    () => packageVersionFromJsonc('{ "version": "" }'),
    TypeError,
  );
});
