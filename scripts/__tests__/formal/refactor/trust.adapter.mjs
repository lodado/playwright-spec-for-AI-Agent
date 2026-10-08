/**
 * Trace adapter of the refactor-modularity Oracle (package product.adapter). Each model event drives the
 * refactored product one step; `observe` reads the product back in the shape of `Trust.observe`.
 *
 *   PartFold        worstExitCode of the nightly stage (run-page-qa-nightly.mjs)
 *   PartLedger      the run ledger core over a temp file (qa-run-ledger.mjs, io injected)
 *   PartJudge       the judge retry core with an injected attempt function (judgment.mjs, a card export)
 *   PartProvenance  the judge and review stage entries over stamped artifacts, offline dry runs
 *
 * The retry core is imported lazily so a repository that does not have judgment.mjs yet still runs the
 * three other behaviors; the judge cases then fail on the missing card export.
 */
import { AgentOutputError, EnvironmentError } from "../../../errors.mjs"
import { appendRunEvent, verifyLedger } from "../../../qa-run-ledger.mjs"
import { worstExitCode } from "../../../run-page-qa-nightly.mjs"
import {
  FIXED_NOW,
  enterJudgeStage,
  enterReviewStage,
  makeLedgerFile,
  makeTempDir,
  nodeIo,
  removeDir,
} from "../../refactor-trace-fixtures.mjs"

const EXIT_CODES = {
  ExitOk: 0,
  ExitVerdict: 1,
  ExitUsage: 2,
  ExitAgent: 4,
  ExitEnv: 3,
  ExitOddLow: 5,
  ExitOddHigh: 6,
}
const EXIT_NAMES = Object.fromEntries(Object.entries(EXIT_CODES).map(([name, code]) => [code, name]))

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The joint cases start the product on a world setting of the verdict normalizer. The four behaviors driven
// here do not read the verdict world; the setting is kept on the state so a case that needed it could.
export function init(coordinates) {
  return { part: null, coordinates }
}

export async function step(state, event) {
  if (event.$ === "Begin") return begin(state, event.part.$)
  switch (state.part) {
    case "fold":
      return { ...state, codes: [...state.codes, EXIT_CODES[event.code.$]] }
    case "ledger":
      return stepLedger(state, event)
    case "judge":
      return stepJudge(state, event)
    case "provenance":
      return stepProvenance(state, event)
    default:
      throw new Error(`unmapped model event ${JSON.stringify(event)}`)
  }
}

export function observe(state) {
  switch (state.part) {
    case null:
      return { $: "ObsIdle" }
    case "fold":
      return { $: "ObsExit", code: { $: EXIT_NAMES[worstExitCode(state.codes)] } }
    case "ledger":
      return { $: "ObsChain", intact: verifyLedger(state.file.path, { io: nodeIo }).ok }
    case "judge":
      return { $: "ObsJudge", retries: state.retries.length, phase: state.phase }
    case "provenance":
      return { $: "ObsStamp", phase: state.phase }
    default:
      throw new Error(`unknown part ${state.part}`)
  }
}

export function dispose(state) {
  if (state.dir) removeDir(state.dir)
}

function begin(state, part) {
  if (state.part !== null) throw new Error("Begin is only offered from Idle")
  switch (part) {
    case "PartFold":
      return { part: "fold", codes: [] }
    case "PartLedger": {
      const dir = makeTempDir("refactor-trace-ledger")
      return { part: "ledger", dir, file: makeLedgerFile(dir), appended: 0 }
    }
    case "PartJudge":
      return beginJudge()
    case "PartProvenance":
      return { part: "provenance", phase: { $: "AtJudge" } }
    default:
      throw new Error(`unmapped part ${part}`)
  }
}

function stepLedger(state, event) {
  const { file } = state
  if (event.$ === "Append") {
    const appended = state.appended + 1
    appendRunEvent(file.path, { kind: "trace-event", runId: `run-${appended}` }, { now: FIXED_NOW, io: nodeIo })
    file.recordAppend()
    return { ...state, appended }
  }
  if (event.$ !== "Tampered") throw new Error(`unmapped model event ${JSON.stringify(event)}`)
  const tamper = { EditFirst: "editFirst", RemoveFirst: "removeFirst", TearLast: "tearLast", DropLast: "dropLast" }[
    event.how.$
  ]
  file[tamper]()
  return state
}

// ---- the judge retry core: the loop runs concurrently with the test, one pending attempt at a time ----

async function beginJudge() {
  const { executeWithRetries } = await import("../../../judgment.mjs")
  const state = {
    part: "judge",
    retries: [],
    phase: { $: "Attempting" },
    pending: null,
    lastThrown: null,
    attempts: 0,
    waiter: null,
  }
  const attempt = () => {
    const current = deferred()
    state.pending = current
    state.attempts += 1
    state.waiter?.resolve()
    return current.promise
  }
  state.loop = executeWithRetries(attempt, { onRetry: (entry) => state.retries.push(entry) }).then(
    (judgment) => ({ judged: judgment }),
    (error) => ({ raised: error }),
  )
  await settle(state, 0)
  return state
}

/** waits until the loop asks for an attempt beyond `seen` or finishes; no timers */
async function settle(state, seen) {
  if (state.attempts > seen) return
  state.waiter = deferred()
  const outcome = await Promise.race([state.waiter.promise.then(() => null), state.loop])
  if (outcome === null) return
  if ("judged" in outcome) {
    const status = outcome.judged?.status
    const as = { pass: "JudgedPass", manual_review: "JudgedManual", fail: "JudgedFail" }[status]
    if (!as) throw new Error(`the retry core returned a value that is no judgment: ${JSON.stringify(outcome.judged)}`)
    state.phase = { $: "Judged", as: { $: as } }
    return
  }
  const error = outcome.raised
  if (error !== state.lastThrown) throw new Error("the retry core raised something other than the last real failure")
  const cause = error instanceof EnvironmentError ? "CauseEnv" : error instanceof AgentOutputError ? "CauseAgent" : "CauseOther"
  state.phase = { $: "Raised", cause: { $: cause } }
}

async function stepJudge(state, event) {
  if (state.phase.$ !== "Attempting" || state.pending === null) {
    throw new Error(`unmapped model event ${JSON.stringify(event)}`)
  }
  const current = state.pending
  const seen = state.attempts
  state.pending = null
  if (event.$ === "AttemptFailed") {
    const error = {
      CauseEnv: () => new EnvironmentError("trace: environment failure"),
      CauseAgent: () => new AgentOutputError("trace: unusable agent output"),
      CauseOther: () => new Error("trace: some other failure"),
    }[event.cause.$]()
    state.lastThrown = error
    current.reject(error)
  } else if (event.$ === "AttemptJudged") {
    const status = { JudgedPass: "pass", JudgedManual: "manual_review", JudgedFail: "fail" }[event.as.$]
    current.resolve({ status })
  } else {
    throw new Error(`unmapped model event ${JSON.stringify(event)}`)
  }
  await settle(state, seen)
  return state
}

// ---- provenance: the stage entries re-check the stamp of their input ----

async function stepProvenance(state, event) {
  if (event.$ !== "Consumed") throw new Error(`unmapped model event ${JSON.stringify(event)}`)
  const stamp = { StampMatches: "matches", StampDiffers: "differs", StampAbsent: "absent" }[event.stamp.$]
  if (state.phase.$ === "AtJudge") {
    const result = await enterJudgeStage(stamp)
    return { ...state, phase: result.entered ? { $: "AtReview" } : refused(result, /abstract-ai/, "RerunAbstract") }
  }
  if (state.phase.$ === "AtReview") {
    const result = await enterReviewStage(stamp)
    return { ...state, phase: result.entered ? { $: "Reviewed" } : refused(result, /\bjudge --page=/, "RerunJudge") }
  }
  throw new Error(`unmapped model event ${JSON.stringify(event)}`)
}

function refused(result, namesCommand, rerun) {
  if (result.exitCode !== 2) throw new Error(`a stage refused with exit ${result.exitCode}: ${result.message}`)
  if (!namesCommand.test(`${result.message}\n${result.hint}`)) {
    throw new Error(`a stage refused without naming the command to re-run: ${result.message} | ${result.hint}`)
  }
  return { $: "Refused", rerun: { $: rerun } }
}
