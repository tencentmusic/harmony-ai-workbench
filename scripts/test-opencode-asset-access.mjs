#!/usr/bin/env node
import assert from "node:assert/strict";

import { parseAndroidAppScopes } from "../src/lib/android-app-scopes.ts";
import { isOpencodeAssetAuthorized } from "../src/server/modules/opencode-assets/public.ts";

const scopes = parseAndroidAppScopes();
const live = scopes.find((scope) => scope.id === "KugouLive");
assert.ok(live?.workspaceAlias);
const livePrefix = live.prefixes.find((prefix) => prefix !== ".") || "app_fanxingv2";
const livePath = `${live.workspaceAlias}/${livePrefix}/src/main/res/drawable-xhdpi/example.png`;

assert.equal(isOpencodeAssetAuthorized({ path: livePath, allowedScopeIds: ["KugouLive"] }), true);
assert.equal(isOpencodeAssetAuthorized({ path: livePath, allowedScopeIds: ["KugouPlayer"] }), false);
assert.equal(isOpencodeAssetAuthorized({ path: "migration-cases/docs/example.png", allowedScopeIds: ["KugouPlayer"] }), true);
assert.equal(isOpencodeAssetAuthorized({
  path: "user-uploads/token-a/example.png",
  allowedScopeIds: [],
  tokenId: "token-a",
}), true);
assert.equal(isOpencodeAssetAuthorized({
  path: "user-uploads/token-b/example.png",
  allowedScopeIds: [],
  tokenId: "token-a",
}), false);
assert.equal(isOpencodeAssetAuthorized({ path: livePath.replace(/\.png$/, ".json"), allowedScopeIds: [] }), false);
assert.equal(isOpencodeAssetAuthorized({ path: `${live.workspaceAlias}/../secret.png`, allowedScopeIds: [] }), false);

console.log("test:opencode-asset-access OK");
