"use client";

import { CartesianGrid, Line, LineChart, ReferenceArea, Tooltip, XAxis, YAxis } from "recharts";
import { formatResponseTime } from "../monitors/insight-format";
import type { LatencyBucket, MonitorRange, TimeSpan } from "../monitors/insight-types";
import styles from "./monitor-history.module.css";

const shortDay = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const shortTime = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const bucketDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function BucketTooltip({ bucket }: { bucket: LatencyBucket }) {
  return (
    <div className={styles.tooltip}>
      <strong>{bucketDate.format(bucket.start)} UTC</strong>
      {bucket.samples === 0 ? (
        <p>No data</p>
      ) : (
        <>
          <p>Average {formatResponseTime(bucket.averageMs)}</p>
          <p>p95 {formatResponseTime(bucket.p95Ms)}</p>
          <p>{bucket.samples} {bucket.samples === 1 ? "sample" : "samples"}</p>
        </>
      )}
    </div>
  );
}

export function ResponseChart({
  buckets,
  window,
  incidentBands,
  range,
}: {
  buckets: LatencyBucket[];
  window: TimeSpan;
  incidentBands: TimeSpan[];
  range: MonitorRange;
}) {
  if (buckets.filter((bucket) => bucket.samples > 0).length < 2) {
    return <p className={styles.chartEmpty}>At least two data points are needed to show the chart.</p>;
  }

  return (
    <figure className={styles.figure} aria-label="Response time chart">
      <LineChart
        className={styles.chart}
        responsive
        data={buckets}
        margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          type="number"
          dataKey="start"
          scale="time"
          domain={[window.start, window.end]}
          tickFormatter={(value: number) => (range === "24h" ? shortTime : shortDay).format(value)}
          tickCount={4}
          minTickGap={24}
          tickLine={false}
          stroke="var(--muted)"
          tick={{ fontSize: 11 }}
        />
        <YAxis
          width={44}
          tickCount={4}
          tickLine={false}
          stroke="var(--muted)"
          tick={{ fontSize: 11 }}
          domain={[0, "auto"]}
        />
        {incidentBands.map((band) => (
          <ReferenceArea
            key={`${band.start}-${band.end}`}
            x1={band.start}
            x2={band.end}
            fill="var(--down)"
            fillOpacity={0.16}
            stroke="none"
          />
        ))}
        <Tooltip
          filterNull={false}
          isAnimationActive={false}
          content={({ active, label }) => {
            if (!active || typeof label !== "number") return null;
            const bucket = buckets.find((entry) => entry.start === label);
            return bucket ? <BucketTooltip bucket={bucket} /> : null;
          }}
        />
        <Line
          dataKey="averageMs"
          name="Average"
          stroke="var(--muted)"
          strokeWidth={2}
          connectNulls={false}
          dot={{ r: 2, fill: "var(--muted)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
        <Line
          dataKey="p95Ms"
          name="p95"
          stroke="var(--text)"
          strokeDasharray="4 3"
          connectNulls={false}
          dot={{ r: 2, fill: "var(--text)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
      <figcaption className={styles.legend}>
        <span>Average (ms)</span>
        <span>p95 (ms)</span>
        {incidentBands.length > 0 && <span className={styles.incidentLegend}>Confirmed incidents</span>}
        <span>UTC · Gaps mean no data</span>
      </figcaption>
    </figure>
  );
}
