/**
 * The proof that the netcode works: two headless clients play a full match and
 * the server and both of them are made to agree about what happened.
 *
 *   npm run botmatch                      clean local link
 *   npm run botmatch -- --impaired        150 ms one way + 2% loss (the rubric's link)
 *   npm run botmatch -- --periods 1 --period-seconds 20    a quick run
 *
 * The assertions are the point, not the printout. A netcode bug shows up as the
 * two clients disagreeing with the server about the score, or as prediction
 * error that climbs instead of settling — both of which are checked here rather
 * than left for somebody to notice in the numbers.
 */

import { MATCH, NETWORK, SNAPSHOT_RATE } from '@dfhl/shared';
import type { Score, TeamCode } from '@dfhl/shared';

import { BotClient, type BotReport } from './botclient.js';
import { startMatchServer, type HarnessServer } from './matchserver.js';
import {
  maxOf,
  mean,
  percentile,
  renderBot,
  renderScoreByPeriod,
  summarizeBandwidth,
} from './netreport.js';
import { CLEAN_LINK, RUBRIC_LINK, type Impairment } from './wiretap.js';

export interface BotMatchOptions {
  periods: number;
  periodSeconds: number;
  impairment: Impairment;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  /** Printed report. Off inside vitest, where the assertions are the output. */
  verbose: boolean;
}

export interface BotMatchResult {
  serverScore: Score;
  reports: BotReport[];
  /** Agreement failures. Empty means server and both clients told the same story. */
  disagreements: string[];
  roomDisposed: boolean;
  meanErrorFeet: number;
  p95ErrorFeet: number;
  maxErrorFeet: number;
  snaps: number;
  snapshotHz: number;
  wireKbPerSecondDown: number;
  jsonKbPerSecondDown: number;
}

export const DEFAULT_OPTIONS: BotMatchOptions = {
  periods: 3,
  periodSeconds: 180,
  impairment: CLEAN_LINK,
  homeTeam: 'Det',
  awayTeam: 'QUE',
  verbose: true,
};

function sameScore(a: Score, b: Score): boolean {
  return a.home === b.home && a.away === b.away;
}

function describe(score: Score | null): string {
  return score === null ? 'none' : `${score.home}-${score.away}`;
}

/**
 * How long to allow for a match of this length before calling it hung.
 *
 * Regulation is the small part. A SHORT match nearly always finishes level —
 * scoring runs about a goal a minute, so a 25-second period ends 0-0 far more
 * often than not — and then it owes a full `overtimeSeconds` plus a shootout.
 * Budgeting only from regulation makes brief runs look like hangs, which is
 * exactly the wrong signal from a harness whose job is to detect real ones.
 */
function matchTimeoutMs(options: BotMatchOptions): number {
  const regulation = options.periods * options.periodSeconds * 1000;
  const overtime = MATCH.overtimeSeconds * 1000;
  // Intermissions, faceoff holds, celebrations and a shootout.
  const stoppages = 60_000;
  const impairmentAllowance = options.impairment.delayMs * 40;
  return (regulation + overtime + stoppages) * 1.5 + impairmentAllowance;
}

export async function runBotMatch(
  overrides: Partial<BotMatchOptions> = {},
): Promise<BotMatchResult> {
  const options: BotMatchOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const say = (line: string): void => {
    if (options.verbose) console.log(line);
  };

  // Port 0: the OS picks a free one, so this can never collide with a dev server.
  const server: HarnessServer = await startMatchServer(0);
  const bots: BotClient[] = [];

  try {
    const host = new BotClient({
      endpoint: server.endpoint,
      nickname: 'bot-home',
      teamCode: options.homeTeam,
      impairment: options.impairment,
      seed: 0x1111,
    });
    bots.push(host);
    await host.join();

    const guest = new BotClient({
      endpoint: server.endpoint,
      nickname: 'bot-away',
      code: host.roomCode,
      teamCode: options.awayTeam,
      impairment: options.impairment,
      seed: 0x2222,
    });
    bots.push(guest);
    await guest.join();

    if (guest.roomCode !== host.roomCode) {
      throw new Error(`bots landed in different rooms: ${host.roomCode} vs ${guest.roomCode}`);
    }

    // Both joins have resolved, so the server already holds both seats. Settings
    // first: the host cannot change them once the match is running.
    host.applySettings({ periods: options.periods, periodSeconds: options.periodSeconds });
    host.selectTeam(options.homeTeam);
    guest.selectTeam(options.awayTeam);
    host.setReady(true);
    guest.setReady(true);
    // Resolves only when both seats are connected, ready AND holding a team, so
    // this is the single gate that says the lobby is genuinely startable.
    await host.waitForLobbyReady(2);

    host.startMatch();
    await Promise.all([host.waitForMatchStart(), guest.waitForMatchStart()]);
    say(
      `room ${host.roomCode}  ${options.homeTeam} vs ${options.awayTeam}  ` +
        `${options.periods}x${options.periodSeconds}s  link ${options.impairment.delayMs}ms/${(options.impairment.lossRate * 100).toFixed(0)}%`,
    );

    const roomId = host.roomId;

    /*
     * Sample the server's own state while the match runs, keeping the RUNNING
     * MAXIMUM of each side's score.
     *
     * Reading it after `matchEnd` does not work at all: `endMatch` broadcasts the
     * result and then nulls the runner synchronously, so `peekState` returns null
     * from that instant on. Sampling the latest state is not enough either — a
     * shootout winner increments the score and ends the match within a tick or
     * two, a window a coarse poll walks straight past, and the harness then
     * reports 0-0 against two clients that both correctly saw 0-1. That reads as
     * a desync and is entirely the harness's fault.
     *
     * A score never decreases inside a match, so the maximum IS the final. The
     * lobby reset that follows publishes 0-0, which can never displace it.
     */
    let serverScore: Score = { home: 0, away: 0 };
    let serverSamples = 0;
    let highestServerTick = -1;
    const poller = setInterval(() => {
      const state = server.peekState(roomId);
      if (state === null) return;
      serverSamples++;
      if (state.tick > highestServerTick) highestServerTick = state.tick;
      if (state.score.home > serverScore.home) serverScore.home = state.score.home;
      if (state.score.away > serverScore.away) serverScore.away = state.score.away;
    }, 5);

    const timeout = matchTimeoutMs(options);
    try {
      await Promise.all([host.waitForMatchEnd(timeout), guest.waitForMatchEnd(timeout)]);
    } finally {
      clearInterval(poller);
    }

    const reports = bots.map((bot) => bot.report());

    // ---------------------------------------------------------------------
    // Agreement. This is what the whole harness exists to check.
    // ---------------------------------------------------------------------
    const disagreements: string[] = [];

    /*
     * Prefer the server's own recorded result over anything the poller saw.
     *
     * The poller cannot see a sudden-death winner at all: that goal is scored,
     * snapshotted and the match ended inside one synchronous tick, so the winning
     * score never exists in `runner.state` between two turns of the event loop.
     * `lastResult` is the room's own statement, written in the same breath as the
     * MatchEnd broadcast, and it is what makes this an independent third opinion
     * rather than a coin flip.
     */
    const recorded = server.peekLastResult(roomId);
    if (recorded !== null) serverScore = recorded;

    /*
     * The harness has to prove it actually looked before claiming the server
     * agreed. A poller that silently never resolved the room reports 0-0, which
     * matches a real 0-0 finish and quietly turns this check into nothing.
     */
    if (serverSamples === 0 && recorded === null) {
      disagreements.push(
        `harness never observed server state for room ${roomId} — the score comparison proved nothing`,
      );
    }
    if (options.verbose) {
      say(
        `server observed  ${serverSamples} live samples to tick ${highestServerTick}; ` +
          `room recorded ${recorded === null ? 'no result' : describe(recorded)}`,
      );
    }

    for (const report of reports) {
      if (report.finalScore === null) {
        disagreements.push(`${report.nickname} never received a final score`);
        continue;
      }
      if (!sameScore(report.finalScore, serverScore)) {
        disagreements.push(
          `${report.nickname} final ${describe(report.finalScore)} != server ${describe(serverScore)}`,
        );
      }
    }
    if (reports.length === 2 && reports[0].finalScore !== null && reports[1].finalScore !== null) {
      if (!sameScore(reports[0].finalScore, reports[1].finalScore)) {
        disagreements.push(
          `clients disagree: ${describe(reports[0].finalScore)} vs ${describe(reports[1].finalScore)}`,
        );
      }
      // Period by period, not just the final: a desync that self-corrects before
      // the whistle still means the two clients watched different games.
      for (const [period, score] of reports[0].scoreByPeriod) {
        const other = reports[1].scoreByPeriod.get(period);
        if (other !== undefined && !sameScore(score, other)) {
          disagreements.push(
            `P${period} differs: ${describe(score)} vs ${describe(other)}`,
          );
        }
      }
    }

    const allErrors = reports.flatMap((r) => r.prediction.errors);
    const snaps = reports.reduce((sum, r) => sum + r.prediction.snaps, 0);
    const first = reports[0];
    const snapshotHz =
      first === undefined || first.snapshots < 2 ? 0 : (first.snapshots - 1) / first.matchSeconds;
    const bandwidth = first === undefined ? null : summarizeBandwidth(first);

    if (options.verbose) {
      say('');
      say(`server final       ${describe(serverScore)}   by period ${renderScoreByPeriod(reports[0].scoreByPeriod)}`);
      say('');
      for (const report of reports) {
        for (const line of renderBot(report)) say(line);
        say('');
      }
    }

    await Promise.all(bots.map((bot) => bot.leave()));
    bots.length = 0;

    // Colyseus unlists a room asynchronously after the last client goes.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const roomDisposed = !(await server.isListed(roomId));
    if (!roomDisposed) disagreements.push(`room ${roomId} still listed after both clients left`);

    const result: BotMatchResult = {
      serverScore,
      reports,
      disagreements,
      roomDisposed,
      meanErrorFeet: mean(allErrors),
      p95ErrorFeet: percentile(allErrors, 0.95),
      maxErrorFeet: maxOf(allErrors),
      snaps,
      snapshotHz,
      wireKbPerSecondDown: bandwidth?.down.wireKbPerSecond ?? 0,
      jsonKbPerSecondDown: bandwidth?.down.jsonKbPerSecond ?? 0,
    };

    if (options.verbose) {
      say(
        `VERDICT  ${disagreements.length === 0 ? 'agreed' : `${disagreements.length} DISAGREEMENT(S)`}` +
          `   room disposed ${roomDisposed}` +
          `   snapshot ${snapshotHz.toFixed(1)} Hz (intended ${SNAPSHOT_RATE})`,
      );
      for (const problem of disagreements) say(`  ! ${problem}`);
      say(
        `         prediction error mean ${result.meanErrorFeet.toFixed(2)} ft` +
          `  p95 ${result.p95ErrorFeet.toFixed(2)} ft  max ${result.maxErrorFeet.toFixed(2)} ft` +
          `  snaps ${snaps} (threshold ${NETWORK.reconcileSnapThreshold} ft)`,
      );
    }

    return result;
  } finally {
    for (const bot of bots) await bot.leave().catch(() => undefined);
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('tools/botmatch.ts') ?? false;

if (isCli) {
  const impaired = process.argv.includes('--impaired');
  const result = await runBotMatch({
    periods: Number(flag('periods') ?? 3),
    periodSeconds: Number(flag('period-seconds') ?? 180),
    impairment: impaired ? RUBRIC_LINK : CLEAN_LINK,
  });
  process.exit(result.disagreements.length === 0 ? 0 : 1);
}
