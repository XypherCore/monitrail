"use client";

import { useState } from "react";
import { formatAvailability, formatCoverage } from "../monitors/insight-format";
import type { AvailabilityDay } from "../monitors/insight-types";
import styles from "./monitor-history.module.css";

const utcDay = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

function dayState(value: number | null) {
  if (value === null) return { style: styles.unobserved, label: "No data" };
  if (value === 100) return { style: styles.available, label: "Available" };
  if (value >= 99) return { style: styles.partial, label: "Partial" };
  return { style: styles.unavailable, label: "Below 99%" };
}

function describeDay(day: AvailabilityDay) {
  const count = day.incidentCount;
  return `${dayState(day.percent).label} · ${formatAvailability(day.percent)} · Coverage ${formatCoverage(day.coverage)} · ${count} ${count === 1 ? "incident" : "incidents"}`;
}

export function AvailabilityBar({ days }: { days: AvailabilityDay[] }) {
  const [selection, setSelection] = useState<number>();
  const day = days.find((entry) => entry.start === selection) ?? days.at(-1);
  if (!day) return null;

  return (
    <>
      <div className={styles.days} aria-hidden="true">
        {days.map((entry) => (
          <span
            key={entry.start}
            className={dayState(entry.percent).style}
            data-selected={entry.start === day.start || undefined}
            title={`${utcDay.format(entry.start)} UTC · ${describeDay(entry)}`}
          />
        ))}
      </div>
      <div className={styles.dayDetail}>
        <label>
          <span>Day (UTC)</span>
          <select
            value={day.start}
            onChange={(event) => setSelection(Number(event.target.value))}
          >
            {[...days].reverse().map((entry) => (
              <option value={entry.start} key={entry.start}>
                {utcDay.format(entry.start)}
              </option>
            ))}
          </select>
        </label>
        <p aria-live="polite">{describeDay(day)}</p>
      </div>
    </>
  );
}
