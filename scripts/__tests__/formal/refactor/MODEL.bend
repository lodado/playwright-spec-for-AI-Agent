import Base

# Reference behavior for the refactor-modularity oracle (.ai/oracles/refactor-modularity/oracle.package.json).
# The refactor must keep four harness behaviors that depend on the order of events. They share nothing at run
# time, so the first event of a trace picks one (`Begin`) and `Trust.next` then offers only that behavior's
# events. `Trust.allowed` states the layering rule the import graph must satisfy.
# Expected values come from the sources named in each comment; a value the sources left open cites the
# question whose option (a) the user adopted in turn 4 (S1).

type Part is Data:
  PartFold{}
  PartLedger{}
  PartJudge{}
  PartProvenance{}

# B4 — one stage's exit code (S9, S10). Two unrecognised codes are kept apart so the fold's order is visible.
type ExitCode is Data:
  ExitOk{}
  ExitVerdict{}
  ExitUsage{}
  ExitAgent{}
  ExitEnv{}
  ExitOddLow{}
  ExitOddHigh{}

# B5 — one line of the run ledger file (S8). The adapter edits and removes the first entry and cuts or drops
# the last line, so each tamper names one line.
type Line is Data:
  LineOk{}
  LineEdited{}
  LineUnlinked{}
  LineTorn{}

type Tamper is Data:
  EditFirst{}
  RemoveFirst{}
  TearLast{}
  DropLast{}

# B6 — why one judge attempt threw (S8), and the verdict of a completed attempt
type Cause is Data:
  CauseEnv{}
  CauseAgent{}
  CauseOther{}

type JudgedAs is Data:
  JudgedPass{}
  JudgedManual{}
  JudgedFail{}

type JudgePhase is Data:
  Attempting{}
  Judged{as: JudgedAs}
  Raised{cause: Cause}

# B3 — the stamp a consuming stage finds on its input (S7)
type Stamp is Data:
  StampMatches{}
  StampDiffers{}
  StampAbsent{}

type Rerun is Data:
  RerunAbstract{}
  RerunJudge{}

type ProvPhase is Data:
  AtJudge{}
  AtReview{}
  Reviewed{}
  Refused{rerun: Rerun}

type Msg is Data:
  Begin{part: Part}
  StageExit{code: ExitCode}
  Append{}
  Tampered{how: Tamper}
  AttemptFailed{cause: Cause}
  AttemptJudged{as: JudgedAs}
  Consumed{stamp: Stamp}

type Trust is Data:
  Idle{}
  Folding{worst: ExitCode}
  Ledgering{lines: +List<Line>}
  Judging{env: Nat, agent: Nat, retries: Nat, phase: JudgePhase}
  Proving{phase: ProvPhase}

type Obs is Data:
  ObsIdle{}
  ObsExit{code: ExitCode}
  ObsChain{intact: Bool}
  ObsJudge{retries: Nat, phase: JudgePhase}
  ObsStamp{phase: ProvPhase}

# ── B4: severity, worst last (S9 "0 < 1 < 2 < 4 < 3", an unrecognised code above all of them).
# Between two unrecognised codes the numerically larger one is worse (Q10 a, adopted in turn 4).
def Trust.rank(c: ExitCode) -> Nat:
  match c:
    case ExitOk{}:
      0n
    case ExitVerdict{}:
      1n
    case ExitUsage{}:
      2n
    case ExitAgent{}:
      3n
    case ExitEnv{}:
      4n
    case ExitOddLow{}:
      5n
    case ExitOddHigh{}:
      6n

def Trust.pickCode(later: Bool, a: ExitCode, b: ExitCode) -> ExitCode:
  match later:
    case True{}:
      b
    case False{}:
      a

# the worse of the run so far (a) and the next stage's exit (b); a tie keeps a
def Trust.worse(+a: ExitCode, +b: ExitCode) -> ExitCode:
  Trust.pickCode(Nat.is_gt(Trust.rank(b), Trust.rank(a)), a, b)

# ── B5: a ledger line verifies only when it is a complete entry whose hash and link both hold. A torn
# (truncated) line breaks the chain wherever it sits (Q11 a, adopted in turn 4).
def Trust.lineIntact(l: Line) -> Bool:
  match l:
    case LineOk{}:
      True{}
    case LineEdited{}:
      False{}
    case LineUnlinked{}:
      False{}
    case LineTorn{}:
      False{}

def Trust.intact(xs: +List<Line>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      Bool.and(Trust.lineIntact(h), Trust.intact(t))

# append links the new entry to the last complete entry, so the new line itself always verifies
def Trust.appendLine(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      [LineOk{}]
    case Con{h, t}:
      h <> Trust.appendLine(t)

def Trust.edited(l: Line) -> Line:
  match l:
    case LineOk{}:
      LineEdited{}
    case LineEdited{}:
      LineEdited{}
    case LineUnlinked{}:
      LineEdited{}
    case LineTorn{}:
      LineTorn{}

def Trust.unlinked(l: Line) -> Line:
  match l:
    case LineOk{}:
      LineUnlinked{}
    case LineEdited{}:
      LineEdited{}
    case LineUnlinked{}:
      LineUnlinked{}
    case LineTorn{}:
      LineTorn{}

def Trust.editFirst(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Trust.edited(h) <> t

# removing the first entry leaves the next one pointing at a hash that is no longer there
def Trust.unlinkHead(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Trust.unlinked(h) <> t

def Trust.removeFirst(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Trust.unlinkHead(t)

def Trust.tearCons(t: +List<Line>, h: Line) -> +List<Line>:
  match t:
    case Nil{}:
      [LineTorn{}]
    case Con{h2, t2}:
      h <> Trust.tearCons(t2, h2)

def Trust.tearLast(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Trust.tearCons(t, h)

def Trust.dropCons(t: +List<Line>, h: Line) -> +List<Line>:
  match t:
    case Nil{}:
      Nil{}
    case Con{h2, t2}:
      h <> Trust.dropCons(t2, h2)

def Trust.dropLast(xs: +List<Line>) -> +List<Line>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{h, t}:
      Trust.dropCons(t, h)

def Trust.tamper(xs: +List<Line>, how: Tamper) -> +List<Line>:
  match how:
    case EditFirst{}:
      Trust.editFirst(xs)
    case RemoveFirst{}:
      Trust.removeFirst(xs)
    case TearLast{}:
      Trust.tearLast(xs)
    case DropLast{}:
      Trust.dropLast(xs)

# ── B6: retry budgets per cause (S8; Q12 a, adopted in turn 4: two retries after an environment failure, one after
# unusable agent output, none otherwise, each budget counted on its own). A completed attempt is final.
def Trust.envFailed(env: Nat, agent: Nat, retries: Nat) -> Trust:
  match env:
    case 0n:
      Judging{0n, agent, retries, Raised{CauseEnv{}}}
    case 1n+p:
      Judging{p, agent, 1n+retries, Attempting{}}

def Trust.agentFailed(agent: Nat, env: Nat, retries: Nat) -> Trust:
  match agent:
    case 0n:
      Judging{env, 0n, retries, Raised{CauseAgent{}}}
    case 1n+p:
      Judging{env, p, 1n+retries, Attempting{}}

def Trust.failedBy(env: Nat, agent: Nat, retries: Nat, cause: Cause) -> Trust:
  match cause:
    case CauseEnv{}:
      Trust.envFailed(env, agent, retries)
    case CauseAgent{}:
      Trust.agentFailed(agent, env, retries)
    case CauseOther{}:
      Judging{env, agent, retries, Raised{CauseOther{}}}

def Trust.attemptFailed(env: Nat, agent: Nat, retries: Nat, phase: JudgePhase, cause: Cause) -> Trust:
  match phase:
    case Attempting{}:
      Trust.failedBy(env, agent, retries, cause)
    case Judged{v}:
      Judging{env, agent, retries, Judged{v}}
    case Raised{c}:
      Judging{env, agent, retries, Raised{c}}

def Trust.attemptJudged(env: Nat, agent: Nat, retries: Nat, phase: JudgePhase, v: JudgedAs) -> Trust:
  match phase:
    case Attempting{}:
      Judging{env, agent, retries, Judged{v}}
    case Judged{w}:
      Judging{env, agent, retries, Judged{w}}
    case Raised{c}:
      Judging{env, agent, retries, Raised{c}}

# ── B3: only an actual mismatch refuses, naming the stage to re-run; a missing stamp proceeds (S7)
def Trust.atBoundary(stamp: Stamp, rerun: Rerun, next: ProvPhase) -> ProvPhase:
  match stamp:
    case StampMatches{}:
      next
    case StampDiffers{}:
      Refused{rerun}
    case StampAbsent{}:
      next

def Trust.consumed(phase: ProvPhase, stamp: Stamp) -> ProvPhase:
  match phase:
    case AtJudge{}:
      Trust.atBoundary(stamp, RerunAbstract{}, AtReview{})
    case AtReview{}:
      Trust.atBoundary(stamp, RerunJudge{}, Reviewed{})
    case Reviewed{}:
      Reviewed{}
    case Refused{r}:
      Refused{r}

# ── the behaviors
def Trust.init() -> Trust:
  Idle{}

def Trust.begin(p: Part) -> Trust:
  match p:
    case PartFold{}:
      Folding{ExitOk{}}
    case PartLedger{}:
      Ledgering{Nil{}}
    case PartJudge{}:
      Judging{2n, 1n, 0n, Attempting{}}
    case PartProvenance{}:
      Proving{AtJudge{}}

def Trust.step(s: Trust, m: Msg) -> Trust:
  match s m:
    case Idle{} Begin{p}:
      Trust.begin(p)
    case Folding{w} StageExit{c}:
      Folding{Trust.worse(w, c)}
    case Ledgering{xs} Append{}:
      Ledgering{Trust.appendLine(xs)}
    case Ledgering{xs} Tampered{how}:
      Ledgering{Trust.tamper(xs, how)}
    case Judging{e, a, r, ph} AttemptFailed{c}:
      Trust.attemptFailed(e, a, r, ph, c)
    case Judging{e, a, r, ph} AttemptJudged{v}:
      Trust.attemptJudged(e, a, r, ph, v)
    case Proving{ph} Consumed{st}:
      Proving{Trust.consumed(ph, st)}
    case other msg:
      other

def Trust.observe(s: Trust) -> Obs:
  match s:
    case Idle{}:
      ObsIdle{}
    case Folding{w}:
      ObsExit{w}
    case Ledgering{xs}:
      ObsChain{Trust.intact(xs)}
    case Judging{e, a, r, ph}:
      ObsJudge{r, ph}
    case Proving{ph}:
      ObsStamp{ph}

def Trust.run(ms: +List<Msg>, s: Trust) -> Trust:
  match ms:
    case Nil{}:
      s
    case Con{m, rest}:
      Trust.run(rest, Trust.step(s, m))

# ── environment: what can happen next, as a function of the state the history reached
def Trust.allExits() -> +List<Msg>:
  [StageExit{ExitOk{}}, StageExit{ExitVerdict{}}, StageExit{ExitUsage{}}, StageExit{ExitAgent{}}, StageExit{ExitEnv{}}, StageExit{ExitOddLow{}}, StageExit{ExitOddHigh{}}]

def Trust.when(ok: Bool, m: Msg, rest: +List<Msg>) -> +List<Msg>:
  match ok:
    case True{}:
      m <> rest
    case False{}:
      rest

def Trust.isTorn(l: Line) -> Bool:
  match l:
    case LineOk{}:
      False{}
    case LineEdited{}:
      False{}
    case LineUnlinked{}:
      False{}
    case LineTorn{}:
      True{}

def Trust.lastTorn(t: +List<Line>, h: Line) -> Bool:
  match t:
    case Nil{}:
      Trust.isTorn(h)
    case Con{h2, t2}:
      Trust.lastTorn(t2, h2)

# a tamper needs the lines it touches: an edit a complete first entry, a removal an entry after the first,
# a tear a complete last line, a drop any line
def Trust.hasTail(t: +List<Line>) -> Bool:
  match t:
    case Nil{}:
      False{}
    case Con{h, r}:
      True{}

def Trust.consOffers(+h: Line, +t: +List<Line>) -> +List<Msg>:
  Append{} <> Trust.when(Bool.not(Trust.isTorn(h)), Tampered{EditFirst{}}, Trust.when(Trust.hasTail(t), Tampered{RemoveFirst{}}, Trust.when(Bool.not(Trust.lastTorn(t, h)), Tampered{TearLast{}}, [Tampered{DropLast{}}])))

def Trust.ledgerOffers(xs: +List<Line>) -> +List<Msg>:
  match xs:
    case Nil{}:
      [Append{}]
    case Con{h, t}:
      Trust.consOffers(h, t)

def Trust.judgeOffers(ph: JudgePhase) -> +List<Msg>:
  match ph:
    case Attempting{}:
      [AttemptFailed{CauseEnv{}}, AttemptFailed{CauseAgent{}}, AttemptFailed{CauseOther{}}, AttemptJudged{JudgedPass{}}, AttemptJudged{JudgedManual{}}, AttemptJudged{JudgedFail{}}]
    case Judged{v}:
      Nil{}
    case Raised{c}:
      Nil{}

def Trust.provOffers(ph: ProvPhase) -> +List<Msg>:
  match ph:
    case AtJudge{}:
      [Consumed{StampMatches{}}, Consumed{StampDiffers{}}, Consumed{StampAbsent{}}]
    case AtReview{}:
      [Consumed{StampMatches{}}, Consumed{StampDiffers{}}, Consumed{StampAbsent{}}]
    case Reviewed{}:
      Nil{}
    case Refused{r}:
      Nil{}

def Trust.offers(s: Trust) -> +List<Msg>:
  match s:
    case Idle{}:
      [Begin{PartFold{}}, Begin{PartLedger{}}, Begin{PartJudge{}}, Begin{PartProvenance{}}]
    case Folding{w}:
      Trust.allExits()
    case Ledgering{xs}:
      Trust.ledgerOffers(xs)
    case Judging{e, a, r, ph}:
      Trust.judgeOffers(ph)
    case Proving{ph}:
      Trust.provOffers(ph)

def Trust.next(h: +List<Msg>) -> +List<Msg>:
  Trust.offers(Trust.run(h, Trust.init()))

# ── R3: layering of the import graph (Q13 a, adopted in turn 4). Higher layers may import lower ones; a layer may
# import itself except the node IO leaf; the pure core imports only the core.
type Layer is Data:
  LayerCli{}
  LayerPipeline{}
  LayerInfra{}
  LayerConfig{}
  LayerCore{}
  LayerNodeIo{}

def Trust.height(l: Layer) -> Nat:
  match l:
    case LayerCli{}:
      5n
    case LayerPipeline{}:
      4n
    case LayerInfra{}:
      3n
    case LayerConfig{}:
      2n
    case LayerCore{}:
      1n
    case LayerNodeIo{}:
      0n

def Trust.isCore(l: Layer) -> Bool:
  match l:
    case LayerCli{}:
      False{}
    case LayerPipeline{}:
      False{}
    case LayerInfra{}:
      False{}
    case LayerConfig{}:
      False{}
    case LayerCore{}:
      True{}
    case LayerNodeIo{}:
      False{}

def Trust.isLeaf(l: Layer) -> Bool:
  match l:
    case LayerCli{}:
      False{}
    case LayerPipeline{}:
      False{}
    case LayerInfra{}:
      False{}
    case LayerConfig{}:
      False{}
    case LayerCore{}:
      False{}
    case LayerNodeIo{}:
      True{}

def Trust.allowed(+from: Layer, +to: Layer) -> Bool:
  Bool.or(Bool.and(Nat.is_eq(Trust.height(from), Trust.height(to)), Bool.not(Trust.isLeaf(from))), Bool.and(Nat.is_lt(Trust.height(to), Trust.height(from)), Bool.not(Trust.isCore(from))))

# ── Classifiers for the space cross-check (oracle.package.json crossCheck): they name, per state and per step,
# the declared Case space value and the analyst state-table name the model's behavior corresponds to. They read
# the state and the event only; no law depends on them.
type Decision is Data:
  DecNone{}
  DecExitFold{}
  DecLedger{}
  DecJudgeRetry{}
  DecProvenance{}

def Trust.partDecision(p: Part) -> Decision:
  match p:
    case PartFold{}:
      DecExitFold{}
    case PartLedger{}:
      DecLedger{}
    case PartJudge{}:
      DecJudgeRetry{}
    case PartProvenance{}:
      DecProvenance{}

def Trust.decisionOf(s: Trust, m: Msg) -> Decision:
  match m:
    case Begin{p}:
      Trust.partDecision(p)
    case StageExit{c}:
      DecNone{}
    case Append{}:
      DecNone{}
    case Tampered{h}:
      DecNone{}
    case AttemptFailed{c}:
      DecNone{}
    case AttemptJudged{v}:
      DecNone{}
    case Consumed{st}:
      DecNone{}

type AttemptKind is Data:
  AtNone{}
  AtOk{}
  AtEnv{}
  AtAgent{}
  AtOther{}

def Trust.causeKind(c: Cause) -> AttemptKind:
  match c:
    case CauseEnv{}:
      AtEnv{}
    case CauseAgent{}:
      AtAgent{}
    case CauseOther{}:
      AtOther{}

def Trust.attemptOf(s: Trust, m: Msg) -> AttemptKind:
  match m:
    case Begin{p}:
      AtNone{}
    case StageExit{c}:
      AtNone{}
    case Append{}:
      AtNone{}
    case Tampered{h}:
      AtNone{}
    case AttemptFailed{c}:
      Trust.causeKind(c)
    case AttemptJudged{v}:
      AtOk{}
    case Consumed{st}:
      AtNone{}

type StampKind is Data:
  StNone{}
  StAbsent{}
  StCurrent{}
  StMismatched{}

def Trust.stampKind(st: Stamp) -> StampKind:
  match st:
    case StampMatches{}:
      StCurrent{}
    case StampDiffers{}:
      StMismatched{}
    case StampAbsent{}:
      StAbsent{}

def Trust.stampOf(s: Trust, m: Msg) -> StampKind:
  match m:
    case Begin{p}:
      StNone{}
    case StageExit{c}:
      StNone{}
    case Append{}:
      StNone{}
    case Tampered{h}:
      StNone{}
    case AttemptFailed{c}:
      StNone{}
    case AttemptJudged{v}:
      StNone{}
    case Consumed{st}:
      Trust.stampKind(st)

type LedgerKind is Data:
  LfNone{}
  LfAbsent{}
  LfValid{}
  LfEdited{}
  LfTruncated{}

def Trust.hasTorn(xs: +List<Line>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      Bool.or(Trust.isTorn(h), Trust.hasTorn(t))

def Trust.brokenKind(torn: Bool) -> LedgerKind:
  match torn:
    case True{}:
      LfTruncated{}
    case False{}:
      LfEdited{}

def Trust.okOrBroken(ok: Bool, torn: Bool) -> LedgerKind:
  match ok:
    case True{}:
      LfValid{}
    case False{}:
      Trust.brokenKind(torn)

def Trust.nonEmptyKind(+xs: +List<Line>) -> LedgerKind:
  Trust.okOrBroken(Trust.intact(xs), Trust.hasTorn(xs))

def Trust.fileKind(xs: +List<Line>) -> LedgerKind:
  match xs:
    case Nil{}:
      LfAbsent{}
    case Con{h, t}:
      Trust.nonEmptyKind(h <> t)

def Trust.ledgerOf(s: Trust, m: Msg) -> LedgerKind:
  match s:
    case Idle{}:
      LfNone{}
    case Folding{w}:
      LfNone{}
    case Ledgering{xs}:
      Trust.fileKind(xs)
    case Judging{e, a, r, ph}:
      LfNone{}
    case Proving{ph}:
      LfNone{}

# analyst state-table names (crossCheck.stateModel)
type Phase is Data:
  PhIdle{}
  PhFolding{}
  PhProvAtJudge{}
  PhProvAtReview{}
  PhProvReviewed{}
  PhProvRefused{}
  PhLedgerEmpty{}
  PhLedgerIntact{}
  PhLedgerBroken{}
  PhJudgeFirstAttempt{}
  PhJudgeRetrying{}
  PhJudgeCompleted{}
  PhJudgeFailedEnv{}
  PhJudgeFailedAgent{}
  PhJudgeFailedOther{}

def Trust.provPhase(ph: ProvPhase) -> Phase:
  match ph:
    case AtJudge{}:
      PhProvAtJudge{}
    case AtReview{}:
      PhProvAtReview{}
    case Reviewed{}:
      PhProvReviewed{}
    case Refused{r}:
      PhProvRefused{}

def Trust.raisedPhase(c: Cause) -> Phase:
  match c:
    case CauseEnv{}:
      PhJudgeFailedEnv{}
    case CauseAgent{}:
      PhJudgeFailedAgent{}
    case CauseOther{}:
      PhJudgeFailedOther{}

def Trust.attemptPhase(retries: Nat) -> Phase:
  match retries:
    case 0n:
      PhJudgeFirstAttempt{}
    case 1n+p:
      PhJudgeRetrying{}

def Trust.judgePhase(ph: JudgePhase, retries: Nat) -> Phase:
  match ph:
    case Attempting{}:
      Trust.attemptPhase(retries)
    case Judged{v}:
      PhJudgeCompleted{}
    case Raised{c}:
      Trust.raisedPhase(c)

def Trust.intactPhase(ok: Bool) -> Phase:
  match ok:
    case True{}:
      PhLedgerIntact{}
    case False{}:
      PhLedgerBroken{}

def Trust.ledgerPhase(xs: +List<Line>) -> Phase:
  match xs:
    case Nil{}:
      PhLedgerEmpty{}
    case Con{h, t}:
      Trust.intactPhase(Trust.intact(h <> t))

def Trust.phaseOf(s: Trust) -> Phase:
  match s:
    case Idle{}:
      PhIdle{}
    case Folding{w}:
      PhFolding{}
    case Ledgering{xs}:
      Trust.ledgerPhase(xs)
    case Judging{e, a, r, ph}:
      Trust.judgePhase(ph, r)
    case Proving{ph}:
      Trust.provPhase(ph)

type Step is Data:
  EvBeginFold{}
  EvBeginLedger{}
  EvBeginJudge{}
  EvBeginProvenance{}
  EvStageExit{}
  EvAppend{}
  EvEdit{}
  EvRemove{}
  EvTear{}
  EvDrop{}
  EvJudged{}
  EvFailEnv{}
  EvFailAgent{}
  EvFailOther{}
  EvStampMatchAtJudge{}
  EvStampDiffAtJudge{}
  EvStampAbsentAtJudge{}
  EvStampMatchAtReview{}
  EvStampDiffAtReview{}
  EvStampAbsentAtReview{}
  EvOther{}

def Trust.beginStep(p: Part) -> Step:
  match p:
    case PartFold{}:
      EvBeginFold{}
    case PartLedger{}:
      EvBeginLedger{}
    case PartJudge{}:
      EvBeginJudge{}
    case PartProvenance{}:
      EvBeginProvenance{}

def Trust.tamperStep(h: Tamper) -> Step:
  match h:
    case EditFirst{}:
      EvEdit{}
    case RemoveFirst{}:
      EvRemove{}
    case TearLast{}:
      EvTear{}
    case DropLast{}:
      EvDrop{}

def Trust.failStep(c: Cause) -> Step:
  match c:
    case CauseEnv{}:
      EvFailEnv{}
    case CauseAgent{}:
      EvFailAgent{}
    case CauseOther{}:
      EvFailOther{}

def Trust.judgeStamp(st: Stamp) -> Step:
  match st:
    case StampMatches{}:
      EvStampMatchAtJudge{}
    case StampDiffers{}:
      EvStampDiffAtJudge{}
    case StampAbsent{}:
      EvStampAbsentAtJudge{}

def Trust.reviewStamp(st: Stamp) -> Step:
  match st:
    case StampMatches{}:
      EvStampMatchAtReview{}
    case StampDiffers{}:
      EvStampDiffAtReview{}
    case StampAbsent{}:
      EvStampAbsentAtReview{}

def Trust.stampStep(ph: ProvPhase, st: Stamp) -> Step:
  match ph:
    case AtJudge{}:
      Trust.judgeStamp(st)
    case AtReview{}:
      Trust.reviewStamp(st)
    case Reviewed{}:
      EvOther{}
    case Refused{r}:
      EvOther{}

def Trust.consumedStep(s: Trust, st: Stamp) -> Step:
  match s:
    case Idle{}:
      EvOther{}
    case Folding{w}:
      EvOther{}
    case Ledgering{xs}:
      EvOther{}
    case Judging{e, a, r, ph}:
      EvOther{}
    case Proving{ph}:
      Trust.stampStep(ph, st)

def Trust.stepOf(s: Trust, m: Msg) -> Step:
  match m:
    case Begin{p}:
      Trust.beginStep(p)
    case StageExit{c}:
      EvStageExit{}
    case Append{}:
      EvAppend{}
    case Tampered{h}:
      Trust.tamperStep(h)
    case AttemptFailed{c}:
      Trust.failStep(c)
    case AttemptJudged{v}:
      EvJudged{}
    case Consumed{st}:
      Trust.consumedStep(s, st)
