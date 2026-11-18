#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveTokenAppScopeIds } from "../src/features/admin-console/lib/tokenAppScopeDisplay.ts";

assert.deepEqual(resolveTokenAppScopeIds(["kugou", "live"], []), ["kugou", "live"]);
assert.deepEqual(resolveTokenAppScopeIds(["kugou", "live"], ["kugou", "live"]), ["kugou", "live"]);
assert.deepEqual(resolveTokenAppScopeIds(["kugou", "gone"], ["kugou"]), ["kugou"]);
assert.deepEqual(resolveTokenAppScopeIds([], ["kugou"]), []);
assert.deepEqual(resolveTokenAppScopeIds(undefined, ["kugou"]), []);
assert.deepEqual(resolveTokenAppScopeIds(["  kugou  ", ""], ["kugou"]), ["kugou"]);

console.log("test-token-app-scope-display: ok");
