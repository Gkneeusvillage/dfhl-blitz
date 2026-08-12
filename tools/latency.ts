/**
 * What the link costs: the same match on a clean socket and on a bad one, side
 * by side.
 *
 *   npm run latency
 *   npm run latency -- --delay 250 --loss 0.05 --period-seconds 40
 *
 * A single impaired run tells you the netcode survived. Running both and
 * differencing them tells you what the impairment actually did, which is the
 * question worth asking — "p95 2.4 ft" means nothing until you know it was
 * 0.01 ft on a clean link.
 *
 * ---------------------------------------------------------------------------
 * READ `controlMismatches` BEFORE READING `max`
 *
 * Two different failures land in the same error metric and they are not equally
 * serious. Physics divergence is the client simulating the same skater to a
 * different place than the server did — that is a real desync and it should be
 * small. A control mismatch is the server handing this seat a DIFFERENT skater
 * than the client predicted, because the NHL'94-style auto-switch keys off which
 * skater is nearest the puck, and that depends on remote players whose input the
 * client does not have. When it happens, the error is measured between two
 * players standing far apart, so it reads as tens of feet while nothing has
 * desynced at all.
 *
 * So a large `max` next to a small `p95` and a non-zero `controlMismatches` is
 * the benign shape. A large `p95` is the alarming one.
 */

import { NETWORK } from '@dfhl/shared';

import { runBotMatch, type BotMatchResult } from './botmatch.js';
import { maxOf, mean, percentile } from './netreport.js';
import { CLEAN_LINK, type Impairment } from './wiretap.js';

interface Comparison {
  label: string;
  result: BotMatchResult;
  controlMismatches: number;
  errors: number[];
}

function collect(label: string, result: BotMatchResult): Comparison {
  return {
    label,
    result,
    controlMismatches: result.reports.reduce((sum, r) => sum + r.prediction.controlMismatches, 0),
    errors: result.reports.flatMap((r) => r.prediction.errors),
  };
}

function row(c: Comparison): string {
  const e = c.errors;
  return [
    c.label.padEnd(22),
    `${mean(e).toFixed(3)}`.padStart(8),
    `${percentile(e, 0.95).toFixed(2)}`.padStart(8),
    `${maxOf(e).toFixed(1)}`.padStart(8),
    `${c.result.snaps}`.padStart(7),
    `${c.controlMismatches}`.padStart(9),
    `${c.result.snapshotHz.toFixed(1)}`.padStart(8),
    `${c.result.disagreements.length === 0 ? 'agreed' : 'DESYNC'}`.padStart(8),
  ].join(' ');
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const periodSeconds = Number(flag('period-seconds') ?? 30);
const periods = Number(flag('periods') ?? 1);
const impaired: Impairment = {
  delayMs: Number(flag('delay') ?? 150),
  jitterMs: Number(flag('jitter') ?? 0),
  lossRate: Number(flag('loss') ?? 0.02),
  seed: 0x5eed,
};

console.log(
  `comparing a clean link against ${impaired.delayMs} ms one way / ` +
    `${(impaired.lossRate * 100).toFixed(1)}% loss / ${impaired.jitterMs} ms jitter\n`,
);

const clean = collect(
  'clean',
  await runBotMatch({ periods, periodSeconds, impairment: CLEAN_LINK, verbose: false }),
);
const bad = collect(
  `${impaired.delayMs}ms/${(impaired.lossRate * 100).toFixed(0)}%`,
  await runBotMatch({ periods, periodSeconds, impairment: impaired, verbose: false }),
);

console.log(
  ['link'.padEnd(22), 'mean ft'.padStart(8), 'p95 ft'.padStart(8), 'max ft'.padStart(8),
    'snaps'.padStart(7), 'ctrl mis'.padStart(9), 'snap Hz'.padStart(8), 'verdict'.padStart(8)].join(' '),
);
console.log('-'.repeat(84));
console.log(row(clean));
console.log(row(bad));

console.log(
  `\nhard-snap threshold ${NETWORK.reconcileSnapThreshold} ft, ` +
    `interpolation delay ${NETWORK.interpolationDelayMs} ms, ` +
    `input redundancy ${NETWORK.inputRedundancy}`,
);
console.log(
  `bandwidth down: clean ${clean.result.wireKbPerSecondDown.toFixed(1)} KB/s, ` +
    `impaired ${bad.result.wireKbPerSecondDown.toFixed(1)} KB/s (msgpack)`,
);

for (const c of [clean, bad]) {
  for (const problem of c.result.disagreements) console.log(`  ! ${c.label}: ${problem}`);
}

const desynced = clean.result.disagreements.length + bad.result.disagreements.length;
if (desynced > 0) {
  console.log('\nFAIL: the server and its clients did not agree on what happened.');
}
process.exit(desynced === 0 ? 0 : 1);
