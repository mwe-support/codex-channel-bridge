import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  JsonlRpcClient,
  ProtocolFaultError,
  RpcResponseError
} from "./jsonl-rpc-client.js";

test("correlates a response with its request id", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(serverOutput, clientInput);
  const written = once(clientInput, "data");
  const response = client.request<{ ok: boolean }>("model/list", { limit: 10 });
  const [chunk] = await written;
  const request = JSON.parse(String(chunk)) as { id: number; method: string };
  assert.equal(request.method, "model/list");
  serverOutput.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  assert.deepEqual(await response, { ok: true });
  client.close();
});

test("surfaces JSON-RPC failures with the originating method", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(serverOutput, clientInput);
  const written = once(clientInput, "data");
  const response = client.request("thread/start", {});
  const [chunk] = await written;
  const request = JSON.parse(String(chunk)) as { id: number };
  serverOutput.write(
    `${JSON.stringify({ id: request.id, error: { code: -32601, message: "not found" } })}\n`
  );
  await assert.rejects(response, (error: unknown) => {
    assert(error instanceof RpcResponseError);
    assert.equal(error.requestMethod, "thread/start");
    return true;
  });
  client.close();
});

test("delivers server requests and writes their response", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(serverOutput, clientInput);
  const requestReceived = once(client, "serverRequest");
  serverOutput.write(`${JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} })}\n`);
  const [request] = await requestReceived;
  assert.equal(request.id, "approval-1");
  const written = once(clientInput, "data");
  await client.respond(request.id, { decision: "decline" });
  const [chunk] = await written;
  assert.deepEqual(JSON.parse(String(chunk)), {
    id: "approval-1",
    result: { decision: "decline" }
  });
  client.close();
});

test("treats non-JSON stdout as a protocol fault and rejects pending work", async () => {
  const serverOutput = new PassThrough();
  const clientInput = new PassThrough();
  const client = new JsonlRpcClient(serverOutput, clientInput);
  const faultReceived = once(client, "protocolFault");
  const response = client.request("initialize", {});
  serverOutput.write("operator log on stdout\n");
  const [fault] = await faultReceived;
  assert(fault instanceof ProtocolFaultError);
  await assert.rejects(response, ProtocolFaultError);
});
