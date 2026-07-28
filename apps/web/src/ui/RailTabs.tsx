import { useRef, useState, type ReactNode } from 'react';

export interface RailTab {
  id: string;
  label: string;
  /** Optional trailing badge (e.g. the outstanding violation count). Rendered next to the label,
   *  never as the sole carrier of meaning (FR-006). */
  badge?: ReactNode;
  render: () => ReactNode;
}

export interface RailTabsProps {
  tabs: RailTab[];
  /** Tab shown on mount. The editor always passes `dsl` (FR-012) rather than remembering the
   *  last-used tab, which would make the editor's initial state non-deterministic. */
  initialTabId: string;
  'aria-label': string;
}

/**
 * The editor's secondary rail: a WAI-ARIA tabs pattern over the DSL, chat, violations, and
 * version-history panels.
 *
 * MOUNTING STRATEGY (research §2) — lazy-mount, then keep alive:
 *   - A panel is not mounted until its tab is first selected, so opening a diagram costs no
 *     extra network requests. `ChatPanel` and `VersionHistory` both fetch on mount, so eagerly
 *     mounting all four would fire two requests every time any diagram is opened.
 *   - Once mounted a panel stays mounted, hidden with `hidden` rather than unmounted. Unmounting
 *     would refetch on every return and — worse — discard an unsent chat draft and the chat
 *     scroll position.
 */
export function RailTabs({ tabs, initialTabId, 'aria-label': ariaLabel }: RailTabsProps) {
  const [activeId, setActiveId] = useState(initialTabId);
  // Panels selected at least once. A Set in a ref-backed state value: order is irrelevant and we
  // only ever add, so identity churn does not matter.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([initialTabId]));
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activate = (id: string) => {
    setActiveId(id);
    setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    activate(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <>
      <div className="rail-tabs" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            type="button"
            className="rail-tab"
            role="tab"
            id={`rail-tab-${tab.id}`}
            data-testid={`rail-tab-${tab.id}`}
            aria-selected={activeId === tab.id}
            aria-controls={`rail-panel-${tab.id}`}
            tabIndex={activeId === tab.id ? 0 : -1}
            onClick={() => activate(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {tab.label}
            {tab.badge}
          </button>
        ))}
      </div>

      {tabs
        .filter((tab) => mounted.has(tab.id))
        .map((tab) => (
          <div
            key={tab.id}
            className="rail-panel"
            role="tabpanel"
            id={`rail-panel-${tab.id}`}
            aria-labelledby={`rail-tab-${tab.id}`}
            hidden={activeId !== tab.id}
          >
            {tab.render()}
          </div>
        ))}
    </>
  );
}
