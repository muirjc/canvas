import { describe, expect, it } from 'vitest';
import { parseSequence } from '../../src/dsl/sequence.js';
import { parseUml } from '../../src/dsl/uml.js';
import { parseErd } from '../../src/dsl/erd.js';
import { parseC4 } from '../../src/dsl/c4.js';
import { parseArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Feature 003, User Story 4: `%%` comment lines must be silently ignored in every diagram
 * family, not just flowchart (which already got this in feature 002) — FR-015, FR-016.
 */
describe('%% comments are ignored in every diagram type', () => {
  it('sequence diagram', () => {
    const result = parseSequence('sequenceDiagram\n%% a comment\nparticipant A\n%% another\nA->>A: hi\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  it('class/UML diagram', () => {
    const result = parseUml('classDiagram\n%% a comment\nclass Animal\n%% another\nclass Dog\nAnimal <|-- Dog\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  it('ER diagram', () => {
    const result = parseErd('erDiagram\n%% a comment\nCUSTOMER ||--o{ ORDER : places\n%% another\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  it('C4 diagram', () => {
    const result = parseC4('C4Context\n%% a comment\nPerson(user, "User")\n%% another\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  it('architecture diagram', () => {
    const result = parseArchitecture('architecture-beta\n%% a comment\nservice a(server)[A]\n%% another\n');
    expect(isParseSuccess(result)).toBe(true);
  });

  it('a genuinely unrecognized line still errors in each parser (comments do not suppress real errors)', () => {
    expect(isParseSuccess(parseSequence('sequenceDiagram\n%% ok\n???not-valid???\n'))).toBe(false);
    expect(isParseSuccess(parseUml('classDiagram\n%% ok\n???not-valid???\n'))).toBe(false);
    expect(isParseSuccess(parseErd('erDiagram\n%% ok\n???not-valid???\n'))).toBe(false);
    expect(isParseSuccess(parseC4('C4Context\n%% ok\n???not-valid???\n'))).toBe(false);
    expect(isParseSuccess(parseArchitecture('architecture-beta\n%% ok\n???not-valid???\n'))).toBe(false);
  });
});
