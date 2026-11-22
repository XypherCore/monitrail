import { isMonitorId } from "../monitors/input.ts";
import type { DogfoodEvidence } from "../services/dogfood-evidence.ts";

const DAY = 86_400_000;
const SLOT = 300_000;
const GRACE = 60_000;
const DAYS = 14;
const MAX_ROWS = 500_000;
type StateEvent = DogfoodEvidence["events"][number];
type Check = DogfoodEvidence["checks"][number];
type Incident = DogfoodEvidence["incidents"][number];
type Status = "passed" | "failed" | "incomplete";
export type DogfoodIncidentReview = { incidentId: string; verdict: "real" | "false" | "unresolved" };
export type DogfoodProofManifest = {
  version: 1;
  startAt: string;
  monitors: { id: string; configRev: number; intervalSeconds: 300 }[];
  configChanges?: { id: string; monitorId: string; at: string }[];
};
export type DogfoodProofInput = {
  manifest: DogfoodProofManifest;
  asOf: string;
  snapshots: DogfoodEvidence[];
  reviews: DogfoodIncidentReview[];
};
export type ProofCount = {
  expected: number; received: number; missed: number; excluded: number;
  firstMissedSlotAt: string | null; status: Status;
};
export type DogfoodProofReport = {
  version: 1; startAt: string; asOf: string; requiredThrough: string;
  status: Status | "restart_required"; completedDays: number; reasons: string[];
  days: {
    day: number; startAt: string; endAt: string; cutoffAt: string; matured: boolean; status: Status;
    monitors: (ProofCount & { monitorId: string })[]; fleet: ProofCount;
  }[];
  incidentReviews: { incidentId: string; monitorId: string; verdict: "real" | "false" | "unresolved" }[];
};

function invalid(): never { throw new Error("Dogfood proof inputs are invalid."); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return row;
}
function list(value: unknown, max = MAX_ROWS): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") return invalid(); return value; }
function uuid(value: unknown): string { if (!isMonitorId(value)) return invalid(); return (value as string).toLowerCase(); }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalid();
  const iso = parsed.toISOString();
  if (iso !== value && iso.replace(".000Z", "Z") !== value) return invalid();
  return iso;
}
function optionalTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalid();
  return value as T;
}
const errors = ["dns", "timeout", "tls", "connect", "bad_status", "blocked", "other"] as const;
const resolutions = ["recovered", "paused", "config_changed", "blocked"] as const;
const eventKinds = ["created", "paused", "resumed", "config_changed", "blocked"] as const;

function validate(value: unknown): DogfoodProofInput {
  const input = object(value, ["manifest", "asOf", "snapshots", "reviews"]);
  const source = object(input.manifest, ["version", "startAt", "monitors"], ["configChanges"]);
  if (source.version !== 1) return invalid();
  const monitors = list(source.monitors, 2).map(value => {
    const row = object(value, ["id", "configRev", "intervalSeconds"]);
    if (row.intervalSeconds !== 300) return invalid();
    return { id: uuid(row.id), configRev: integer(row.configRev, 1), intervalSeconds: 300 as const };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (monitors.length !== 2 || monitors[0].id === monitors[1].id) return invalid();
  const selected = new Set(monitors.map(monitor => monitor.id));
  const selectedId = (value: unknown) => { const id = uuid(value); if (!selected.has(id)) return invalid(); return id; };
  const startAt = timestamp(source.startAt);
  const asOf = timestamp(input.asOf);
  if (Date.parse(asOf) < Date.parse(startAt)) return invalid();
  const configChanges = source.configChanges === undefined ? undefined : list(source.configChanges, 20_000).map(value => {
    const row = object(value, ["id", "monitorId", "at"]);
    const at = timestamp(row.at);
    if (Date.parse(at) > Date.parse(asOf)) return invalid();
    return { id: uuid(row.id), monitorId: selectedId(row.monitorId), at };
  });
  if (configChanges && new Set(configChanges.map(change => change.id)).size !== configChanges.length) return invalid();
  const snapshots = list(input.snapshots, 128).map(value => {
    const data = object(value, ["version", "from", "to", "capturedAt", "missingAcceptanceEvidence", "monitors", "checks", "events", "incidents"]);
    if (data.version !== 1) return invalid();
    const from = timestamp(data.from), to = timestamp(data.to), capturedAt = timestamp(data.capturedAt);
    if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > DAYS * DAY || Date.parse(to) > Date.parse(capturedAt) || Date.parse(capturedAt) > Date.parse(asOf)) return invalid();
    const monitors = list(data.monitors, 2).map(value => {
      const row = object(value, ["id", "configRev", "intervalSeconds", "isPaused", "createdAt"]);
      const createdAt = timestamp(row.createdAt);
      if (Date.parse(createdAt) > Date.parse(capturedAt)) return invalid();
      return { id: selectedId(row.id), configRev: integer(row.configRev, 1), intervalSeconds: integer(row.intervalSeconds, 1), isPaused: boolean(row.isPaused), createdAt };
    });
    if (!monitors.length || new Set(monitors.map(monitor => monitor.id)).size !== monitors.length) return invalid();
    const present = new Set(monitors.map(monitor => monitor.id));
    const presentId = (value: unknown) => { const id = selectedId(value); if (!present.has(id)) return invalid(); return id; };
    const inWindow = (at: string) => Date.parse(at) >= Date.parse(from) && Date.parse(at) < Date.parse(to);
    const checks = list(data.checks).map(value => {
      const row = object(value, ["attemptId", "monitorId", "configRev", "checkedAt", "acceptedAt", "ok", "statusCode", "responseMs", "errorType", "redirectCount"]);
      const checkedAt = timestamp(row.checkedAt), acceptedAt = optionalTimestamp(row.acceptedAt);
      if (Date.parse(checkedAt) > Date.parse(capturedAt) || (acceptedAt !== null && (Date.parse(acceptedAt) > Date.parse(capturedAt) || Date.parse(acceptedAt) < Date.parse(checkedAt))) || (!inWindow(checkedAt) && !(acceptedAt && inWindow(acceptedAt)))) return invalid();
      return { attemptId: uuid(row.attemptId), monitorId: presentId(row.monitorId), configRev: integer(row.configRev, 1), checkedAt, acceptedAt,
        ok: boolean(row.ok), statusCode: row.statusCode === null ? null : integer(row.statusCode, 100, 599),
        responseMs: row.responseMs === null ? null : integer(row.responseMs), errorType: row.errorType === null ? null : member(row.errorType, errors), redirectCount: integer(row.redirectCount, 0, 2) };
    });
    const missingAcceptanceEvidence = integer(data.missingAcceptanceEvidence);
    if (missingAcceptanceEvidence !== checks.filter(check => check.acceptedAt === null).length) return invalid();
    const events = list(data.events, 100_000).map(value => {
      const row = object(value, ["id", "monitorId", "kind", "at"]);
      const at = timestamp(row.at), kind = member(row.kind, eventKinds);
      if (Date.parse(at) >= Date.parse(to) || (kind === "config_changed" && !inWindow(at))) return invalid();
      return { id: uuid(row.id), monitorId: presentId(row.monitorId), kind, at };
    });
    const incidents = list(data.incidents, 30_000).map(value => {
      const row = object(value, ["id", "monitorId", "startedAt", "confirmedAt", "resolvedAt", "resolvedConfirmedAt", "resolvedReason", "cause"]);
      const startedAt = timestamp(row.startedAt), confirmedAt = timestamp(row.confirmedAt), resolvedAt = optionalTimestamp(row.resolvedAt), resolvedConfirmedAt = optionalTimestamp(row.resolvedConfirmedAt);
      if (Date.parse(startedAt) > Date.parse(confirmedAt) || Date.parse(confirmedAt) > Date.parse(capturedAt) || Date.parse(startedAt) >= Date.parse(to) || (resolvedAt !== null && (Date.parse(resolvedAt) < Date.parse(startedAt) || Date.parse(resolvedAt) < Date.parse(from) || Date.parse(resolvedAt) > Date.parse(capturedAt))) || (resolvedConfirmedAt !== null && (resolvedAt === null || Date.parse(resolvedConfirmedAt) < Date.parse(resolvedAt) || Date.parse(resolvedConfirmedAt) > Date.parse(capturedAt)))) return invalid();
      const resolvedReason = row.resolvedReason === null ? null : member(row.resolvedReason, resolutions);
      if ((resolvedAt === null) !== (resolvedReason === null)) return invalid();
      return { id: uuid(row.id), monitorId: presentId(row.monitorId), startedAt, confirmedAt, resolvedAt, resolvedConfirmedAt, resolvedReason, cause: member(row.cause, errors) };
    });
    return { version: 1 as const, from, to, capturedAt, missingAcceptanceEvidence, monitors, checks, events, incidents };
  });
  if (!snapshots.length || snapshots.reduce((sum, snapshot) => sum + snapshot.checks.length + snapshot.events.length + snapshot.incidents.length, 0) > MAX_ROWS) return invalid();
  const reviews = list(input.reviews, 30_000).map(value => {
    const row = object(value, ["incidentId", "verdict"]);
    return { incidentId: uuid(row.incidentId), verdict: member(row.verdict, ["real", "false", "unresolved"] as const) };
  });
  if (new Set(reviews.map(review => review.incidentId)).size !== reviews.length) return invalid();
  return { manifest: { version: 1, startAt, monitors, ...(configChanges === undefined ? {} : { configChanges }) }, asOf, snapshots, reviews };
}

function bound(values: number[], value: number, inclusive: boolean): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value || (inclusive && values[middle] === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}
function covers(windows: [number, number][], from: number, through: number): boolean {
  let cursor = from;
  for (const [start, end] of windows) {
    if (end <= cursor) continue;
    if (start > cursor) return false;
    cursor = end;
    // Source windows are half-open, while a receipt at the cutoff counts.
    if (cursor > through) return true;
  }
  return false;
}
function paused(kind: StateEvent["kind"]): boolean { return kind === "paused" || kind === "blocked"; }

/** Deterministic offline assessment. It never substitutes observation times for server receipts. */
export function scoreDogfoodProof(value: unknown): DogfoodProofReport {
  const input = validate(value);
  const { manifest, snapshots } = input;
  const start = Date.parse(manifest.startAt), asOf = Date.parse(input.asOf), end = start + DAYS * DAY;
  const reasons = new Set<string>();
  const conflictedMonitors = new Set<string>();
  const checks = new Map<string, Check>(), events = new Map<string, StateEvent>();
  const incidents = new Map<string, Incident>();
  const incidentCapturedAt = new Map<string, number>();
  const conflict = (...ids: string[]) => { reasons.add("conflicting_evidence"); for (const id of ids) conflictedMonitors.add(id); };
  for (const snapshot of snapshots) {
    for (const check of snapshot.checks) {
      const old = checks.get(check.attemptId);
      if (!old) checks.set(check.attemptId, check);
      else if (JSON.stringify({ ...old, acceptedAt: null }) !== JSON.stringify({ ...check, acceptedAt: null }) || (old.acceptedAt !== null && check.acceptedAt !== null && old.acceptedAt !== check.acceptedAt)) conflict(old.monitorId, check.monitorId);
      else if (old.acceptedAt === null && check.acceptedAt !== null) checks.set(check.attemptId, check);
    }
    for (const event of snapshot.events) {
      const old = events.get(event.id);
      if (old && JSON.stringify(old) !== JSON.stringify(event)) conflict(old.monitorId, event.monitorId);
      else events.set(event.id, event);
    }
    for (const incident of snapshot.incidents) {
      const old = incidents.get(incident.id);
      const captured = Date.parse(snapshot.capturedAt);
      if (!old) { incidents.set(incident.id, incident); incidentCapturedAt.set(incident.id, captured); }
      else {
        const immutable = (row: Incident) => JSON.stringify({ id: row.id, monitorId: row.monitorId, startedAt: row.startedAt, confirmedAt: row.confirmedAt, cause: row.cause });
        const previousCapture = incidentCapturedAt.get(incident.id) ?? captured;
        const reopened = (old.resolvedAt !== null && incident.resolvedAt === null && captured >= previousCapture) || (old.resolvedAt === null && incident.resolvedAt !== null && previousCapture >= captured);
        if (immutable(old) !== immutable(incident) || reopened || (["resolvedAt", "resolvedConfirmedAt", "resolvedReason"] as const).some(key => old[key] !== null && incident[key] !== null && old[key] !== incident[key])) conflict(old.monitorId, incident.monitorId);
        else incidents.set(incident.id, { ...old, resolvedAt: old.resolvedAt ?? incident.resolvedAt, resolvedConfirmedAt: old.resolvedConfirmedAt ?? incident.resolvedConfirmedAt, resolvedReason: old.resolvedReason ?? incident.resolvedReason });
        incidentCapturedAt.set(incident.id, Math.max(previousCapture, captured));
      }
    }
  }
  const allEvents = [...events.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const restart = allEvents.some(event => event.kind === "config_changed" && Date.parse(event.at) >= start && Date.parse(event.at) <= Math.min(asOf, end)) || (manifest.configChanges ?? []).some(change => Date.parse(change.at) >= start && Date.parse(change.at) <= Math.min(asOf, end));
  let restartRequired = restart;
  if (restart) reasons.add("configuration_changed");
  const countDays = Math.min(DAYS, Math.max(1, Math.ceil((asOf - start) / DAY)));
  const days: DogfoodProofReport["days"] = Array.from({ length: countDays }, (_, index) => ({
    day: index + 1, startAt: new Date(start + index * DAY).toISOString(), endAt: new Date(start + (index + 1) * DAY).toISOString(),
    cutoffAt: new Date(start + (index + 1) * DAY + GRACE).toISOString(), matured: asOf > start + (index + 1) * DAY + GRACE,
    status: "incomplete", monitors: [], fleet: { expected: 0, received: 0, missed: 0, excluded: 0, firstMissedSlotAt: null, status: "incomplete" },
  }));
  for (const baseline of manifest.monitors) {
    let reliable = !conflictedMonitors.has(baseline.id);
    const ownEvents = allEvents.filter(event => event.monitorId === baseline.id);
    const stateEvents = ownEvents.filter(event => event.kind !== "config_changed");
    const anchors = stateEvents.filter(event => Date.parse(event.at) <= start);
    const anchor = anchors.at(-1);
    if (!anchor) { reliable = false; reasons.add("missing_pause_anchor"); }
    else if (paused(anchor.kind)) { reliable = false; reasons.add("baseline_not_active"); }
    for (let index = 1; index < stateEvents.length; index++) {
      if (stateEvents[index].at === stateEvents[index - 1].at && paused(stateEvents[index].kind) !== paused(stateEvents[index - 1].kind)) { reliable = false; reasons.add("ambiguous_lifecycle_history"); }
    }
    const bumps = ownEvents.filter(event => event.kind !== "created" && event.kind !== "config_changed" && Date.parse(event.at) > start).map(event => Date.parse(event.at));
    const knownRevision = (revision: number, at: number) => revision >= baseline.configRev + bound(bumps, at, false) && revision <= baseline.configRev + bound(bumps, at, true);
    const windows: [number, number][] = [];
    const created = new Set<string>();
    for (const snapshot of snapshots) {
      const monitor = snapshot.monitors.find(row => row.id === baseline.id);
      if (!monitor) continue;
      windows.push([Date.parse(snapshot.from), Date.parse(snapshot.to)]);
      created.add(monitor.createdAt);
      if (Date.parse(snapshot.capturedAt) < start) continue;
      if (monitor.intervalSeconds !== 300) { restartRequired = true; reasons.add("configuration_changed"); }
      if (Date.parse(monitor.createdAt) > start) { reliable = false; reasons.add("baseline_not_active"); }
      if (!knownRevision(monitor.configRev, Date.parse(snapshot.capturedAt))) { reliable = false; reasons.add("unexplained_configuration_revision"); }
      const atCapture = stateEvents.filter(event => Date.parse(event.at) <= Date.parse(snapshot.capturedAt)).at(-1);
      if (atCapture && paused(atCapture.kind) !== monitor.isPaused) { reliable = false; reasons.add("pause_state_mismatch"); }
    }
    if (created.size > 1) { reliable = false; reasons.add("conflicting_evidence"); }
    windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const spans: [number, number][] = [];
    let pauseStart: number | null = null;
    for (const event of stateEvents) {
      const at = Date.parse(event.at);
      if (at <= start || at > Math.min(asOf, end)) continue;
      if (event.kind === "created") { reliable = false; reasons.add("ambiguous_lifecycle_history"); }
      if (paused(event.kind)) pauseStart ??= at;
      else if (pauseStart !== null) { spans.push([pauseStart, at]); pauseStart = null; }
    }
    if (pauseStart !== null) spans.push([pauseStart, Math.min(asOf, end)]);
    const relevantChecks = [...checks.values()].filter(check => check.monitorId === baseline.id);
    const receipts: { at: number; attemptId: string }[] = [];
    for (const check of relevantChecks) {
      if (check.acceptedAt === null) {
        // Accepted observations are bounded by the existing 120-second lease.
        if (Date.parse(check.checkedAt) >= start - 120_000 && Date.parse(check.checkedAt) <= Math.min(asOf, end + GRACE)) { reliable = false; reasons.add("missing_acceptance_evidence"); }
        continue;
      }
      const at = Date.parse(check.acceptedAt);
      if (at < start || at > Math.min(asOf, end + GRACE)) continue;
      if (!knownRevision(check.configRev, at)) { reliable = false; reasons.add("unexplained_configuration_revision"); }
      receipts.push({ at, attemptId: check.attemptId });
    }
    receipts.sort((a, b) => a.at - b.at || a.attemptId.localeCompare(b.attemptId));
    const activeSlots: { at: number; deadline: number; day: number; filled: boolean }[] = [];
    const excluded = Array<number>(countDays).fill(0);
    let spanIndex = 0;
    for (let index = 0; index < DAYS * 288; index++) {
      const at = start + index * SLOT, deadline = at + SLOT + GRACE, day = Math.floor(index / 288);
      if (deadline >= asOf || day >= countDays) continue;
      while (spanIndex < spans.length && spans[spanIndex][1] <= at) spanIndex++;
      const span = spans[spanIndex];
      if (span && span[0] < at + SLOT && span[1] > at) excluded[day]++;
      else activeSlots.push({ at, deadline, day, filled: false });
    }
    let cursor = 0;
    for (const receipt of receipts) {
      while (cursor < activeSlots.length && activeSlots[cursor].deadline < receipt.at) cursor++;
      const slot = activeSlots[cursor];
      if (slot && slot.at <= receipt.at) { slot.filled = true; cursor++; }
    }
    for (const [index, day] of days.entries()) {
      const slots = activeSlots.filter(slot => slot.day === index);
      const expected = slots.length, received = slots.filter(slot => slot.filled).length, missed = expected - received;
      const complete = reliable && covers(windows, Date.parse(day.startAt), Math.min(Date.parse(day.cutoffAt), asOf - 1));
      if (!complete && reliable && day.matured) reasons.add("evidence_window_gap");
      if (!expected && day.matured) reasons.add("zero_expected_slots");
      const status: Status = !day.matured || !complete || !expected ? "incomplete" : missed * 100 < expected ? "passed" : "failed";
      if (status === "failed") reasons.add("missed_check_threshold");
      const firstMissed = slots.find(slot => !slot.filled);
      day.monitors.push({ monitorId: baseline.id, expected, received, missed, excluded: excluded[index], firstMissedSlotAt: firstMissed ? new Date(firstMissed.at).toISOString() : null, status });
    }
  }
  for (const day of days) {
    const totals = day.monitors.reduce((sum, monitor) => ({ expected: sum.expected + monitor.expected, received: sum.received + monitor.received, missed: sum.missed + monitor.missed, excluded: sum.excluded + monitor.excluded }), { expected: 0, received: 0, missed: 0, excluded: 0 });
    const firstMissed = day.monitors.map(monitor => monitor.firstMissedSlotAt).filter((at): at is string => at !== null).sort()[0] ?? null;
    const status: Status = !day.matured || day.monitors.some(monitor => monitor.status === "incomplete") || !totals.expected ? "incomplete" : totals.missed * 100 < totals.expected ? "passed" : "failed";
    day.fleet = { ...totals, firstMissedSlotAt: firstMissed, status };
    day.status = day.monitors.some(monitor => monitor.status === "failed") || status === "failed" ? "failed" : day.monitors.every(monitor => monitor.status === "passed") && status === "passed" ? "passed" : "incomplete";
  }
  const reviews = new Map(input.reviews.map(review => [review.incidentId, review.verdict]));
  const incidentReviews = [...incidents.values()].filter(incident => Date.parse(incident.startedAt) < Math.min(asOf, end) && (incident.resolvedAt === null || Date.parse(incident.resolvedAt) >= start)).sort((a, b) => a.id.localeCompare(b.id)).map(incident => ({ incidentId: incident.id, monitorId: incident.monitorId, verdict: reviews.get(incident.id) ?? "unresolved" as const }));
  if (incidentReviews.some(review => review.verdict === "unresolved")) reasons.add("unreviewed_incident");
  if (incidentReviews.some(review => review.verdict === "false")) reasons.add("false_incident");
  const completedDays = days.filter(day => day.matured).length;
  if (completedDays < DAYS) reasons.add("proof_period_not_elapsed");
  const failed = days.some(day => day.status === "failed") || reasons.has("false_incident");
  const incomplete = completedDays < DAYS || days.some(day => day.status === "incomplete") || reasons.has("unreviewed_incident") || reasons.has("conflicting_evidence");
  return { version: 1, startAt: manifest.startAt, asOf: input.asOf, requiredThrough: new Date(end + GRACE).toISOString(), status: restartRequired ? "restart_required" : failed ? "failed" : incomplete ? "incomplete" : "passed", completedDays, reasons: [...reasons].sort(), days, incidentReviews };
}
