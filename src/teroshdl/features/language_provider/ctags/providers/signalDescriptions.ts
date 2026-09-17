interface SignalSymbol {
    name: string;
    type: string;
    startPosition: { line: number };
}

const signalTypes = new Set(['port', 'net', 'register']);
const directions = new Set(['input', 'output', 'inout', 'ref']);
const scalarTypes = new Set([
    'wire', 'reg', 'logic', 'bit', 'tri', 'tri0', 'tri1', 'wand', 'wor',
    'triand', 'trior', 'trireg', 'uwire', 'supply0', 'supply1', 'interconnect'
]);
const integerWidths: Record<string, number> = {
    byte: 8, shortint: 16, int: 32, integer: 32, longint: 64, time: 64
};
const qualifiers = new Set(['signed', 'unsigned', 'var', 'const', 'static', 'automatic']);

/** Read display metadata only; ctags remains responsible for discovering symbols. */
export function getSignalDescriptions(source: string, symbols: SignalSymbol[]): Map<SignalSymbol, string> {
    const targets = new Map<string, SignalSymbol[]>();
    for (const symbol of symbols) {
        if (!signalTypes.has(symbol.type)) { continue; }
        const key = `${symbol.startPosition.line}:${symbol.name}`;
        targets.set(key, [...(targets.get(key) ?? []), symbol]);
    }
    const result = new Map<SignalSymbol, string>();
    if (targets.size === 0) { return result; }
    // Ignore comments and strings, but retain line numbers for ctags declarations.
    const tokens: { text: string; line: number }[] = [];
    const lexer = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|\s+|\\[^\s]+|[a-zA-Z_$][\w$]*|[0-9]+|[^\s]/g;
    let line = 0;
    let match: RegExpExecArray | null;
    while ((match = lexer.exec(source)) !== null) {
        const text = match[0];
        if (!/^\s|^\/\/|^\/\*|^"/.test(text)) { tokens.push({ text, line }); }
        line += (text.match(/\n/g) ?? []).length;
    }

    let declaration: { type: string; ranges: string[]; named: boolean; unknownType: boolean; direction?: string } | undefined;
    for (let index = 0; index < tokens.length; index++) {
        const { text, line: tokenLine } = tokens[index];
        if (directions.has(text)) {
            declaration = { type: 'wire', ranges: [], named: false, unknownType: false, direction: text };
        } else if (scalarTypes.has(text) || integerWidths[text]) {
            if (!declaration || declaration.named) {
                declaration = { type: text, ranges: [], named: false, unknownType: false, direction: declaration?.direction };
            } else {
                declaration.type = text;
            }
        } else if (text === '[' && declaration) {
            let depth = 1;
            const range = [text];
            while (++index < tokens.length && depth > 0) {
                const part = tokens[index].text;
                range.push(part);
                if (part === '[') { depth++; }
                if (part === ']') { depth--; }
                if (depth === 0) { break; }
            }
            if (!declaration.named && depth === 0) { declaration.ranges.push(range.join('')); }
        } else if ((text === '(' || text === '{') && declaration?.named) {
            // Skip initializer expressions, so their commas/ranges cannot alter the declaration.
            let depth = 1;
            const close = text === '(' ? ')' : '}';
            while (++index < tokens.length) {
                if (tokens[index].text === text) { depth++; }
                if (tokens[index].text === close && --depth === 0) { break; }
            }
        } else if ([';', '(', ')', '{', '}', 'begin', 'end', 'endmodule'].includes(text)) {
            declaration = undefined;
        } else {
            const matching = targets.get(`${tokenLine}:${text}`);
            if (matching && declaration) {
                const width = declaration.ranges.join('') || (declaration.unknownType ? '' :
                    `[${(integerWidths[declaration.type] ?? 1) - 1}:0]`);
                for (const symbol of matching) {
                    if (!result.has(symbol)) {
                        const kind = symbol.type === 'port' ?
                            `${declaration.direction ?? 'port'}${declaration.unknownType ? '' : ' ' + declaration.type}` : declaration.type;
                        result.set(symbol, `${kind}${width ? ' ' + width : ''}`);
                    }
                }
                declaration.named = true;
            } else if (declaration && !declaration.named && /^[a-zA-Z_$\\]/.test(text) && !qualifiers.has(text)) {
                // A typedef/interface type cannot be assigned a scalar width without semantic analysis.
                if ([',', ';', '=', ')'].includes(tokens[index + 1]?.text)) {
                    // Earlier names may be absent from the requested symbol subset.
                    declaration.named = true;
                } else { declaration.unknownType = true; }
            }
        }
    }
    return result;
}
