// Oracle refactor-modularity, rows O7 to O10 (P7): the judge retry core with an injected attempt function.
// `executeWithRetries(attempt, { onRetry })` is a card export of scripts/judgment.mjs (post-refactor
// module layout, T1): the loop moves out of run-hermes-page-judge.mjs with its budget and throw lines, and
// the attempt and the judge-retry append are injected. `onRetry` calls stand for judge-retry ledger lines.
// Expected values restate S8 and Q12 a: environment budget 2, agent-output budget 1, each counted on its
// own, any other failure none, and a completed judgment is never re-judged.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentOutputError, EnvironmentError, UsageError } from "../errors.mjs";

// Loaded inside each test: until the refactor creates scripts/judgment.mjs, every test then fails on that
// one missing card export (the accepted first RED) instead of the whole file failing to collect.
type Attempt = () => Promise<unknown> | unknown;
type RetryCore = (attempt: Attempt, options: { onRetry: (entry: unknown) => void }) => Promise<unknown>;
const loadRetryCore = async () => ((await import("../judgment.mjs")) as { executeWithRetries: RetryCore }).executeWithRetries;

type Outcome = "env" | "agent" | "other" | "pass" | "manual_review" | "fail";

function failure(kind: "env" | "agent" | "other") {
  if (kind === "env") return new EnvironmentError("login flap");
  if (kind === "agent") return new AgentOutputError("no JSON");
  return new Error("some other failure");
}

/** An attempt function that plays the scripted outcomes in order and records how often it ran. */
function scripted(outcomes: Outcome[]) {
  const thrown: Error[] = [];
  const judgments: Array<{ status: string }> = [];
  let calls = 0;
  const attempt = async () => {
    const outcome = outcomes[calls];
    calls += 1;
    if (outcome === undefined) throw new Error("the retry core asked for an attempt the script does not have");
    if (outcome === "env" || outcome === "agent" || outcome === "other") {
      const error = failure(outcome);
      thrown.push(error);
      throw error;
    }
    const judgment = { status: outcome };
    judgments.push(judgment);
    return judgment;
  };
  return { attempt, thrown, judgments, calls: () => calls };
}

function recorder() {
  const retries: unknown[] = [];
  return { onRetry: (entry: unknown) => retries.push(entry), retries };
}

async function settle(outcomes: Outcome[]) {
  const executeWithRetries = await loadRetryCore();
  const play = scripted(outcomes);
  const ledger = recorder();
  const result = await executeWithRetries(play.attempt, { onRetry: ledger.onRetry }).then(
    (judgment: unknown) => ({ judgment }),
    (error: unknown) => ({ error }),
  );
  return { ...result, play, ledger };
}

describe("executeWithRetries as a judge run whose attempts throw EnvironmentError (O7)", () => {
  it("to be 2 judge-retry entries and the third failure raised as exit 3", async () => {
    const run = await settle(["env", "env", "env"]);

    expect(run.play.calls()).toBe(3);
    expect(run.ledger.retries).toHaveLength(2);
    expect(run.error).toBe(run.play.thrown[2]);
    expect((run.error as EnvironmentError).exitCode).toBe(3);
  });

  it("to be no fourth attempt after the third failure", async () => {
    const run = await settle(["env", "env", "env", "pass"]);

    expect(run.play.calls()).toBe(3);
    expect(run.play.judgments).toEqual([]);
  });

  it.each([
    [0, ["pass"]],
    [1, ["env", "pass"]],
    [2, ["env", "env", "pass"]],
  ] as Array<[number, Outcome[]]>)("to be %i judge-retry entries and the judgment returned when the attempt then succeeds", async (retries, outcomes) => {
    const run = await settle(outcomes);

    expect(run.ledger.retries).toHaveLength(retries);
    expect(run.play.calls()).toBe(retries + 1);
    expect(run.play.judgments).toHaveLength(1);
    expect(run.judgment).toBe(run.play.judgments[0]);
  });

  it("to be a second attempt that only starts after the first one settled (deferred barrier)", async () => {
    const executeWithRetries = await loadRetryCore();
    let calls = 0;
    // A hand-rolled deferred: Promise.withResolvers needs Node 22, and engines allow Node 20.
    let rejectFirst!: (error: unknown) => void;
    const first = {
      promise: new Promise<{ status: string }>((_resolve, reject) => {
        rejectFirst = reject;
      }),
      reject: (error: unknown) => rejectFirst(error),
    };
    const attempt = () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve({ status: "pass" });
    };
    const ledger = recorder();

    const running = executeWithRetries(attempt, { onRetry: ledger.onRetry });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(ledger.retries).toHaveLength(0);

    first.reject(new EnvironmentError("login flap"));
    await expect(running).resolves.toEqual({ status: "pass" });
    expect(calls).toBe(2);
    expect(ledger.retries).toHaveLength(1);
  });
});

describe("executeWithRetries as a judge run whose attempts throw AgentOutputError (O8)", () => {
  it("to be 1 judge-retry entry and the second failure raised as exit 4", async () => {
    const run = await settle(["agent", "agent"]);

    expect(run.play.calls()).toBe(2);
    expect(run.ledger.retries).toHaveLength(1);
    expect(run.error).toBe(run.play.thrown[1]);
    expect((run.error as AgentOutputError).exitCode).toBe(4);
  });

  it.each([
    [0, ["pass"]],
    [1, ["agent", "pass"]],
  ] as Array<[number, Outcome[]]>)("to be %i judge-retry entries when the second attempt succeeds", async (retries, outcomes) => {
    const run = await settle(outcomes);

    expect(run.ledger.retries).toHaveLength(retries);
    expect(run.play.judgments).toHaveLength(1);
    expect(run.judgment).toBe(run.play.judgments[0]);
  });

  it("to be budgets counted on their own: 2 environment retries do not spend the agent-output retry", async () => {
    const run = await settle(["env", "env", "agent", "agent"]);

    expect(run.play.calls()).toBe(4);
    expect(run.ledger.retries).toHaveLength(3);
    expect(run.error).toBe(run.play.thrown[3]);
    expect((run.error as AgentOutputError).exitCode).toBe(4);
  });

  it("to be budgets counted on their own: the agent-output retry does not spend the environment ones", async () => {
    const run = await settle(["agent", "env", "env", "env"]);

    expect(run.play.calls()).toBe(4);
    expect(run.ledger.retries).toHaveLength(3);
    expect(run.error).toBe(run.play.thrown[3]);
    expect((run.error as EnvironmentError).exitCode).toBe(3);
  });
});

describe("executeWithRetries as a judge run whose attempt throws another error (O9)", () => {
  it("to be the error propagated as it is with 0 judge-retry entries and 1 attempt", async () => {
    const run = await settle(["other", "pass"]);

    expect(run.play.calls()).toBe(1);
    expect(run.ledger.retries).toHaveLength(0);
    expect(run.error).toBe(run.play.thrown[0]);
  });

  it("to be a usage error propagated with its own exit code 2 and no retry", async () => {
    const executeWithRetries = await loadRetryCore();
    const usage = new UsageError("Missing qa spec JSON");
    let calls = 0;
    const ledger = recorder();

    const error = await executeWithRetries(
      () => {
        calls += 1;
        throw usage;
      },
      { onRetry: ledger.onRetry },
    ).catch((caught: unknown) => caught);

    expect(error).toBe(usage);
    expect((error as UsageError).exitCode).toBe(2);
    expect(calls).toBe(1);
    expect(ledger.retries).toHaveLength(0);
  });

  it("to be the other error raised after 1 earlier environment retry without a second retry", async () => {
    const run = await settle(["env", "other", "pass"]);

    expect(run.play.calls()).toBe(2);
    expect(run.ledger.retries).toHaveLength(1);
    expect(run.error).toBe(run.play.thrown[1]);
  });
});

describe("executeWithRetries as an attempt that produced a completed judgment (O10)", () => {
  it.each(["pass", "manual_review", "fail"] as const)("to be the %s judgment returned as it is with no further attempt", async status => {
    const run = await settle([status, "pass"]);

    expect(run.play.judgments).toHaveLength(1);
    expect(run.judgment).toBe(run.play.judgments[0]);
    expect((run.judgment as { status: string }).status).toBe(status);
    expect(run.play.calls()).toBe(1);
    expect(run.ledger.retries).toHaveLength(0);
  });

  it("to be a failing judgment kept after 1 environment retry, never re-judged until green", async () => {
    const run = await settle(["env", "fail", "pass"]);

    expect(run.play.judgments).toHaveLength(1);
    expect(run.judgment).toBe(run.play.judgments[0]);
    expect((run.judgment as { status: string }).status).toBe("fail");
    expect(run.play.calls()).toBe(2);
    expect(run.ledger.retries).toHaveLength(1);
  });
});

describe("executeWithRetries as any scripted sequence of attempt outcomes (O7 to O10)", () => {
  const OUTCOMES: Outcome[] = ["env", "agent", "other", "pass", "manual_review", "fail"];
  const NUM_RUNS = 200;

  /** the card's rule, replayed outcome by outcome */
  function expected(outcomes: Outcome[]) {
    let env = 2;
    let agent = 1;
    let retries = 0;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome === "pass" || outcome === "manual_review" || outcome === "fail") {
        return { calls: index + 1, retries, end: outcome };
      }
      if (outcome === "other") return { calls: index + 1, retries, end: "raised" };
      if (outcome === "env") {
        if (env === 0) return { calls: index + 1, retries, end: "raised" };
        env -= 1;
      } else {
        if (agent === 0) return { calls: index + 1, retries, end: "raised" };
        agent -= 1;
      }
      retries += 1;
    }
    throw new Error("the generated script must end an attempt loop");
  }

  it("to be the attempts, judge-retry entries and ending the card states for 200 sampled scripts", async () => {
    let executed = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...OUTCOMES), { minLength: 1, maxLength: 6 }),
        async drawn => {
          // an all-retry script would run out of attempts; end it with a failing judgment
          const outcomes: Outcome[] = [...drawn, "fail"];
          executed += 1;
          const want = expected(outcomes);

          const run = await settle(outcomes);

          expect(run.play.calls()).toBe(want.calls);
          expect(run.ledger.retries).toHaveLength(want.retries);
          if (want.end === "raised") {
            expect(run.error).toBe(run.play.thrown.at(-1));
          } else {
            expect((run.judgment as { status: string }).status).toBe(want.end);
          }
        },
      ),
      { numRuns: NUM_RUNS, seed: 20261008 },
    );
    expect(executed).toBe(NUM_RUNS);
  });
});
