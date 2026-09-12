/**
 * The quick reference of the query language, generated from the submodule's
 * documentation.
 *
 * Deliberately not copied out: `docs/Quick Reference.md` is kept up to date in
 * the plugin with every new instruction (the marker
 * NEW_QUERY_INSTRUCTION_EDIT_REQUIRED exists for exactly that). A
 * `git submodule update --remote` therefore brings new instructions along by
 * itself — a hand-written list in the repo would quietly go stale.
 *
 * The source table is five columns wide and barely readable in that form for a
 * language model; here it is reshaped into labelled lines per topic block and
 * stripped of wiki links.
 */
import quickReferenceMarkdown from '../vendor/obsidian-tasks/docs/Quick Reference.md';

const columnLabels = ['filter', 'sort', 'group', 'display', 'script'];

/** Reduce `[[target|text]]` and `[[target]]` to the visible text. */
function stripWikiLinks(cell: string): string {
    return cell.replace(/\[\[([^\]]+)\]\]/g, (_all, inner: string) => {
        const shown = inner.split('\\|').pop() ?? inner;
        return (shown.split('|').pop() ?? shown).trim();
    });
}

/** Split a Markdown table row into cells; `\|` is not a separator. */
function splitRow(line: string): string[] {
    const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/);
    return cells.map((cell) => stripWikiLinks(cell).replace(/\\\|/g, '|').trim());
}

function isSeparator(line: string): boolean {
    return /^\|[\s:|-]+\|$/.test(line.trim());
}

function render(): string {
    const lines: string[] = [
        'Obsidian Tasks query language — every instruction, one per line, unquoted.',
        'Full documentation: https://publish.obsidian.md/tasks/Queries/About+Queries',
        '',
        'Notation: `(a, b)` means "one of these words", `<string>` is literal text',
        'taken verbatim from the rest of the line — do not put it in quotes.',
        'The `script:` entries are only usable where the plugin setting for',
        'JavaScript in queries is enabled; otherwise `filter by function` is rejected.',
        '',
    ];

    for (const line of quickReferenceMarkdown.split('\n')) {
        if (!line.trim().startsWith('|') || isSeparator(line)) continue;

        const cells = splitRow(line);
        // Header row of the table: it only carries the column names, which
        // are hard-coded as labels here.
        if (cells[0] === 'Filters') continue;

        const heading = cells[0].match(/^\*\*(.+?)\*\*/);
        if (heading && cells.slice(1).every((cell) => cell === '')) {
            lines.push('', `## ${cells[0].replace(/\*\*/g, '')}`);
            continue;
        }

        // A blank line before every entry: without it the lines of adjacent
        // table rows blur into one block.
        if (cells.some((cell) => cell !== '')) lines.push('');

        for (const [index, cell] of cells.entries()) {
            if (!cell) continue;
            const label = columnLabels[index] ?? '';
            for (const [part, entry] of cell.split('<br>').entries()) {
                const text = entry.trim();
                if (!text) continue;
                lines.push(`  ${part === 0 ? `${label}:`.padEnd(9) : ' '.repeat(9)}${text}`);
            }
        }
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const quickReference = render();
