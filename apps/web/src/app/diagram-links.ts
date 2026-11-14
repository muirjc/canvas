// canvas-8uh1.3: drill-down links in the editor (docs/composite-diagrams-design.md). A link is an element's
// `diagramRef` (in the diagram's own text); what it points at -- its title, project, and whether it can be opened --
// comes from the API: the links index for the saved diagram (GET /diagrams/:id/links), and a read of the diagram
// for a link made since the last save.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagramModel } from '@canvas/diagram-core';
import { api, ApiError, type DiagramLinkDto } from './api';

export type LinkStatus = DiagramLinkDto['status'] | 'checking';

export interface LinkTarget {
  status: LinkStatus;
  name?: string;
  diagramTypeId?: string;
  projectId?: string;
  projectName?: string;
}

export interface ElementLink {
  elementId: string;
  /** The element's label, for lists ("Payments System"). */
  label: string;
  kind: 'node' | 'container';
  diagramId: string;
}

/** Every element that links to a diagram: shapes first, then groups, in the model's order. */
export function elementLinks(model: DiagramModel): ElementLink[] {
  return [
    ...model.nodes.flatMap((n) => (n.diagramRef ? [{ elementId: n.id, label: n.label || n.id, kind: 'node' as const, diagramId: n.diagramRef.diagramId }] : [])),
    ...model.containers.flatMap((c) =>
      c.diagramRef ? [{ elementId: c.id, label: c.label || c.id, kind: 'container' as const, diagramId: c.diagramRef.diagramId }] : [],
    ),
  ];
}

/** The type one level down (C4's zoom: a System opens its Container diagram), offered first in the picker. */
export const SUGGESTED_LINK_TYPES: Record<string, string[]> = {
  'c4-context': ['c4-container'],
  'c4-container': ['c4-component'],
  'c4-component': ['c4-code'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a link's status means, in a sentence for tooltips and lists. */
export function linkStatusText(target: LinkTarget | undefined): string {
  switch (target?.status) {
    case 'available':
      return target.name ? `Opens ${target.name}` : 'Opens the linked diagram';
    case 'unavailable':
      return "The linked diagram is someone else's unsaved draft";
    case 'deleted':
      return 'The linked diagram is in the bin';
    case 'missing':
      return 'The linked diagram no longer exists';
    default:
      return 'Checking the linked diagram…';
  }
}

/**
 * The targets of the diagram's links, by diagram id. Loaded from the links index when the diagram opens and
 * after each save (`refreshToken`); a link made since (a new id) is looked up on its own. `remember` records a
 * target the picker already knows, so a new link shows its title at once.
 */
export function useLinkTargets(diagramId: string, model: DiagramModel, refreshToken: number) {
  const [targets, setTargets] = useState<Map<string, LinkTarget>>(new Map());
  const asked = useRef(new Set<string>());

  const remember = useCallback((id: string, target: LinkTarget) => {
    asked.current.add(id);
    setTargets((prev) => new Map(prev).set(id, target));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A target still unchecked (its lookup failed for a reason other than 404) is looked up again after a save.
    setTargets((prev) => {
      for (const [id, target] of prev) if (target.status === 'checking') asked.current.delete(id);
      return prev;
    });
    api
      .getDiagramLinks(diagramId)
      .then(({ links }) => {
        if (cancelled) return;
        setTargets((prev) => {
          const next = new Map(prev);
          for (const link of links) {
            asked.current.add(link.diagramId);
            next.set(link.diagramId, {
              status: link.status,
              ...(link.diagram
                ? { name: link.diagram.name, diagramTypeId: link.diagram.diagramTypeId, projectId: link.diagram.projectId, projectName: link.diagram.projectName }
                : {}),
            });
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diagramId, refreshToken]);

  const wanted = elementLinks(model)
    .map((l) => l.diagramId)
    .filter((id, i, all) => all.indexOf(id) === i && !asked.current.has(id));
  const wantedKey = wanted.join(',');
  useEffect(() => {
    if (!wantedKey) return;
    for (const id of wantedKey.split(',')) {
      asked.current.add(id);
      if (!UUID.test(id)) {
        setTargets((prev) => new Map(prev).set(id, { status: 'missing' }));
        continue;
      }
      setTargets((prev) => new Map(prev).set(id, { status: 'checking' }));
      api
        .getDiagram(id)
        .then(({ diagram }) =>
          setTargets((prev) => new Map(prev).set(id, { status: 'available', name: diagram.name, diagramTypeId: diagram.diagramTypeId, projectId: diagram.projectId })),
        )
        // A 404 is a diagram that's gone, in the bin or someone else's draft; the save tells them apart.
        .catch((error: unknown) =>
          setTargets((prev) => new Map(prev).set(id, { status: error instanceof ApiError && error.status === 404 ? 'missing' : 'checking' })),
        );
    }
  }, [wantedKey]);

  return { targets, remember };
}
