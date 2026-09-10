/**
 * Pure dedup decisions live in the `hevy2garmin` package (shared with soma).
 * Re-exported so routes keep importing from "@/lib/dedup".
 */
export {
  filterUnsynced,
  isUnsynced,
  pickNextUnsynced,
  summarizeDedup,
  type DedupSummary,
  type DedupWorkout,
} from "hevy2garmin";
