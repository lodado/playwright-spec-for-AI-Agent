import Base

# World for one judgment's final verdict (S2 downgrade-only, S3 per-check floors, S4 coverage floor,
# S5 identity matching). Raw world count: 4 * 5 * 4 * 2^6 = 5120.
# One planned check is modelled per judgment (see analyst.md, A2); its reported result is checkResult.

type AgentStatus is Data:
  AgentPass{}
  AgentFail{}
  AgentSkip{}
  AgentManual{}

type CheckResult is Data:
  CheckPass{}
  CheckFail{}
  CheckSkip{}
  CheckManual{}
  CheckGarbled{}

type FinalStatus is Data:
  FinalPass{}
  FinalFail{}
  FinalSkip{}
  FinalManual{}

type Verdict is Data:
  Verdict{agentStatus: AgentStatus, checkResult: CheckResult, finalStatus: FinalStatus, confidenceLow: Bool, evidenceVerified: Bool, causeOk: Bool, checkAddressed: Bool, extraReport: Bool, downgradeNoted: Bool}

def Verdict.imp(a: Bool, b: Bool) -> Bool:
  Bool.or(Bool.not(a), b)

def FinalStatus.isPass(f: FinalStatus) -> Bool:
  match f:
    case FinalPass{}:
      True{}
    case FinalFail{}:
      False{}
    case FinalSkip{}:
      False{}
    case FinalManual{}:
      False{}

def FinalStatus.isFail(f: FinalStatus) -> Bool:
  match f:
    case FinalPass{}:
      False{}
    case FinalFail{}:
      True{}
    case FinalSkip{}:
      False{}
    case FinalManual{}:
      False{}

def FinalStatus.isSkip(f: FinalStatus) -> Bool:
  match f:
    case FinalPass{}:
      False{}
    case FinalFail{}:
      False{}
    case FinalSkip{}:
      True{}
    case FinalManual{}:
      False{}

def FinalStatus.isManual(f: FinalStatus) -> Bool:
  match f:
    case FinalPass{}:
      False{}
    case FinalFail{}:
      False{}
    case FinalSkip{}:
      False{}
    case FinalManual{}:
      True{}

def AgentStatus.isPass(a: AgentStatus) -> Bool:
  match a:
    case AgentPass{}:
      True{}
    case AgentFail{}:
      False{}
    case AgentSkip{}:
      False{}
    case AgentManual{}:
      False{}

def AgentStatus.isFail(a: AgentStatus) -> Bool:
  match a:
    case AgentPass{}:
      False{}
    case AgentFail{}:
      True{}
    case AgentSkip{}:
      False{}
    case AgentManual{}:
      False{}

def AgentStatus.sameAs(a: AgentStatus, f: FinalStatus) -> Bool:
  match a:
    case AgentPass{}:
      FinalStatus.isPass(f)
    case AgentFail{}:
      FinalStatus.isFail(f)
    case AgentSkip{}:
      FinalStatus.isSkip(f)
    case AgentManual{}:
      FinalStatus.isManual(f)

def CheckResult.isPass(c: CheckResult) -> Bool:
  match c:
    case CheckPass{}:
      True{}
    case CheckFail{}:
      False{}
    case CheckSkip{}:
      False{}
    case CheckManual{}:
      False{}
    case CheckGarbled{}:
      False{}

def CheckResult.isSkip(c: CheckResult) -> Bool:
  match c:
    case CheckPass{}:
      False{}
    case CheckFail{}:
      False{}
    case CheckSkip{}:
      True{}
    case CheckManual{}:
      False{}
    case CheckGarbled{}:
      False{}

def CheckResult.isGarbled(c: CheckResult) -> Bool:
  match c:
    case CheckPass{}:
      False{}
    case CheckFail{}:
      False{}
    case CheckSkip{}:
      False{}
    case CheckManual{}:
      False{}
    case CheckGarbled{}:
      True{}

# Assumption A1 (S4): an unaddressed planned check has no reported pass result.
def Verdict.A1(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.not(ca), Bool.not(CheckResult.isPass(c)))

# Assumption A2 (scope, S6 pinned plan): the pinned plan for this judgment has one planned check.
def Verdict.A2(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      True{}

# G1 safety (S2): normalization may lower the agent's verdict, never raise it.
def Verdict.G1(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(FinalStatus.isPass(f), AgentStatus.isPass(a))

# G2 safety (S2): a downgraded verdict always carries its note.
def Verdict.G2(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.not(AgentStatus.sameAs(a, f)), dn)

# G3 safety (S3): a pass without concrete, verified evidence is not a final pass.
def Verdict.G3(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.and(CheckResult.isPass(c), Bool.not(ev)), Bool.not(FinalStatus.isPass(f)))

# G4 safety (S3): an explicit low confidence on a pass is not a final pass.
def Verdict.G4(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.and(CheckResult.isPass(c), cl), Bool.not(FinalStatus.isPass(f)))

# G5 safety (S3): a check result outside pass, fail, skip, manual_review is never a final pass.
def Verdict.G5(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(CheckResult.isGarbled(c), Bool.not(FinalStatus.isPass(f)))

# G6 safety (S3): nothing executed (all checks skip) is not green.
def Verdict.G6(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(CheckResult.isSkip(c), Bool.not(FinalStatus.isPass(f)))

# G7 safety (S4): an unaddressed planned check floors the verdict below pass.
def Verdict.G7(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.not(ca), Bool.not(FinalStatus.isPass(f)))

# G8 safety (S4): an unaddressed planned check appends its note to the summary.
def Verdict.G8(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.not(ca), dn)

# G9 safety (S5): duplicate reports or unplanned IDs prevent a green verdict.
def Verdict.G9(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(er, Bool.not(FinalStatus.isPass(f)))

# G10 safety (S3): a pass always carries cause NONE, modelled as causeOk.
def Verdict.G10(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(FinalStatus.isPass(f), co)

# G11 safety (S2): an agent that says fail is believed.
def Verdict.G11(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(AgentStatus.isFail(a), FinalStatus.isFail(f))

# G12 witness (S2 "an agent that says pass has to show its work"): a pass that shows its work is reachable.
def Verdict.G12(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Bool.and(AgentStatus.isPass(a), Bool.and(CheckResult.isPass(c), Bool.and(ev, Bool.and(Bool.not(cl), Bool.and(ca, Bool.and(Bool.not(er), Bool.and(co, FinalStatus.isPass(f))))))))

# G13 witness (S2, S3): an agent pass without verified evidence is downgraded with its note, and the path is reachable.
def Verdict.G13(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Bool.and(AgentStatus.isPass(a), Bool.and(CheckResult.isPass(c), Bool.and(Bool.not(ev), Bool.and(Bool.not(FinalStatus.isPass(f)), dn))))

# ── Contract predicates (author: controller), named by model symbol. Everything above this line is the
# analyst's world byte for byte (sha256 89bab1ca…0d0a, .ai/oracles/refactor-modularity/sources/analyst.md).
# The Oracle card gives these rows their O* IDs when it is projected.

# severity of a final status, worst last (S2: floors lower a pass to manual_review; an agent fail is
# believed). FinalSkip is never produced; it ranks apart so equality stays exact.
def Verdict.rank(f: FinalStatus) -> Nat:
  match f:
    case FinalPass{}:
      0n
    case FinalManual{}:
      1n
    case FinalFail{}:
      2n
    case FinalSkip{}:
      3n

def Verdict.pick(later: Bool, a: FinalStatus, b: FinalStatus) -> FinalStatus:
  match later:
    case True{}:
      b
    case False{}:
      a

def Verdict.worst(+a: FinalStatus, +b: FinalStatus) -> FinalStatus:
  Verdict.pick(Nat.is_gt(Verdict.rank(b), Verdict.rank(a)), a, b)

def Verdict.same(+a: FinalStatus, +b: FinalStatus) -> Bool:
  Nat.is_eq(Verdict.rank(a), Verdict.rank(b))

# the agent's top-level claim; an unrecognised status claims manual_review (Q15 a, adopted in turn 4)
def Verdict.claim(a: AgentStatus) -> FinalStatus:
  match a:
    case AgentPass{}:
      FinalPass{}
    case AgentFail{}:
      FinalFail{}
    case AgentSkip{}:
      FinalManual{}
    case AgentManual{}:
      FinalManual{}

def Verdict.unrecognisedClaim(a: AgentStatus) -> Bool:
  match a:
    case AgentPass{}:
      False{}
    case AgentFail{}:
      False{}
    case AgentSkip{}:
      True{}
    case AgentManual{}:
      False{}

def Verdict.passFloor(unsupported: Bool) -> FinalStatus:
  match unsupported:
    case True{}:
      FinalManual{}
    case False{}:
      FinalPass{}

# the check's own contribution (S3; Q16 a, adopted in turn 4): a failed check derives fail; a pass without verified
# evidence or with an explicit low confidence, a skip (nothing executed), a manual_review and an unrecognised
# result derive manual_review
def Verdict.fromCheck(c: CheckResult, cl: Bool, ev: Bool) -> FinalStatus:
  match c:
    case CheckPass{}:
      Verdict.passFloor(Bool.or(cl, Bool.not(ev)))
    case CheckFail{}:
      FinalFail{}
    case CheckSkip{}:
      FinalManual{}
    case CheckManual{}:
      FinalManual{}
    case CheckGarbled{}:
      FinalManual{}

def Verdict.floorIf(hit: Bool) -> FinalStatus:
  match hit:
    case True{}:
      FinalManual{}
    case False{}:
      FinalPass{}

# derived from the checks, the coverage floor (S4) and the identity floor (S5; Q16 a, adopted in turn 4 manual_review)
def Verdict.derived(c: CheckResult, cl: Bool, ev: Bool, ca: Bool, er: Bool) -> FinalStatus:
  Verdict.worst(Verdict.fromCheck(c, cl, ev), Verdict.worst(Verdict.floorIf(Bool.not(ca)), Verdict.floorIf(er)))

# a floor of S3–S5 fired, or the agent's status was not one the harness recognises
def Verdict.floorFired(a: AgentStatus, +c: CheckResult, cl: Bool, ev: Bool, ca: Bool, er: Bool) -> Bool:
  Bool.or(Bool.and(CheckResult.isPass(c), Bool.or(cl, Bool.not(ev))), Bool.or(CheckResult.isSkip(c), Bool.or(CheckResult.isGarbled(c), Bool.or(Bool.not(ca), Bool.or(er, Verdict.unrecognisedClaim(a))))))

# P1 P2: the final status is exactly worst(agent claim, derived) — never above the agent's claim, never a
# pass that a floor caught
def Verdict.finalIsWorst(w: Verdict) -> Bool:
  match w:
    case Verdict{+a, +c, f, +cl, +ev, co, +ca, +er, dn}:
      Verdict.same(f, Verdict.worst(Verdict.claim(a), Verdict.derived(c, cl, ev, ca, er)))

# P3: the summary carries a `Verdict floor applied` note exactly when a floor fired or the final status is not
# the agent's own claim (Q17 a, adopted in turn 4)
def Verdict.noteExplainsDowngrade(w: Verdict) -> Bool:
  match w:
    case Verdict{+a, +c, +f, +cl, +ev, co, +ca, +er, dn}:
      Bool.not(Bool.xor(dn, Bool.or(Verdict.floorFired(a, c, cl, ev, ca, er), Bool.not(Verdict.same(f, Verdict.claim(a))))))

# P1: a pass carries cause NONE and a non-pass a recognised cause — the normalized cause is always consistent
def Verdict.causeConsistent(w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      co

# A3 (author: controller, owner: harness): with one planned check and no other report, the agent reported no
# check at all, which the product reads as nothing executed — so an unaddressed check without an extra report
# carries the skip result. An unaddressed check with an extra report is built as an unplanned ID with any result.
# The analyst's A1 is not used as an assumption: it would hide worlds the product must floor.
def Verdict.A3(+w: Verdict) -> Bool:
  match w:
    case Verdict{a, c, f, cl, ev, co, ca, er, dn}:
      Verdict.imp(Bool.and(Bool.not(ca), Bool.not(er)), CheckResult.isSkip(c))
