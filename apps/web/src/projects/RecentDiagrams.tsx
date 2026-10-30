import { useEffect, useState } from 'react';
import { api } from '../app/api';
import { readRecentDiagrams, replaceRecentDiagrams, type RecentDiagram } from './recent-diagrams';

/**
 * canvas-93n: "Recently opened" on the Projects page -- up to five diagrams this person opened on
 * this browser, newest first. Each is checked with the server first, so only diagrams they can
 * still open are shown, under their current names.
 */
export function RecentDiagrams({ userId, onOpenDiagram, diagramHref }: { userId: string; onOpenDiagram: (id: string) => void; diagramHref: (id: string) => string }) {
  const [recent, setRecent] = useState<RecentDiagram[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stored = readRecentDiagrams(userId);
    if (stored.length === 0) {
      setRecent([]);
      return;
    }
    void Promise.all(
      stored.map((entry) =>
        api
          .getDiagram(entry.id)
          .then(({ diagram }) => (diagram.draft ? null : { ...entry, name: diagram.name }))
          .catch(() => null),
      ),
    ).then((checked) => {
      if (cancelled) return;
      const available = checked.filter((d): d is RecentDiagram => d !== null);
      replaceRecentDiagrams(userId, available);
      setRecent(available);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!recent || recent.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="recent-diagrams-heading" data-testid="recent-diagrams">
      <h2 className="section-label" id="recent-diagrams-heading">
        Recently opened
      </h2>
      <ul className="recent-diagrams">
        {recent.map((d) => (
          <li key={d.id}>
            <a
              href={diagramHref(d.id)}
              data-testid={`recent-diagram-${d.id}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpenDiagram(d.id);
              }}
            >
              {d.name}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
