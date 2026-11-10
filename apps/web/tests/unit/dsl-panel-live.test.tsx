import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DslPanel } from '../../src/canvas/DslPanel';

/** canvas-vvi: the DSL tab while the diagram changes under it (someone else's edit, or the canvas). */

const A = 'flowchart TD\n  a[A]\n';
const B = 'flowchart TD\n  a[A]\n  b[B]\n';

// StrictMode renders twice in development: the panel follows its `dsl` prop during render, so it must cope.
const panel = (dsl: string, onApply = vi.fn()) => (
  <StrictMode>
    <DslPanel dsl={dsl} parseErrors={[]} onApply={onApply} />
  </StrictMode>
);
const text = () => (screen.getByTestId('dsl-panel') as HTMLTextAreaElement).value;

afterEach(cleanup);

describe('DslPanel while the diagram changes', () => {
  it('follows the diagram while nobody is typing', () => {
    const { rerender } = render(panel(A));
    rerender(panel(B));
    expect(text()).toBe(B);
    expect(screen.queryByTestId('dsl-behind')).toBeNull();
  });

  it('keeps what you are typing and says the diagram has changed', () => {
    const { rerender } = render(panel(A));
    fireEvent.change(screen.getByTestId('dsl-panel'), { target: { value: 'flowchart TD\n  a[Mine]\n' } });
    rerender(panel(B));
    expect(text()).toBe('flowchart TD\n  a[Mine]\n');
    expect(screen.getByTestId('dsl-behind')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dsl-load-latest'));
    expect(text()).toBe(B);
    expect(screen.queryByTestId('dsl-behind')).toBeNull();
  });

  it('after Apply, shows the diagram as written back (not "changed while you typed")', () => {
    const onApply = vi.fn();
    const { rerender } = render(panel(A, onApply));
    fireEvent.change(screen.getByTestId('dsl-panel'), { target: { value: 'flowchart TD\n  a[A]\n  b[B]' } });
    fireEvent.click(screen.getByTestId('apply-dsl'));
    expect(onApply).toHaveBeenCalledWith('flowchart TD\n  a[A]\n  b[B]');
    rerender(panel(B, onApply));
    expect(text()).toBe(B);
    expect(screen.queryByTestId('dsl-behind')).toBeNull();
    // And the next change follows too.
    rerender(panel(A, onApply));
    expect(text()).toBe(A);
  });
});
