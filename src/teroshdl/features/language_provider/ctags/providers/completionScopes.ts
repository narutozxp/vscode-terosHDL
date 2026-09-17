interface ScopedSymbol {
    name: string;
    type: string;
    parentScope: string;
    startPosition: { line: number };
}

export interface CompletionScope {
    name: string;
    type: string;
    start: number;
    end: number;
    startLine: number;
    endLine: number;
}

const containers = new Set(['module', 'macromodule', 'interface', 'program', 'package']);
const definitions = new Set(['module', 'interface', 'program', 'package']);

/** Locate design units in the current buffer, including an unfinished final unit. */
export function getCompletionScopes(source: string): CompletionScope[] {
    const scopes: CompletionScope[] = [];
    const stack: CompletionScope[] = [];
    const lexer = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|\s+|\\[^\s]+|[a-zA-Z_$][\w$]*|[^\s]/g;
    let line = 0;
    let pending: { type: string; start: number; line: number } | undefined;
    let match: RegExpExecArray | null;
    while ((match = lexer.exec(source)) !== null) {
        const text = match[0];
        const tokenLine = line;
        line += (text.match(/\n/g) ?? []).length;
        if (/^\s|^\/\/|^\/\*|^"/.test(text)) { continue; }
        if (pending) {
            if (text === 'automatic' || text === 'static') { continue; }
            if (/^[a-zA-Z_$\\]/.test(text)) {
                const scope = {
                    name: text, type: pending.type === 'macromodule' ? 'module' : pending.type,
                    start: pending.start, end: source.length + 1,
                    startLine: pending.line, endLine: Number.MAX_SAFE_INTEGER
                };
                scopes.push(scope);
                stack.push(scope);
            }
            pending = undefined;
        } else if (containers.has(text)) {
            pending = { type: text, start: match.index, line: tokenLine };
        } else if (text.startsWith('end')) {
            const scope = stack[stack.length - 1];
            if (scope && text === `end${scope.type}`) {
                scope.end = match.index + text.length;
                scope.endLine = tokenLine;
                stack.pop();
            }
        }
    }
    return scopes;
}

export function getVisibleCompletionSymbols<T extends ScopedSymbol>(
    symbols: T[], scopes: CompletionScope[], cursorOffset: number
): T[] {
    const active = scopes.filter(scope => scope.start <= cursorOffset && cursorOffset < scope.end).pop();
    return symbols.filter(symbol => {
        // Design-unit names and preprocessor macros can be referenced across units.
        if (symbol.type === 'define' || (!symbol.parentScope && definitions.has(symbol.type))) { return true; }
        const owner = scopes.find(scope => symbol.parentScope === scope.name ||
            symbol.parentScope.startsWith(scope.name + '.') || symbol.parentScope.startsWith(scope.name + '::'));
        if (owner) { return owner === active; }
        // Some parser kinds omit scope; fall back to the declaration's design unit.
        const declarationScope = scopes.filter(scope => scope.startLine <= symbol.startPosition.line &&
            symbol.startPosition.line <= scope.endLine).pop();
        if (declarationScope) { return declarationScope === active; }
        return !symbol.parentScope;
    });
}
