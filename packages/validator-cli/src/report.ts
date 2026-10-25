import type { Finding, ValidationReport } from './validate-repo.js';

/** canvas-3s5.3: the report as plain text, GitHub workflow commands, and a step-summary table. */

const LEVEL_WORD: Record<Finding['level'], string> = { error: 'error', warning: 'warning', notice: 'note' };

export function formatText(report: ValidationReport): string {
  const lines: string[] = [];
  for (const d of report.diagrams) {
    const status = d.findings.some((f) => f.level === 'error') ? 'FAIL' : 'ok';
    lines.push(`${status}  ${d.name}  (${d.manifest})`);
    for (const f of d.findings) lines.push(`      ${LEVEL_WORD[f.level]}: ${f.file}${f.line ? `:${f.line}` : ''}  ${f.title}: ${f.message}`);
  }
  lines.push(summaryLine(report));
  return `${lines.join('\n')}\n`;
}

export function summaryLine(report: ValidationReport): string {
  const n = report.diagrams.length;
  if (n === 0) return 'No Canvas diagrams found (no canvas.json manifests).';
  return `${n} diagram${n === 1 ? '' : 's'} checked: ${report.errorCount} error${report.errorCount === 1 ? '' : 's'}, ${report.warningCount} warning${report.warningCount === 1 ? '' : 's'}.`;
}

/** GitHub's workflow-command escaping: message data, and property values (which also escape : and ,). */
function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** `::error file=…,line=…,title=…::message` -- shown as annotations on the pull request's files. */
export function formatGitHub(report: ValidationReport): string {
  const lines: string[] = [];
  for (const d of report.diagrams) {
    for (const f of d.findings) {
      const props = [`file=${escapeProperty(f.file)}`, ...(f.line ? [`line=${f.line}`] : []), `title=${escapeProperty(`${f.title} (${d.name})`)}`];
      lines.push(`::${f.level} ${props.join(',')}::${escapeData(f.message)}`);
    }
  }
  lines.push(summaryLine(report));
  return `${lines.join('\n')}\n`;
}

/** A markdown table cell for the step summary (GitHub sanitises its HTML too); `<` is escaped only so
 *  a finding mentioning a tag reads as text. */
function cell(text: string): string {
  // bearer:disable javascript_lang_manual_html_sanitization
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;');
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function formatSummary(report: ValidationReport): string {
  const lines = ['## Canvas diagrams', '', summaryLine(report), ''];
  if (report.diagrams.length > 0) {
    lines.push('| Diagram | Result | Standard | Findings |', '|---|---|---|---|');
    for (const d of report.diagrams) {
      const errors = d.findings.filter((f) => f.level === 'error').length;
      const warnings = d.findings.filter((f) => f.level === 'warning').length;
      const result = errors > 0 ? '❌ Fails' : warnings > 0 ? '⚠️ Passes with warnings' : '✅ Passes';
      const findings = d.findings.length === 0 ? '—' : d.findings.slice(0, 5).map((f) => cell(`${f.title}: ${f.message}`)).join('<br>') + (d.findings.length > 5 ? `<br>…and ${d.findings.length - 5} more` : '');
      lines.push(`| ${cell(d.name)} (\`${cell(d.manifest)}\`) | ${result} | ${cell(d.standard ?? 'none')} | ${findings} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
