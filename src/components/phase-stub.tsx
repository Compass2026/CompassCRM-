import { Card, CardContent } from "@/components/ui/card";

export function PhaseStub({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent className="py-10 text-center space-y-2">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          {description}
        </p>
        <p className="text-xs text-muted-foreground">Coming in {phase}.</p>
      </CardContent>
    </Card>
  );
}
