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

/** canvas-8uh1.5: each linked diagram's type, by id, for the standards rule "should link to" (only those known). */
export function linkTargetTypes(targets: Map<string, LinkTarget>): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [id, target] of targets) if (target.status === 'available' && target.diagramTypeId) types[id] = target.diagramTypeId;
  return types;
}

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
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const asked = useRef(new Set<string>());
  // The links index answers first: a link to a diagram in the bin reads as a 404 when looked up on its own, so a
  // separate lookup that won the race would call it "missing" instead of "deleted".
  const [indexed, setIndexed] = useState(false);

  const remember = useCallback((id: string, target: LinkTarget) => {
    asked.current.add(id);
    setTargets((prev) => new Map(prev).set(id, target));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A target still unchecked (its lookup failed for a reason other than 404) is looked up again after a save.
    for (const [id, target] of targetsRef.current) if (target.status === 'checking') asked.current.delete(id);
    api
      .getDiagramLinks(diagramId)
      .then(({ links }) => {
        if (cancelled) return;
        for (const link of links) asked.current.add(link.diagramId);
        setTargets((prev) => {
          const next = new Map(prev);
          for (const link of links) {
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
      .catch(() => undefined)
      .finally(() => !cancelled && setIndexed(true));
    return () => {
      cancelled = true;
    };
  }, [diagramId, refreshToken]);

  // Links the index doesn't know yet (made since the last save) are looked up one by one.
  const wantedKey = indexed
    ? elementLinks(model)
        .map((l) => l.diagramId)
        .filter((id, i, all) => all.indexOf(id) === i && !asked.current.has(id))
        .join(',')
    : '';
  useEffect(() => {
    if (!wantedKey) return;
    // Only fills in a target nothing better has answered for since (the index after a save wins).
    const settle = (id: string, target: LinkTarget) =>
      setTargets((prev) => (prev.get(id)?.status === 'checking' ? new Map(prev).set(id, target) : prev));
    for (const id of wantedKey.split(',')) {
      asked.current.add(id);
      if (!UUID.test(id)) {
        setTargets((prev) => new Map(prev).set(id, { status: 'missing' }));
        continue;
      }
      setTargets((prev) => (prev.has(id) ? prev : new Map(prev).set(id, { status: 'checking' })));
      api
        .getDiagram(id)
        .then(({ diagram }) => settle(id, { status: 'available', name: diagram.name, diagramTypeId: diagram.diagramTypeId, projectId: diagram.projectId }))
        // A 404 is a diagram that's gone, in the bin or someone else's draft; the next save tells them apart.
        .catch((error: unknown) => settle(id, { status: error instanceof ApiError && error.status === 404 ? 'missing' : 'checking' }));
    }
  }, [wantedKey]);

  return { targets, remember };
}
