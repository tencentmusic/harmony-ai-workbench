import assert from "node:assert/strict";
import test from "node:test";
import { isTimeRangeId, timeRangeStart } from "./time-range";

const now = new Date(2026, 9, 13, 15, 0, 0);

test("time ranges roll back from the given moment", () => {
  assert.equal(timeRangeStart("all", now), null);
  assert.equal(timeRangeStart("7d", now)?.toISOString(), new Date(2026, 9, 6, 15, 0, 0).toISOString());
  assert.equal(timeRangeStart("1m", now)?.toISOString(), new Date(2026, 8, 13, 15, 0, 0).toISOString());
  assert.equal(timeRangeStart("3m", now)?.toISOString(), new Date(2026, 6, 13, 15, 0, 0).toISOString());
  assert.equal(timeRangeStart("6m", now)?.toISOString(), new Date(2026, 3, 13, 15, 0, 0).toISOString());
  assert.equal(timeRangeStart("ytd", now)?.toISOString(), new Date(2026, 0, 1).toISOString());
  assert.equal(isTimeRangeId("7d"), true);
  assert.equal(isTimeRangeId("week"), false);
});
