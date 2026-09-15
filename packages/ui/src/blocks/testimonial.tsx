import { Card, CardContent } from "../primitives/card";
import { Container, Section } from "../layout/primitives";

export function Testimonial({
  quote,
  author,
  role,
}: {
  quote: string;
  author: string;
  role?: string;
}) {
  return (
    <Section>
      <Container className="max-w-2xl">
        <Card>
          <CardContent className="pt-6">
            <blockquote className="text-lg italic">&ldquo;{quote}&rdquo;</blockquote>
            <p className="mt-4 text-sm font-medium">{author}</p>
            {role ? <p className="text-sm text-muted-foreground">{role}</p> : null}
          </CardContent>
        </Card>
      </Container>
    </Section>
  );
}
