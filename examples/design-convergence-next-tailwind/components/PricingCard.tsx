/**
 * Fixture pricing card for the Design Convergence example. Its styles are
 * intentionally off from the Figma reference (Phase 4 classifies the diff); this
 * file only needs a stable `<section>` root, stable copy, and a ready marker.
 * The manual binding in `design-bindings.json` pins this file by content hash
 * and the `<section>` source range.
 */
export function PricingCard() {
  return (
    <section
      data-ready="true"
      className="mx-auto mt-10 w-80 rounded-lg bg-white p-6 text-slate-900"
    >
      <h2 className="text-lg font-semibold">Pro</h2>
      <p className="mt-2 text-4xl font-bold">$29</p>
      <button className="mt-6 w-full rounded-md bg-blue-600 py-2 text-white">
        Start Free
      </button>
    </section>
  );
}
