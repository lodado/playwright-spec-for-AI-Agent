// Records baseline.json from the checked-out code. Run once on the unmodified baseline commit 9b2031c:
//   node scripts/__tests__/fixtures/refactor-characterization/record.mjs
// Never re-record after the refactor: that would make the corpus compare the code with itself.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCorpus } from "./corpus.mjs";

const corpus = await computeCorpus();
const target = join(dirname(fileURLToPath(import.meta.url)), "baseline.json");
writeFileSync(target, `${JSON.stringify({ baselineCommit: "9b2031c", ...corpus })}\n`);
console.log(`recorded ${Object.entries(corpus.cases).map(([name, list]) => `${name}=${list.length}`).join(" ")}`);
