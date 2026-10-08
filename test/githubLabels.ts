// The stage labels of the GitHub adapter's tests (issue #120, part 1).
import type { GithubLabels } from "../src/schema.ts";

export const LABELS: GithubLabels = { unrefined: "stage: unrefined", refining: "stage: refining", refined: "stage: refined", implementing: "stage: implementing", implemented: "stage: implemented", deployed: "stage: deployed" };
