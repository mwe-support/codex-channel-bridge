import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProtocolSchema,
  CodexProtocolProbeError,
  OPTIONAL_METHODS,
  REQUIRED_STABLE_METHODS
} from "./protocol-schema.js";

function schemaWith(methods: readonly string[]): unknown {
  return {
    oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } }))
  };
}

test("recognizes a historical tested snapshot without using it as an allowlist", () => {
  const result = assessProtocolSchema(
    "0.149.1",
    schemaWith(REQUIRED_STABLE_METHODS),
    "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9"
  );
  assert.equal(result.verification, "tested");
});

test("accepts capable schemas regardless of version labels and optional method promotion", () => {
  for (const version of ["0.148.0", "0.153.4", "1.0.0-beta.1", "unknown"]) {
    const result = assessProtocolSchema(version, schemaWith(REQUIRED_STABLE_METHODS), "different");
    assert.equal(result.verification, "unverified");
    assert.deepEqual(result.optionalMethods, []);
    const promoted = assessProtocolSchema(version,
      schemaWith([...REQUIRED_STABLE_METHODS, ...OPTIONAL_METHODS]), "different");
    assert.deepEqual(promoted.optionalMethods, OPTIONAL_METHODS);
  }
});

test("fails closed when a required stable method is absent", () => {
  assert.throws(
    () => assessProtocolSchema("0.153.4", schemaWith(["initialize"]), "different"),
    (error: unknown) => {
      assert(error instanceof CodexProtocolProbeError);
      assert.equal(error.reason, "incompatible_codex_protocol");
      return true;
    }
  );
});
