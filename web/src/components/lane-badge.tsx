import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** 泳道态徽章。态是现算出来的,这里只负责上色。 */
export function LaneBadge({ lane }: { lane: string }) {
  const tone: Record<string, string> = {
    在售: "bg-emerald-600 text-white border-transparent",
    可发布: "bg-sky-600 text-white border-transparent",
    在产: "bg-amber-500 text-white border-transparent",
    停售: "bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={cn("shrink-0 text-[11px]", tone[lane])}>
      {lane}
    </Badge>
  );
}
