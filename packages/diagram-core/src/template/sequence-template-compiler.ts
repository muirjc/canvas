import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { AliasAllocator, camelSlug, cell, err, findSection, pickOption, readMetadataFields, readYesNo } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * canvas-73s.1: compiles a filled-in copy of docs/sequence-template.md into Mermaid
 * `sequenceDiagram` DSL, following that document's mapping reference. Blocks are given as message
 * ranges (First # .. Last #) and must nest properly; Alt/Par/Critical branches start at a message
 * inside their block.
 */

const PARTICIPANT_TYPES = ['Participant', 'Actor'] as const;
const ARROWS = { Sync: '->>', Reply: '-->>', Async: '-)', Lost: '-x' } as const;
const ARROW_NAMES = Object.keys(ARROWS) as (keyof typeof ARROWS)[];
const ACTIVATIONS = ['Start', 'End'] as const;
const BLOCK_TYPES = ['Loop', 'Alt', 'Opt', 'Par', 'Critical', 'Break'] as const;
type BlockType = (typeof BLOCK_TYPES)[number];
const BRANCH_KEYWORD: Partial<Record<BlockType, string>> = { Alt: 'else', Par: 'and', Critical: 'option' };
const NOTE_POSITIONS = ['Over', 'Left of', 'Right of'] as const;

interface Message {
  step: number;
  line: string;
}

interface Block {
  type: BlockType;
  label: string;
  first: number;
  last: number;
  branches: { step: number; label: string }[];
}

interface Note {
  after: number;
  line: string;
}

/** Sequence text runs to the end of the line; a `;` would end the statement in Mermaid. */
function text(value: string): string {
  return value.replace(/;/g, ',').trim();
}

function parseStep(value: string): number | undefined {
  const n = Number(value.trim());
  return value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

export const sequenceTemplateCompiler: TemplateCompiler = {
  compile(markdownText: string): TemplateCompileResult {
    const errors: ParseError[] = [];
    const sections = splitIntoSections(markdownText);
    const metadataSection = findSection(sections, 'diagram metadata');
    const participantsSection = findSection(sections, 'participants');
    const messagesSection = findSection(sections, 'messages');
    const blocksSection = findSection(sections, 'blocks');
    const notesSection = findSection(sections, 'notes');

    if (!participantsSection) errors.push(err('Missing required section "2. Participants".'));
    if (!messagesSection) errors.push(err('Missing required section "3. Messages".'));
    if (errors.length > 0) return { errors };

    const fields = metadataSection ? readMetadataFields(metadataSection) : new Map<string, string>();
    const title = text(fields.get('Diagram title') ?? '');
    const autonumber = readYesNo(fields.get('Number the messages (Yes / No)') ?? fields.get('Number the messages') ?? '', false);
    if (autonumber === undefined) errors.push(err('Section 1: "Number the messages" must be Yes or No.'));

    // --- Section 2: participants ------------------------------------------------------------
    const aliases = new AliasAllocator((name) => camelSlug(name, 'participant'));
    const idByName = new Map<string, string>();
    const participantLines: string[] = [];
    for (const row of extractFirstTable(participantsSection!.body)) {
      const name = cell(row, 'Name');
      if (!name) continue;
      const type = pickOption(cell(row, 'Type') || 'Participant', PARTICIPANT_TYPES);
      if (!type) {
        errors.push(err(`Section 2, "${name}": unrecognized Type "${cell(row, 'Type')}" (expected Participant or Actor).`));
        continue;
      }
      if (idByName.has(name)) {
        errors.push(err(`Section 2: participant "${name}" is listed twice.`));
        continue;
      }
      const id = aliases.allocate(name);
      idByName.set(name, id);
      participantLines.push(`${type.toLowerCase()} ${id} as ${text(name)}`);
    }
    if (idByName.size === 0) errors.push(err('Section 2: list at least one participant.'));

    const resolve = (name: string, where: string): string | undefined => {
      const id = idByName.get(name);
      if (!id) errors.push(err(`${where}: "${name}" is not listed in Section 2 (Participants).`));
      return id;
    };

    // --- Section 3: messages ------------------------------------------------------------------
    const messages: Message[] = [];
    for (const row of extractFirstTable(messagesSection!.body)) {
      const from = cell(row, 'From');
      const to = cell(row, 'To');
      const label = cell(row, 'Message');
      if (!from && !to && !label) continue;
      const stepRaw = cell(row, '#');
      const step = stepRaw ? parseStep(stepRaw) : messages.length + 1;
      const where = `Section 3, message ${stepRaw || messages.length + 1}`;
      if (step === undefined || step === 0) {
        errors.push(err(`${where}: "#" must be a whole number from 1.`));
        continue;
      }
      if (messages.some((m) => m.step === step)) {
        errors.push(err(`${where}: step ${step} is used twice.`));
        continue;
      }
      if (messages.length > 0 && step < messages[messages.length - 1].step) {
        errors.push(err(`${where}: messages must be listed in step order.`));
        continue;
      }
      const arrow = pickOption(cell(row, 'Arrow') || 'Sync', ARROW_NAMES);
      if (!arrow) {
        errors.push(err(`${where}: unrecognized Arrow "${cell(row, 'Arrow')}" (expected ${ARROW_NAMES.join(', ')}).`));
        continue;
      }
      const activationRaw = cell(row, 'Activation');
      const activation = activationRaw ? pickOption(activationRaw, ACTIVATIONS) : undefined;
      if (activationRaw && !activation) {
        errors.push(err(`${where}: unrecognized Activation "${activationRaw}" (expected Start, End or blank).`));
        continue;
      }
      if (!label) {
        errors.push(err(`${where}: the Message text is required.`));
        continue;
      }
      const fromId = resolve(from, where);
      const toId = resolve(to, where);
      if (!fromId || !toId) continue;
      const marker = activation === 'Start' ? '+' : activation === 'End' ? '-' : '';
      messages.push({ step, line: `${fromId} ${ARROWS[arrow]}${marker} ${toId}: ${text(label)}` });
    }
    if (messages.length === 0 && errors.length === 0) errors.push(err('Section 3: list at least one message.'));
    const steps = new Set(messages.map((m) => m.step));

    // --- Section 4: blocks ---------------------------------------------------------------------
    const blocks: Block[] = [];
    if (blocksSection) {
      for (const row of extractFirstTable(blocksSection.body)) {
        const typeRaw = cell(row, 'Type');
        if (!typeRaw && !cell(row, 'First #') && !cell(row, 'Label')) continue;
        const type = pickOption(typeRaw, BLOCK_TYPES);
        const where = `Section 4, block "${cell(row, 'Label') || typeRaw}"`;
        if (!type) {
          errors.push(err(`${where}: unrecognized Type "${typeRaw}" (expected ${BLOCK_TYPES.join(', ')}).`));
          continue;
        }
        const first = parseStep(cell(row, 'First #'));
        const last = parseStep(cell(row, 'Last #'));
        if (first === undefined || last === undefined || !steps.has(first) || !steps.has(last) || first > last) {
          errors.push(err(`${where}: "First #" and "Last #" must be message steps from Section 3, first <= last.`));
          continue;
        }
        const branches: Block['branches'] = [];
        const branchesRaw = cell(row, 'Branches');
        if (branchesRaw && !BRANCH_KEYWORD[type]) {
          errors.push(err(`${where}: only Alt, Par and Critical blocks have branches.`));
          continue;
        }
        let branchError = false;
        for (const part of branchesRaw.split(';').map((p) => p.trim()).filter(Boolean)) {
          const match = part.match(/^(\d+)\s*:\s*(.*)$/);
          const step = match ? Number(match[1]) : undefined;
          if (!match || step === undefined || !steps.has(step) || step <= first || step > last) {
            errors.push(err(`${where}: branch "${part}" must be "step: label", with the step a message inside the block after its first.`));
            branchError = true;
            continue;
          }
          branches.push({ step, label: text(match[2]) });
        }
        if (branchError) continue;
        branches.sort((a, b) => a.step - b.step);
        blocks.push({ type, label: text(cell(row, 'Label')), first, last, branches });
      }
      // Blocks must nest: two ranges either don't overlap or one contains the other.
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const a = blocks[i];
          const b = blocks[j];
          const overlap = a.first <= b.last && b.first <= a.last;
          const nested = (a.first <= b.first && b.last <= a.last) || (b.first <= a.first && a.last <= b.last);
          if (overlap && !nested) {
            errors.push(err(`Section 4: blocks "${a.label || a.type}" and "${b.label || b.type}" partly overlap -- blocks must nest.`));
            continue;
          }
          // A block nested inside another can't straddle one of the outer block's branches.
          const [outer, inner] = nested && b.first >= a.first && b.last <= a.last ? [a, b] : [b, a];
          if (overlap && outer.branches.some((br) => br.step > inner.first && br.step <= inner.last)) {
            errors.push(err(`Section 4: block "${inner.label || inner.type}" crosses a branch of "${outer.label || outer.type}" -- end it before the branch starts.`));
          }
        }
      }
    }

    // --- Section 5: notes --------------------------------------------------------------------
    const notes: Note[] = [];
    if (notesSection) {
      for (const row of extractFirstTable(notesSection.body)) {
        const noteText = cell(row, 'Text');
        const participants = cell(row, 'Participants');
        if (!noteText && !participants) continue;
        const where = `Section 5, note "${noteText}"`;
        const after = parseStep(cell(row, 'After #') || '0');
        if (after === undefined || (after !== 0 && !steps.has(after))) {
          errors.push(err(`${where}: "After #" must be 0 or a message step from Section 3.`));
          continue;
        }
        const position = pickOption(cell(row, 'Position') || 'Over', NOTE_POSITIONS);
        if (!position) {
          errors.push(err(`${where}: unrecognized Position "${cell(row, 'Position')}" (expected Over, Left of or Right of).`));
          continue;
        }
        const names = participants.split(',').map((n) => n.trim()).filter(Boolean);
        if (names.length === 0 || names.length > 2 || (names.length === 2 && position !== 'Over')) {
          errors.push(err(`${where}: give one participant, or two for "Over".`));
          continue;
        }
        const ids = names.map((n) => resolve(n, where));
        if (ids.some((id) => !id)) continue;
        notes.push({ after, line: `Note ${position.toLowerCase()} ${ids.join(',')}: ${text(noteText)}` });
      }
    }

    if (errors.length > 0) return { errors };

    // --- Assembly ------------------------------------------------------------------------------
    const lines: string[] = ['sequenceDiagram'];
    if (title) lines.push(`    title ${title}`);
    if (autonumber) lines.push('    autonumber');
    for (const p of participantLines) lines.push(`    ${p}`);
    lines.push('');
    let depth = 1;
    const indent = () => '    '.repeat(depth);
    const pushNotesAfter = (step: number) => {
      for (const note of notes.filter((n) => n.after === step)) lines.push(`${indent()}${note.line}`);
    };
    pushNotesAfter(0);
    for (const message of messages) {
      // A branch divider first (at its block's own depth, one level out from the block's
      // messages) -- a block opening at the same step belongs to the new branch.
      for (const block of blocks) {
        const branch = block.branches.find((br) => br.step === message.step);
        if (branch) lines.push(`${'    '.repeat(depth - 1)}${BRANCH_KEYWORD[block.type]}${branch.label ? ` ${branch.label}` : ''}`);
      }
      // Then open blocks starting here, outermost (longest) first.
      const opening = blocks.filter((b) => b.first === message.step).sort((a, b) => b.last - a.last);
      for (const block of opening) {
        lines.push(`${indent()}${block.type.toLowerCase()}${block.label ? ` ${block.label}` : ''}`);
        depth += 1;
      }
      lines.push(`${indent()}${message.line}`);
      pushNotesAfter(message.step);
      // Close blocks ending here, innermost (shortest) first.
      const closing = blocks.filter((b) => b.last === message.step).sort((a, b) => b.first - a.first);
      for (let i = 0; i < closing.length; i++) {
        depth -= 1;
        lines.push(`${indent()}end`);
      }
    }
    return { dsl: lines.join('\n') + '\n' };
  },
};
