import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_MERMAID_VERSION, MERMAID_SYNTAX_VERSION, mermaidMajorVersion } from '@canvas/diagram-core';
import { AdminOverview } from '../../src/admin/AdminOverview';
import { api } from '../../src/app/api';

/** canvas-7p3y: the Mermaid version panel on the Admin overview. */
describe('AdminOverview Mermaid version panel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows both versions, the checked date, the major-version note when GitHub is a major ahead, and what is not read yet', async () => {
    vi.spyOn(api, 'getAdminOverview').mockResolvedValue({
      overview: { userCount: 1, standardsCount: 2, publishedStandardsCount: 1, libraryCount: 3 },
    } as never);
    vi.spyOn(api, 'getAppSettings').mockResolvedValue({ sharingEnabled: false } as never);
    render(<AdminOverview />);
    await waitFor(() => expect(screen.getByTestId('mermaid-version-panel')).toBeTruthy());
    expect(screen.getByTestId('mermaid-syntax-version').textContent).toContain(`Mermaid ${MERMAID_SYNTAX_VERSION} syntax`);
    expect(screen.getByTestId('github-mermaid-version').textContent).toContain(`Mermaid ${GITHUB_MERMAID_VERSION.version}`);
    expect(screen.getByTestId('github-mermaid-version').textContent).toContain('5 Nov 2026');
    if (mermaidMajorVersion(GITHUB_MERMAID_VERSION.version) > mermaidMajorVersion(MERMAID_SYNTAX_VERSION)) {
      expect(screen.getByTestId('mermaid-major-note').textContent).toContain('differently');
    } else {
      expect(screen.queryByTestId('mermaid-major-note')).toBeNull();
    }
    expect(screen.getByText('Flowchart:')).toBeTruthy();
    expect(screen.getByText(/Class \(UML\), Entity relationship have nothing missing|Entity relationship, Class \(UML\) have nothing missing/)).toBeTruthy();
  });
});
