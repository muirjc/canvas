import type { AiPersonaDto } from '../app/api';

/** Shared by every persona picker/list (ChatPanel, CreateViaChatDialog, PersonaAdminPage) so they
 * can never disagree about category grouping or ordering. */
export function groupPersonasByCategory(personas: AiPersonaDto[]): Map<string, AiPersonaDto[]> {
  const groups = new Map<string, AiPersonaDto[]>();
  for (const persona of personas) {
    const list = groups.get(persona.category) ?? [];
    list.push(persona);
    groups.set(persona.category, list);
  }
  return groups;
}
