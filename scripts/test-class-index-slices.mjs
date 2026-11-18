#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceAppsConfig } from "../src/lib/workspace-apps-config.ts";
import {
  describeClassIndexSlices,
  mergeClassIndexSlices,
  planClassIndexSlices,
} from "../src/lib/class-index-slices.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(__dirname, ".."));

const config = loadWorkspaceAppsConfig({ reload: true });

assert.deepEqual(planClassIndexSlices({ id: "android-monorepo", source_id: "android-monorepo", platform: "android" }, config), [
  { kind: "main_android" },
]);
assert.deepEqual(planClassIndexSlices({ id: "fanxingallinone-music", source_id: "android-monorepo", platform: "android", path_suffix: "fanxingallinone" }, config), [
  { kind: "main_android", pathPrefix: "fanxingallinone" },
]);
assert.deepEqual(planClassIndexSlices({ id: "android-live", source_id: "android-live", platform: "android" }, config), [
  { kind: "android_scope", scopeId: "KugouLive" },
]);
assert.deepEqual(planClassIndexSlices({ id: "harmony-music", source_id: "harmony-music", platform: "harmony" }, config), [
  { kind: "harmony_scope", scopeId: "KugouPlayer" },
]);
assert.deepEqual(planClassIndexSlices({ id: "harmony-live", source_id: "harmony-live", platform: "harmony" }, config), [
  { kind: "harmony_scope", scopeId: "KugouLive" },
]);
assert.deepEqual(planClassIndexSlices({ id: "kugou-harmony-ai-workbench", source_id: "workspace", platform: "workspace" }, config), []);
assert.deepEqual(planClassIndexSlices({ id: "fxwiki", source_id: "fxwiki", platform: "knowledge" }, config), []);

assert.deepEqual(
  mergeClassIndexSlices([
    { kind: "main_android", pathPrefix: "fanxingallinone" },
    { kind: "main_android" },
    { kind: "android_scope", scopeId: "KugouLive" },
    { kind: "android_scope", scopeId: "KugouLive" },
  ]),
  [{ kind: "main_android" }, { kind: "android_scope", scopeId: "KugouLive" }],
);

assert.equal(describeClassIndexSlices([{ kind: "main_android" }]), "Android 大仓");
assert.equal(
  describeClassIndexSlices([{ kind: "harmony_scope", scopeId: "KugouPlayer" }]),
  "鸿蒙/KugouPlayer",
);

console.log("test-class-index-slices: ok");
