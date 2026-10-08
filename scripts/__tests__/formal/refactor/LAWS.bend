import Base
import ./MODEL.bend as M

# Approved laws for the refactor-modularity oracle (.ai/oracles/refactor-modularity/oracle.package.json).
# They state facts about the reference model in MODEL.bend, not about the product; the generated trace
# conformance and the architecture test compare the product with it. PROOF.bend proves them.

# ── B4 nightly exit fold (P5: S6, S9, S10; Q10 a, adopted in turn 4)

# P5: each stage exit folds into the run's exit as the worse of the two
law fold_takes_worse:
  for w: M.ExitCode
  for c: M.ExitCode
  {M.Trust.step(M.Folding{w}, M.StageExit{c}) == M.Folding{M.Trust.worse(w, c)} : M.Trust}

# P5: the folded exit is at least as severe as both inputs (S9 order, worst last)
law fold_dominates:
  for a: M.ExitCode
  for b: M.ExitCode
  {Bool.and(Nat.is_ge(M.Trust.rank(M.Trust.worse(a, b)), M.Trust.rank(a)), Nat.is_ge(M.Trust.rank(M.Trust.worse(a, b)), M.Trust.rank(b))) == True{} : Bool}

# P5: the folded exit is one of the two inputs, never a third code
law fold_keeps_an_input:
  for a: M.ExitCode
  for b: M.ExitCode
  {Bool.or(Nat.is_eq(M.Trust.rank(M.Trust.worse(a, b)), M.Trust.rank(a)), Nat.is_eq(M.Trust.rank(M.Trust.worse(a, b)), M.Trust.rank(b))) == True{} : Bool}

# P5: the order in which stages exit does not change the run's exit (not "last one wins")
law fold_order_free:
  for a: M.ExitCode
  for b: M.ExitCode
  for c: M.ExitCode
  {M.Trust.worse(M.Trust.worse(a, b), c) == M.Trust.worse(M.Trust.worse(a, c), b) : M.ExitCode}

# P5 witness: an environment failure followed by a verdict failure still exits 3
law fold_env_kept:
  exs t: +List<M.Msg>
  {M.Trust.observe(M.Trust.run(t, M.Trust.init())) == M.ObsExit{M.ExitEnv{}} : M.Obs}

# ── B5 run ledger (P6: S8; Q11 a, adopted in turn 4)

# P6: appending an entry never changes whether the chain verifies
law ledger_append_keeps:
  for xs: +List<M.Line>
  {M.Trust.intact(M.Trust.appendLine(xs)) == M.Trust.intact(xs) : Bool}

# P6: an edited entry breaks the chain
law ledger_edit_breaks:
  for h: M.Line
  for t: +List<M.Line>
  {M.Trust.intact(M.Trust.editFirst(h <> t)) == False{} : Bool}

# P6: a removed entry that had a successor breaks the chain
law ledger_remove_breaks:
  for h: M.Line
  for h2: M.Line
  for t: +List<M.Line>
  {M.Trust.intact(M.Trust.removeFirst(h <> (h2 <> t))) == False{} : Bool}

# P6: a line cut part-way (truncated) breaks the chain
law ledger_tear_breaks:
  for t: +List<M.Line>
  for h: M.Line
  {M.Trust.intact(M.Trust.tearLast(h <> t)) == False{} : Bool}

# P6: removing whole trailing entries restores an earlier file exactly, which no chain check can tell apart
law ledger_drop_restores:
  for xs: +List<M.Line>
  {M.Trust.dropLast(M.Trust.appendLine(xs)) == xs : +List<M.Line>}

# P6 witness: a ledger that verifies after appends, and one that reports a broken chain
law ledger_intact_reachable:
  exs t: +List<M.Msg>
  {M.Trust.observe(M.Trust.run(t, M.Trust.init())) == M.ObsChain{True{}} : M.Obs}

law ledger_broken_reachable:
  exs t: +List<M.Msg>
  {M.Trust.observe(M.Trust.run(t, M.Trust.init())) == M.ObsChain{False{}} : M.Obs}

# ── B6 judge retries by cause (P7: S8; Q12 a, adopted in turn 4)

# P7: a judge run starts with two environment retries, one agent-output retry and no retry spent
law judge_starts:
  {M.Trust.step(M.Idle{}, M.Begin{M.PartJudge{}}) == M.Judging{2n, 1n, 0n, M.Attempting{}} : M.Trust}

# P7: an environment failure with budget left retries and records one judge-retry
law judge_env_retries:
  for e: Nat
  for a: Nat
  for r: Nat
  {M.Trust.step(M.Judging{1n+e, a, r, M.Attempting{}}, M.AttemptFailed{M.CauseEnv{}}) == M.Judging{e, a, 1n+r, M.Attempting{}} : M.Trust}

# P7: an environment failure with no budget left raises it, recording no further retry
law judge_env_exhausted:
  for a: Nat
  for r: Nat
  {M.Trust.step(M.Judging{0n, a, r, M.Attempting{}}, M.AttemptFailed{M.CauseEnv{}}) == M.Judging{0n, a, r, M.Raised{M.CauseEnv{}}} : M.Trust}

# P7: unusable agent output with budget left retries and records one judge-retry
law judge_agent_retries:
  for e: Nat
  for a: Nat
  for r: Nat
  {M.Trust.step(M.Judging{e, 1n+a, r, M.Attempting{}}, M.AttemptFailed{M.CauseAgent{}}) == M.Judging{e, a, 1n+r, M.Attempting{}} : M.Trust}

# P7: unusable agent output with no budget left raises it
law judge_agent_exhausted:
  for e: Nat
  for r: Nat
  {M.Trust.step(M.Judging{e, 0n, r, M.Attempting{}}, M.AttemptFailed{M.CauseAgent{}}) == M.Judging{e, 0n, r, M.Raised{M.CauseAgent{}}} : M.Trust}

# P7: any other failure is never retried
law judge_other_raised:
  for e: Nat
  for a: Nat
  for r: Nat
  {M.Trust.step(M.Judging{e, a, r, M.Attempting{}}, M.AttemptFailed{M.CauseOther{}}) == M.Judging{e, a, r, M.Raised{M.CauseOther{}}} : M.Trust}

# P7: a completed attempt is the judgment, whatever its verdict
law judge_completed:
  for e: Nat
  for a: Nat
  for r: Nat
  for v: M.JudgedAs
  {M.Trust.step(M.Judging{e, a, r, M.Attempting{}}, M.AttemptJudged{v}) == M.Judging{e, a, r, M.Judged{v}} : M.Trust}

# P7: a completed judgment is never re-judged, however bad it is
law judge_never_rejudged:
  for e: Nat
  for a: Nat
  for r: Nat
  for v: M.JudgedAs
  for m: M.Msg
  {M.Trust.step(M.Judging{e, a, r, M.Judged{v}}, m) == M.Judging{e, a, r, M.Judged{v}} : M.Trust}

# P7: a raised failure ends the attempts
law judge_raised_final:
  for e: Nat
  for a: Nat
  for r: Nat
  for c: M.Cause
  for m: M.Msg
  {M.Trust.step(M.Judging{e, a, r, M.Raised{c}}, m) == M.Judging{e, a, r, M.Raised{c}} : M.Trust}

# P7 witness: two environment failures, then a completed fail judgment, with two judge-retry entries
law judge_retried_then_judged:
  exs t: +List<M.Msg>
  {M.Trust.observe(M.Trust.run(t, M.Trust.init())) == M.ObsJudge{2n, M.Judged{M.JudgedFail{}}} : M.Obs}

# ── B3 provenance stamps (P4: S7)

# P4: judge proceeds on a matching stamp and on one it cannot establish; it refuses a different one
law prov_judge_matches:
  {M.Trust.step(M.Proving{M.AtJudge{}}, M.Consumed{M.StampMatches{}}) == M.Proving{M.AtReview{}} : M.Trust}

law prov_judge_absent:
  {M.Trust.step(M.Proving{M.AtJudge{}}, M.Consumed{M.StampAbsent{}}) == M.Proving{M.AtReview{}} : M.Trust}

law prov_judge_differs:
  {M.Trust.step(M.Proving{M.AtJudge{}}, M.Consumed{M.StampDiffers{}}) == M.Proving{M.Refused{M.RerunAbstract{}}} : M.Trust}

# P4: review does the same at its boundary and names judge as the command to re-run
law prov_review_matches:
  {M.Trust.step(M.Proving{M.AtReview{}}, M.Consumed{M.StampMatches{}}) == M.Proving{M.Reviewed{}} : M.Trust}

law prov_review_absent:
  {M.Trust.step(M.Proving{M.AtReview{}}, M.Consumed{M.StampAbsent{}}) == M.Proving{M.Reviewed{}} : M.Trust}

law prov_review_differs:
  {M.Trust.step(M.Proving{M.AtReview{}}, M.Consumed{M.StampDiffers{}}) == M.Proving{M.Refused{M.RerunJudge{}}} : M.Trust}

# P4: a refusal ends the run
law prov_refused_final:
  for r: M.Rerun
  for m: M.Msg
  {M.Trust.step(M.Proving{M.Refused{r}}, m) == M.Proving{M.Refused{r}} : M.Trust}

# P4 witness: a run passes both boundaries and is reviewed
law prov_reviewed_reachable:
  exs t: +List<M.Msg>
  {M.Trust.observe(M.Trust.run(t, M.Trust.init())) == M.ObsStamp{M.Reviewed{}} : M.Obs}

# ── R3 layering (P10: S1; Q13 a, adopted in turn 4)

# P10: the core imports only the core
law layer_core_imports_core:
  for t: M.Layer
  {M.Trust.allowed(M.LayerCore{}, t) == M.Trust.isCore(t) : Bool}

# P10: node IO is a leaf
law layer_io_leaf:
  for t: M.Layer
  {M.Trust.allowed(M.LayerNodeIo{}, t) == False{} : Bool}

# P10: no two different layers may import each other, so the layer graph has no cycle
law layer_no_cycle_across:
  for a: M.Layer
  for b: M.Layer
  {Bool.or(Bool.not(Bool.and(M.Trust.allowed(a, b), M.Trust.allowed(b, a))), Nat.is_eq(M.Trust.height(a), M.Trust.height(b))) == True{} : Bool}
