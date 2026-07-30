import { PricingCard } from "../../components/PricingCard";

/**
 * The single case route. `data-page-ready` is used only for deterministic
 * waiting in Phase 4; this page asserts nothing about design correctness.
 */
export default function PricingPage() {
  return (
    <main data-page-ready="true">
      <PricingCard />
    </main>
  );
}
