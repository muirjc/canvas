import type { DiagramModel } from '../model/diagram-model.js';

export interface ParseError {
  line: number;
  content: string;
  message: string;
}

export type ParseResult = { model: DiagramModel } | { errors: ParseError[] };

export function isParseSuccess(result: ParseResult): result is { model: DiagramModel } {
  return 'model' in result;
}
