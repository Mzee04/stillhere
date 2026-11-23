import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvContent } from "../src/env.mjs";

test("parseEnvContent keeps equals signs inside quoted values and strips comments", () => {
  const parsed = parseEnvContent(`
# full line comment
export STILLHERE_AGENT_COMMAND="codex exec --flag=true --token=abc=def -"
STILLHERE_URL='http://127.0.0.1:4173/shop?ref=1'
UNQUOTED=hello # trailing comment
HASHY="value with # hash and = equals" # comment after quotes
EMPTY=
PLAIN=foo=bar
`);
  assert.equal(parsed.STILLHERE_AGENT_COMMAND, "codex exec --flag=true --token=abc=def -");
  assert.equal(parsed.STILLHERE_URL, "http://127.0.0.1:4173/shop?ref=1");
  assert.equal(parsed.UNQUOTED, "hello");
  assert.equal(parsed.HASHY, "value with # hash and = equals");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.PLAIN, "foo=bar");
  assert.equal(parsed["# full line comment"], undefined);
});

test("parseEnvContent unescapes double-quoted values", () => {
  const parsed = parseEnvContent(String.raw`GREETING="hello\nworld"`);
  assert.equal(parsed.GREETING, "hello\nworld");
});
