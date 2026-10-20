import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, type MarkdownSection } from './markdown-table.js';

/**
 * canvas-73s.1-.5: helpers shared by every TemplateCompiler, lifted out of the C4 Context compiler
 * (canvas-73s) once the other diagram families needed the same section lookup, id allocation and
 * error shape.
 */

/** A section whose heading, minus any leading "3." number, starts with `match` (lower case). */
export function findSection(sections: MarkdownSection[], match: string): MarkdownSection | undefined {
  const normalize = (s: string) => s.replace(/^\d+\.\s*/, '').trim().toLowerCase();
  return sections.find((s) => normalize(s.heading).startsWith(match));
}

/** A compile error. Templates have no meaningful DSL line, so line/content are empty. */
export function err(message: string): ParseError {
  return { line: 0, content: '', message };
}

/** A metadata table is "Field | Value", one row per field -- read as a field -> value map. */
export function readMetadataFields(section: MarkdownSection): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of extractFirstTable(section.body)) {
    const field = row['Field'];
    if (field !== undefined) fields.set(field.trim(), (row['Value'] ?? '').trim());
  }
  return fields;
}

/** The first non-blank value among several possible column headers (the long form in the template
 *  doc, a shorter one a person might type), trimmed. */
export function cell(row: Record<string, string>, ...headers: string[]): string {
  for (const header of headers) {
    const value = row[header]?.trim();
    if (value) return value;
  }
  return '';
}

/** "Payment Gateway" -> "paymentGateway", "API Gateway" -> "apiGateway". Non-alphanumeric
 *  characters separate tokens; the first is lowercased (wholly, if it's all capitals, so an acronym
 *  doesn't become "aPI"), later ones capitalized. No letters/digits at all gives `fallback`. */
export function camelSlug(name: string, fallback = 'entity'): string {
  const tokens = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return fallback;
  return tokens
    .map((token, i) =>
      i === 0
        ? token === token.toUpperCase()
          ? token.toLowerCase()
          : token.charAt(0).toLowerCase() + token.slice(1)
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Hands out unique DSL ids from display names. The first use of a slug keeps it; each later
 * collision gets a numeric suffix (never a silent merge of two rows that slugify alike). One
 * allocator per DSL id namespace.
 */
export class AliasAllocator {
  private used = new Map<string, number>();

  constructor(private readonly slug: (name: string) => string = (name) => camelSlug(name)) {}

  allocate(name: string): string {
    const base = this.slug(name);
    const count = this.used.get(base) ?? 0;
    this.used.set(base, count + 1);
    return count === 0 ? base : `${base}${count + 1}`;
  }
}

/** Case-insensitive match of `value` against `options`; returns the canonical option or undefined. */
export function pickOption<T extends string>(value: string, options: readonly T[]): T | undefined {
  const wanted = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted);
}

/** Yes/No cell: blank -> `fallback`; anything else must read as yes/no. */
export function readYesNo(value: string, fallback: boolean): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return fallback;
  if (['yes', 'y', 'true'].includes(v)) return true;
  if (['no', 'n', 'false'].includes(v)) return false;
  return undefined;
}

/** A comma-separated cell, trimmed, blanks dropped. */
export function listCell(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
