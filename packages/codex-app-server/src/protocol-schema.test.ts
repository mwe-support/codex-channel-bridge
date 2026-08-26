import assert from "node:assert/strict";
import test from "node:test";

import {
  assessProtocolSchema,
  CodexProtocolProbeError,
  PINNED_CODEX_VERSION,
  PINNED_STABLE_SCHEMA_SHA256,
  REQUIRED_STABLE_METHODS
} from "./protocol-schema.js";

function schemaWith(methods: readonly string[]): unknown {
  return {
    oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } }))
  };
}

test("marks the pinned version and schema as tested", () => {
  const result = assessProtocolSchema(
    PINNED_CODEX_VERSION,
    schemaWith(REQUIRED_STABLE_METHODS),
    PINNED_STABLE_SCHEMA_SHA256
  );
  assert.equal(result.verification, "tested");
});

test("allows a newer compatible schema only as unverified", () => {
  const result = assessProtocolSchema("0.150.0", schemaWith(REQUIRED_STABLE_METHODS), "different");
  assert.equal(result.verification, "unverified");
});

test("fails closed when a required stable method is absent", () => {
  assert.throws(
    () => assessProtocolSchema(PINNED_CODEX_VERSION, schemaWith(["initialize"]), "different"),
    (error: unknown) => {
      assert(error instanceof CodexProtocolProbeError);
      assert.equal(error.reason, "incompatible_codex_protocol");
      return true;
    }
  );
});

test("rejects Codex versions below the declared minimum", () => {
  assert.throws(
    () => assessProtocolSchema("0.148.0", schemaWith(REQUIRED_STABLE_METHODS), "different"),
    (error: unknown) => {
      assert(error instanceof CodexProtocolProbeError);
      assert.equal(error.reason, "unsupported_codex_version");
      return true;
    }
  );
});
