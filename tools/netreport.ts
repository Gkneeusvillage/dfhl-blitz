/**
 * Turning a bot's counters into the numbers this phase exists to produce.
 *
 * THE BANDWIDTH QUESTION, STATED HONESTLY: the design document quotes a snapshot
 * as "3-5 KB of JSON and rather less as msgpack" and leaves the second figure
 * unmeasured. JSON is easy to measure and is not what the socket carries;
 * msgpack is what the league's connections actually pay for. Both are reported
 * here, from the same frames, so the ratio is a measurement rather than a guess.
 *
 * THE COMPOSITION QUESTION: if the number turns out to be too high, the cheapest
 * fix is not delta encoding — it is noticing that a whole-state snapshot carries
 * `stats` (per-player counters that change a few times a match) and `seats`
 * (which change when somebody joins or drops) at 20 Hz alongside the twelve
 * skaters and the puck that actually move. `snapshotComposition` weighs exactly
 * that, using the SERVER'S OWN ENCODER (`getMessageBytes.raw`, the function
 * Colyseus calls inside `client.send`), so the saving quoted is the saving that
 * would be banked and not an estimate from a different library.
 */

import { Protocol, getMessageBytes } from '@colyseus/core';

import { SNAPSHOT_RATE, TICK_RATE } from '@dfhl/shared';
import type { GameSimState, SnapshotMessage } from '@dfhl/shared';

import type { BotReport } from './botclient.js';
import { framingOverheadBytes, type Tally } from './wiretap.js';

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Nearest-rank percentile. `p` is a fraction: 0.95 for p95. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function maxOf(values: number[]): number {
  let best = 0;
  for (const value of values) if (value > best) best = value;
  return best;
}

// ---------------------------------------------------------------------------
// Bandwidth
// ---------------------------------------------------------------------------

export interface DirectionSummary {
  frames: number;
  wireBytes: number;
  jsonBytes: number;
  framingBytes: number;
  wireKbPerSecond: number;
  jsonKbPerSecond: number;
  byType: Array<{ type: string } & Tally>;
}

export interface BandwidthSummary {
  seconds: number;
  down: DirectionSummary;
  up: DirectionSummary;
}

function summarizeDirection(
  total: Tally,
  byType: Map<string, Tally>,
  dropped: number,
  seconds: number,
  direction: 'sent' | 'received',
): DirectionSummary {
  // Framing is charged per frame at the mean payload size; the header only steps
  // at 126 bytes and 64 KB, so the mean picks the right bracket for every frame
  // in the run unless a run straddles a bracket, where the error is 2 bytes.
  const meanPayload = total.frames === 0 ? 0 : total.wireBytes / total.frames;
  const delivered = total.frames - dropped;
  return {
    frames: total.frames,
    wireBytes: total.wireBytes,
    jsonBytes: total.jsonBytes,
    framingBytes: Math.round(delivered * framingOverheadBytes(direction, meanPayload)),
    wireKbPerSecond: total.wireBytes / 1024 / seconds,
    jsonKbPerSecond: total.jsonBytes / 1024 / seconds,
    byType: [...byType.entries()]
      .map(([type, tally]) => ({ type, ...tally }))
      .sort((a, b) => b.wireBytes - a.wireBytes),
  };
}

export function summarizeBandwidth(report: BotReport): BandwidthSummary {
  const seconds = report.wire.windowSeconds;
  return {
    seconds,
    down: summarizeDirection(
      report.wire.received.total,
      report.wire.received.byType,
      report.wire.received.dropped,
      seconds,
      'received',
    ),
    up: summarizeDirection(
      report.wire.sent.total,
      report.wire.sent.byType,
      report.wire.sent.dropped,
      seconds,
      'sent',
    ),
  };
}

export interface SnapshotComposition {
  wireBytes: number;
  jsonBytes: number;
  withoutStatsBytes: number;
  withoutStatsAndSeatsBytes: number;
  /** What removing `stats` from every snapshot would save, as a fraction. */
  statsShare: number;
  /** What removing `stats` and `seats` together would save. */
  staticShare: number;
  /** Projected downstream rate if the two rarely-changing blocks stopped riding along. */
  trimmedKbPerSecond: number;
}

function withoutFields(snapshot: SnapshotMessage, drop: Array<keyof GameSimState>): SnapshotMessage {
  const state = { ...snapshot.state } as Record<string, unknown>;
  for (const field of drop) delete state[field];
  return { ...snapshot, state: state as unknown as GameSimState };
}

function encodedSize(snapshot: SnapshotMessage): number {
  return getMessageBytes.raw(Protocol.ROOM_DATA, 'snapshot', snapshot).byteLength;
}

/**
 * Weigh one real snapshot, and what a trimmed one would weigh.
 *
 * Deliberately measured on the LAST snapshot of a match: `stats` is a map keyed
 * by player id whose entries are created up front, so its encoded size is stable,
 * but taking the biggest sample available keeps the estimate on the pessimistic
 * side of the truth.
 */
export function snapshotComposition(snapshot: SnapshotMessage): SnapshotComposition {
  const full = encodedSize(snapshot);
  const withoutStats = encodedSize(withoutFields(snapshot, ['stats']));
  const withoutBoth = encodedSize(withoutFields(snapshot, ['stats', 'seats']));

  return {
    wireBytes: full,
    jsonBytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
    withoutStatsBytes: withoutStats,
    withoutStatsAndSeatsBytes: withoutBoth,
    statsShare: full === 0 ? 0 : (full - withoutStats) / full,
    staticShare: full === 0 ? 0 : (full - withoutBoth) / full,
    trimmedKbPerSecond: (withoutBoth * SNAPSHOT_RATE) / 1024,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ft(value: number): string {
  return `${value.toFixed(3)} ft`;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function kbs(value: number): string {
  return `${value.toFixed(1)} KB/s`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderPrediction(report: BotReport): string[] {
  const p = report.prediction;
  const lines = [
    `  prediction error   mean ${ft(mean(p.errors))}  p50 ${ft(percentile(p.errors, 0.5))}` +
      `  p95 ${ft(percentile(p.errors, 0.95))}  max ${ft(maxOf(p.errors))}  (${p.errors.length} graded)`,
    `  reconcile snaps    ${p.snaps} past ${ft(6)} threshold` +
      `   control mismatches ${p.controlMismatches}`,
    `  prediction depth   mean ${mean(p.depths).toFixed(1)} ticks` +
      `  p95 ${percentile(p.depths, 0.95).toFixed(0)} ticks  max ${maxOf(p.depths).toFixed(0)} ticks`,
    `  replayed ticks     ${p.replayTicks}` +
      `   stalled ${p.stalledTicks}  ungraded ${p.ungraded}  history overruns ${p.historyOverruns}`,
  ];
  return lines;
}

export function renderStream(report: BotReport): string[] {
  const intervals = report.snapshotIntervalsMs;
  const rate = report.snapshots < 2 ? 0 : (report.snapshots - 1) / report.matchSeconds;
  return [
    `  snapshots          ${report.snapshots} in ${report.matchSeconds.toFixed(1)} s` +
      `  = ${rate.toFixed(2)} Hz (intended ${SNAPSHOT_RATE})`,
    `  arrival interval   mean ${ms(mean(intervals))}  p95 ${ms(percentile(intervals, 0.95))}` +
      `  max ${ms(maxOf(intervals))}`,
    `  RTT                mean ${ms(mean(report.rttMs))}  p95 ${ms(percentile(report.rttMs, 0.95))}` +
      `  (${report.rttMs.length} probes)`,
    `  inputs             ${report.inputsSent} sent` +
      `  = ${(report.inputsSent / Math.max(1e-3, report.matchSeconds)).toFixed(1)} /s (intended ${TICK_RATE})` +
      `  throttled ${report.throttledTicks}`,
  ];
}

export function renderBandwidth(report: BotReport): string[] {
  const summary = summarizeBandwidth(report);
  const lines: string[] = [
    `  down               ${kbs(summary.down.wireKbPerSecond)} on the wire (msgpack)` +
      `  vs ${kbs(summary.down.jsonKbPerSecond)} as raw JSON` +
      `  [${summary.down.frames} frames, +${(summary.down.framingBytes / 1024 / summary.seconds).toFixed(1)} KB/s ws framing]`,
    `  up                 ${kbs(summary.up.wireKbPerSecond)} on the wire (msgpack)` +
      `  vs ${kbs(summary.up.jsonKbPerSecond)} as raw JSON` +
      `  [${summary.up.frames} frames, +${(summary.up.framingBytes / 1024 / summary.seconds).toFixed(1)} KB/s ws framing]`,
  ];

  for (const entry of summary.down.byType.slice(0, 4)) {
    lines.push(
      `    down ${entry.type.padEnd(12)} ${entry.frames} frames` +
        `  ${(entry.wireBytes / entry.frames).toFixed(0)} B each` +
        `  ${(entry.wireBytes / 1024 / summary.seconds).toFixed(1)} KB/s`,
    );
  }
  for (const entry of summary.up.byType.slice(0, 3)) {
    lines.push(
      `    up   ${entry.type.padEnd(12)} ${entry.frames} frames` +
        `  ${(entry.wireBytes / entry.frames).toFixed(0)} B each` +
        `  ${(entry.wireBytes / 1024 / summary.seconds).toFixed(1)} KB/s`,
    );
  }

  const snapshot = report.lastSnapshot;
  if (snapshot !== null) {
    const composition = snapshotComposition(snapshot);
    lines.push(
      `  one snapshot       ${composition.wireBytes} B msgpack vs ${composition.jsonBytes} B JSON` +
        `  (msgpack is ${pct(composition.wireBytes / composition.jsonBytes)} of JSON)`,
      `  if trimmed         ${composition.withoutStatsBytes} B without stats` +
        ` (${pct(composition.statsShare)} off),` +
        ` ${composition.withoutStatsAndSeatsBytes} B without stats+seats` +
        ` (${pct(composition.staticShare)} off) = ${kbs(composition.trimmedKbPerSecond)} down`,
    );
  }
  return lines;
}

export function renderBot(report: BotReport): string[] {
  const events = [...report.eventCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
    .join(', ');
  return [
    `${report.nickname} (${report.side ?? '?'}, ${report.teamCode ?? 'no team'}, seat ${report.seatId})`,
    ...renderStream(report),
    ...renderPrediction(report),
    ...renderBandwidth(report),
    `  events seen        ${events.length === 0 ? 'none' : events}`,
  ];
}

export function renderScoreByPeriod(scores: Map<number, { home: number; away: number }>): string {
  return [...scores.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([period, score]) => `P${period} ${score.home}-${score.away}`)
    .join('  ');
}
