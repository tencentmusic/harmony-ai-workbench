"use client";

import { TIME_RANGES, type TimeRangeId } from "@/contracts/time-range";
import styles from "./TimeRangeTabs.module.css";

export function TimeRangeTabs({
  value,
  onChange,
}: {
  value: TimeRangeId;
  onChange: (value: TimeRangeId) => void;
}) {
  return (
    <div className={styles.ranges} role="tablist" aria-label="时间范围">
      {TIME_RANGES.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
