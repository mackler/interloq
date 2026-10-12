// The state labels of the GitLab adapter's tests: four, since an item is deployed when its issue is closed.
import type { GitlabLabels } from "../src/schema.ts";

export const PROJECT = "adammackler/iou-notes";
export const GITLAB_LABELS: GitlabLabels = { unrefined: "Unrefined", refined: "Refined", implementing: "Implementing", implemented: "Implemented" };
