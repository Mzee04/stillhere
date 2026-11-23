import assert from "node:assert/strict";
import test from "node:test";
import { listenDemoServer } from "../server.mjs";

test("demo shop serves the home page", async (t) => {
  const { server, host } = await listenDemoServer({ port: 0 });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const { port } = server.address();
  const res = await fetch(`http://${host}:${port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>|<html/i);
});

test("malformed percent-encoding in the URL returns 404 without an unhandled rejection", async (t) => {
  const { server, host } = await listenDemoServer({ port: 0 });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const { port } = server.address();
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  for (const path of ["/%", "/%ZZ", "/%E0%A4%A"]) {
    const res = await fetch(`http://${host}:${port}${path}`);
    assert.equal(res.status, 404, path);
    await res.text();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rejections.length, 0, rejections[0]?.stack ?? rejections[0]?.message);
});
