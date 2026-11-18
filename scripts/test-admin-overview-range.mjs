#!/usr/bin/env node
import assert from "node:assert/strict";
import { telemetryWindowFromRange } from "../src/lib/admin-overview-range.ts";

const now = new Date("2026-09-21T12:00:00+08:00");

const last7d = telemetryWindowFromRange("last7d", now);
assert.equal(last7d.range, "last7d");
assert.equal(last7d.label, "近 7 天");
assert.equal(last7d.until, undefined);
assert.equal(new Date(last7d.since).getDate(), 15);

const thisMonth = telemetryWindowFromRange("thisMonth", now);
assert.equal(thisMonth.label, "本月");
assert.equal(thisMonth.until, undefined);
assert.equal(new Date(thisMonth.since).getMonth(), 8);
assert.equal(new Date(thisMonth.since).getDate(), 1);

const lastMonth = telemetryWindowFromRange("lastMonth", now);
assert.equal(lastMonth.label, "上月");
assert.ok(lastMonth.until);
assert.equal(new Date(lastMonth.since).getMonth(), 7);
assert.equal(new Date(lastMonth.until).getMonth(), 7);
assert.equal(new Date(lastMonth.until).getDate(), 31);

const all = telemetryWindowFromRange("all", now);
assert.equal(all.label, "累计");
assert.equal(all.until, undefined);
assert.equal(new Date(all.since).getTime(), 0);

console.log("test-admin-overview-range: ok");
