import Link from "next/link";
import {
  formatAvailability,
  formatCoverage,
  formatResponseTime,
} from "../monitors/insight-format";
import { MONITOR_RANGES, type MonitorInsights, type MonitorRange } from "../monitors/insight-types";
import { AvailabilityBar } from "./availability-bar";
import styles from "./monitor-history.module.css";
import { ResponseChart } from "./response-chart";

export function MonitorHistory({
  insights,
  range,
  monitorId,
  incidentPage = 1,
}: {
  insights: MonitorInsights;
  range: MonitorRange;
  monitorId: string;
  incidentPage?: number;
}) {
  const { availability, latency } = insights;
  return (
    <section
      className={`section-panel ${styles.history}`}
      id="check-history"
      aria-labelledby="history-title"
    >
      <div className={styles.header}>
        <h2 id="history-title">Check history</h2>
        <nav className={styles.ranges} aria-label="Check history range">
          {(Object.keys(MONITOR_RANGES) as MonitorRange[]).map((value) => (
            <Link
              key={value}
              href={`/monitors/${monitorId}?range=${value}${incidentPage > 1 ? `&incidents=${incidentPage}` : ""}#check-history`}
              aria-current={value === range ? "page" : undefined}
              prefetch={false}
            >
              {MONITOR_RANGES[value].label}
            </Link>
          ))}
        </nav>
      </div>
      <dl className={styles.metrics}>
        <div>
          <dt>Availability</dt>
          <dd>{formatAvailability(availability.percent)}</dd>
          <dd className={styles.coverage}>Coverage {formatCoverage(availability.coverage)}</dd>
        </div>
        <div>
          <dt>Average response</dt>
          <dd>{formatResponseTime(latency.averageMs)}</dd>
        </div>
        <div>
          <dt>p95 response</dt>
          <dd>{formatResponseTime(latency.p95Ms)}</dd>
        </div>
      </dl>
      <div className={styles.section}>
        <h3>Response time</h3>
        <ResponseChart
          buckets={insights.buckets}
          window={insights.window}
          incidentBands={insights.incidentBands}
          range={range}
        />
      </div>
      <div className={styles.section}>
        <h3>Daily availability</h3>
        <AvailabilityBar days={insights.days} />
      </div>
    </section>
  );
}
