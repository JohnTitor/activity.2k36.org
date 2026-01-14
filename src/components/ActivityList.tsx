import type { ActivityItem as ActivityItemType } from "../lib/activity/types";
import { ActivityItem } from "./ActivityItem";

function dotColor(kind: ActivityItemType["kind"], reviewState?: ActivityItemType["reviewState"]) {
  switch (kind) {
    case "issue_opened":
      return "bg-emerald-500";
    case "pull_request_opened":
      return "bg-sky-500";
    case "pull_request_reopened":
      return "bg-sky-500";
    case "pull_request_closed":
      return "bg-zinc-500";
    case "pull_request_merged":
      return "bg-violet-500";
    case "issue_or_pr_comment":
      return "bg-amber-500";
    case "pull_request_review": {
      switch (reviewState) {
        case "approved":
          return "bg-emerald-500";
        case "changes_requested":
          return "bg-rose-500";
        case "commented":
          return "bg-violet-500";
        default:
          return "bg-violet-500";
      }
    }
    case "pull_request_review_comment":
      return "bg-violet-500";
    case "release_published":
      return "bg-fuchsia-500";
    default:
      return "bg-zinc-500";
  }
}

export function ActivityList({ items }: { items: ActivityItemType[] }) {
  return (
    <ol className="relative grid gap-6 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-zinc-200/70 before:content-[''] dark:before:bg-zinc-800/70">
      {items.map((item) => (
        <li key={item.id} className="relative pl-10">
          <span
            className={`absolute left-2.5 top-6 h-3 w-3 rounded-full ring-4 ring-zinc-50 ${dotColor(
              item.kind,
              item.reviewState,
            )} dark:ring-zinc-950`}
            aria-hidden="true"
          />
          <ActivityItem item={item} />
        </li>
      ))}
    </ol>
  );
}
