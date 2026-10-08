import Base
import ./MODEL.bend as M
import ./LAWS.bend as Laws

# Proof candidate (not locked). Finite domains are split case by case (generated); lists by induction.

def Laws.fold_takes_worse(w, c):
  {==}

def Laws.fold_dominates(a, b):
  match a b:
    case M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}

def Laws.fold_keeps_an_input(a, b):
  match a b:
    case M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}

def Laws.fold_order_free(a, b, c):
  match a b c:
    case M.ExitOk{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitOk{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitVerdict{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitUsage{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitAgent{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitEnv{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitOddLow{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitOk{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitVerdict{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitUsage{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitAgent{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitEnv{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddLow{} M.ExitOddHigh{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitOk{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitVerdict{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitUsage{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitAgent{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitEnv{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitOddLow{}:
      {==}
    case M.ExitOddHigh{} M.ExitOddHigh{} M.ExitOddHigh{}:
      {==}

def Laws.fold_env_kept():
  ([M.Begin{M.PartFold{}}, M.StageExit{M.ExitEnv{}}, M.StageExit{M.ExitVerdict{}}], {==})

def Laws.ledger_append_keeps(xs):
  match xs:
    case Nil{}:
      {==}
    case Con{+h, t}:
      %Laws.ledger_append_keeps(t) : {Bool.and(M.Trust.lineIntact(h), M.Trust.intact(M.Trust.appendLine(t))) == Bool.and(M.Trust.lineIntact(h), _) : Bool}
      {==}

def Laws.ledger_edit_breaks(h, t):
  match h:
    case M.LineOk{}:
      {==}
    case M.LineEdited{}:
      {==}
    case M.LineUnlinked{}:
      {==}
    case M.LineTorn{}:
      {==}

def Laws.ledger_remove_breaks(h, h2, t):
  match h2:
    case M.LineOk{}:
      {==}
    case M.LineEdited{}:
      {==}
    case M.LineUnlinked{}:
      {==}
    case M.LineTorn{}:
      {==}

def Laws.ledger_tear_breaks(t, h):
  match t h:
    case Nil{} M.LineOk{}:
      {==}
    case Nil{} M.LineEdited{}:
      {==}
    case Nil{} M.LineUnlinked{}:
      {==}
    case Nil{} M.LineTorn{}:
      {==}
    case Con{h2, t2} M.LineOk{}:
      Laws.ledger_tear_breaks(t2, h2)
    case Con{h2, t2} M.LineEdited{}:
      {==}
    case Con{h2, t2} M.LineUnlinked{}:
      {==}
    case Con{h2, t2} M.LineTorn{}:
      {==}

def Laws.ledger_drop_restores(xs):
  match xs:
    case Nil{}:
      {==}
    case Con{+h, t}:
      match t:
        case Nil{}:
          {==}
        case Con{+h2, +t2}:
          %Laws.ledger_drop_restores(h2 <> t2) : {h <> M.Trust.dropCons(M.Trust.appendLine(t2), h2) == h <> _ : +List<M.Line>}
          {==}

def Laws.ledger_intact_reachable():
  ([M.Begin{M.PartLedger{}}, M.Append{}, M.Append{}], {==})

def Laws.ledger_broken_reachable():
  ([M.Begin{M.PartLedger{}}, M.Append{}, M.Tampered{M.EditFirst{}}], {==})

def Laws.judge_starts():
  {==}

def Laws.judge_env_retries(e, a, r):
  {==}

def Laws.judge_env_exhausted(a, r):
  {==}

def Laws.judge_agent_retries(e, a, r):
  {==}

def Laws.judge_agent_exhausted(e, r):
  {==}

def Laws.judge_other_raised(e, a, r):
  {==}

def Laws.judge_completed(e, a, r, v):
  {==}

def Laws.judge_never_rejudged(e, a, r, v, m):
  match m:
    case M.Begin{p}:
      {==}
    case M.StageExit{c}:
      {==}
    case M.Append{}:
      {==}
    case M.Tampered{h}:
      {==}
    case M.AttemptFailed{c}:
      {==}
    case M.AttemptJudged{w}:
      {==}
    case M.Consumed{s}:
      {==}

def Laws.judge_raised_final(e, a, r, c, m):
  match m:
    case M.Begin{p}:
      {==}
    case M.StageExit{c}:
      {==}
    case M.Append{}:
      {==}
    case M.Tampered{h}:
      {==}
    case M.AttemptFailed{c}:
      {==}
    case M.AttemptJudged{w}:
      {==}
    case M.Consumed{s}:
      {==}

def Laws.prov_refused_final(r, m):
  match m:
    case M.Begin{p}:
      {==}
    case M.StageExit{c}:
      {==}
    case M.Append{}:
      {==}
    case M.Tampered{h}:
      {==}
    case M.AttemptFailed{c}:
      {==}
    case M.AttemptJudged{w}:
      {==}
    case M.Consumed{s}:
      {==}

def Laws.judge_retried_then_judged():
  ([M.Begin{M.PartJudge{}}, M.AttemptFailed{M.CauseEnv{}}, M.AttemptFailed{M.CauseEnv{}}, M.AttemptJudged{M.JudgedFail{}}], {==})

def Laws.prov_judge_matches():
  {==}

def Laws.prov_judge_absent():
  {==}

def Laws.prov_judge_differs():
  {==}

def Laws.prov_review_matches():
  {==}

def Laws.prov_review_absent():
  {==}

def Laws.prov_review_differs():
  {==}

def Laws.prov_reviewed_reachable():
  ([M.Begin{M.PartProvenance{}}, M.Consumed{M.StampMatches{}}, M.Consumed{M.StampAbsent{}}], {==})

def Laws.layer_core_imports_core(t):
  match t:
    case M.LayerCli{}:
      {==}
    case M.LayerPipeline{}:
      {==}
    case M.LayerInfra{}:
      {==}
    case M.LayerConfig{}:
      {==}
    case M.LayerCore{}:
      {==}
    case M.LayerNodeIo{}:
      {==}

def Laws.layer_io_leaf(t):
  match t:
    case M.LayerCli{}:
      {==}
    case M.LayerPipeline{}:
      {==}
    case M.LayerInfra{}:
      {==}
    case M.LayerConfig{}:
      {==}
    case M.LayerCore{}:
      {==}
    case M.LayerNodeIo{}:
      {==}

def Laws.layer_no_cycle_across(a, b):
  match a b:
    case M.LayerCli{} M.LayerCli{}:
      {==}
    case M.LayerCli{} M.LayerPipeline{}:
      {==}
    case M.LayerCli{} M.LayerInfra{}:
      {==}
    case M.LayerCli{} M.LayerConfig{}:
      {==}
    case M.LayerCli{} M.LayerCore{}:
      {==}
    case M.LayerCli{} M.LayerNodeIo{}:
      {==}
    case M.LayerPipeline{} M.LayerCli{}:
      {==}
    case M.LayerPipeline{} M.LayerPipeline{}:
      {==}
    case M.LayerPipeline{} M.LayerInfra{}:
      {==}
    case M.LayerPipeline{} M.LayerConfig{}:
      {==}
    case M.LayerPipeline{} M.LayerCore{}:
      {==}
    case M.LayerPipeline{} M.LayerNodeIo{}:
      {==}
    case M.LayerInfra{} M.LayerCli{}:
      {==}
    case M.LayerInfra{} M.LayerPipeline{}:
      {==}
    case M.LayerInfra{} M.LayerInfra{}:
      {==}
    case M.LayerInfra{} M.LayerConfig{}:
      {==}
    case M.LayerInfra{} M.LayerCore{}:
      {==}
    case M.LayerInfra{} M.LayerNodeIo{}:
      {==}
    case M.LayerConfig{} M.LayerCli{}:
      {==}
    case M.LayerConfig{} M.LayerPipeline{}:
      {==}
    case M.LayerConfig{} M.LayerInfra{}:
      {==}
    case M.LayerConfig{} M.LayerConfig{}:
      {==}
    case M.LayerConfig{} M.LayerCore{}:
      {==}
    case M.LayerConfig{} M.LayerNodeIo{}:
      {==}
    case M.LayerCore{} M.LayerCli{}:
      {==}
    case M.LayerCore{} M.LayerPipeline{}:
      {==}
    case M.LayerCore{} M.LayerInfra{}:
      {==}
    case M.LayerCore{} M.LayerConfig{}:
      {==}
    case M.LayerCore{} M.LayerCore{}:
      {==}
    case M.LayerCore{} M.LayerNodeIo{}:
      {==}
    case M.LayerNodeIo{} M.LayerCli{}:
      {==}
    case M.LayerNodeIo{} M.LayerPipeline{}:
      {==}
    case M.LayerNodeIo{} M.LayerInfra{}:
      {==}
    case M.LayerNodeIo{} M.LayerConfig{}:
      {==}
    case M.LayerNodeIo{} M.LayerCore{}:
      {==}
    case M.LayerNodeIo{} M.LayerNodeIo{}:
      {==}
