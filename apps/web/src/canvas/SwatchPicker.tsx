export interface SwatchPickerProps {
  /** Element (node/edge) id, for test ids. */
  id: string;
  /** 'fill' | 'stroke' -- which style property these swatches set. */
  kind: 'fill' | 'stroke';
  swatches: string[];
  /** The color currently in effect (explicit or rendered default). */
  value: string | undefined;
  onPick: (hex: string) => void;
  autoFocus?: boolean;
}

/**
 * canvas-tfr: the approved-colors-only alternative to a free `<input type="color">`, used when the
 * selected element's standard element kind (or connector rule) defines swatches. A radio group, so
 * the current choice is announced and arrow keys move between colors; each swatch also carries its
 * hex value as text for anyone who can't distinguish the colors.
 */
export function SwatchPicker({ id, kind, swatches, value, onPick, autoFocus }: SwatchPickerProps) {
  const current = value?.toLowerCase();
  return (
    <div role="radiogroup" aria-label={`Approved ${kind} colors`} className="swatch-picker" data-testid={`style-${kind}-swatches-${id}`}>
      {swatches.map((hex, index) => {
        const selected = hex.toLowerCase() === current;
        return (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${hex}${index === 0 ? ' (default)' : ''}`}
            title={`${hex}${index === 0 ? ' (default)' : ''}`}
            className={`swatch-picker__swatch${selected ? ' swatch-picker__swatch--selected' : ''}`}
            data-testid={`style-${kind}-swatch-${id}-${hex.replace('#', '').toLowerCase()}`}
            style={{ background: hex }}
            autoFocus={autoFocus && (selected || (!current && index === 0))}
            onClick={() => onPick(hex)}
          />
        );
      })}
    </div>
  );
}
