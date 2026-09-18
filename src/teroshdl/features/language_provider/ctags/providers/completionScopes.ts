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
    let active: CompletionScope | undefined;
    for (const scope of scopes) {
        if (scope.start <= cursorOffset && cursorOffset < scope.end) { active = scope; }
    }
    const names = new Map<string, number>();
    for (let index = 0; index < scopes.length; index++) {
        const name = scopes[index].name;
        if (!names.has(name)) { names.set(name, index); }
    }
    const owners = new Map<string, CompletionScope | undefined>();
    const ownerOf = (parent: string) => {
        if (!owners.has(parent)) {
            let first = names.get(parent) ?? Infinity;
            for (let index = 0; index < parent.length; index++) {
                if (parent[index] === '.' || parent.slice(index, index + 2) === '::') {
                    first = Math.min(first, names.get(parent.slice(0, index)) ?? Infinity);
                }
            }
            owners.set(parent, scopes[first]);
        }
        return owners.get(parent);
    };
    // Internal scope arrays are in source order. A max-end interval tree finds the
    // last enclosing line without scanning all preceding (possibly nested) units.
    const ordered = scopes.every((scope, index) => !index || scopes[index - 1].startLine <= scope.startLine);
    const maxEnd: number[] = [];
    const build = (node: number, low: number, high: number): number => {
        if (low === high) { return maxEnd[node] = scopes[low].endLine; }
        const middle = (low + high) >>> 1;
        return maxEnd[node] = Math.max(build(node * 2, low, middle), build(node * 2 + 1, middle + 1, high));
    };
    let intervalsBuilt = false;
    const lines = new Map<number, CompletionScope | undefined>();
    const declarationOf = (line: number) => {
        if (!lines.has(line)) {
            if (!ordered) {
                lines.set(line, scopes.filter(scope => scope.startLine <= line && line <= scope.endLine).pop());
            } else {
                if (!intervalsBuilt && scopes.length) { build(1, 0, scopes.length - 1); intervalsBuilt = true; }
                let low = 0; let high = scopes.length;
                while (low < high) {
                    const middle = (low + high) >>> 1;
                    if (scopes[middle].startLine <= line) { low = middle + 1; } else { high = middle; }
                }
                const limit = low - 1;
                const find = (node: number, start: number, end: number): number => {
                    if (start > limit || maxEnd[node] < line) { return -1; }
                    if (start === end) { return start; }
                    const middle = (start + end) >>> 1;
                    const right = find(node * 2 + 1, middle + 1, end);
                    return right >= 0 ? right : find(node * 2, start, middle);
                };
                lines.set(line, scopes.length && limit >= 0 ? scopes[find(1, 0, scopes.length - 1)] : undefined);
            }
        }
        return lines.get(line);
    };
    return symbols.filter(symbol => {
        // Design-unit names and preprocessor macros can be referenced across units.
        if (symbol.type === 'define' || (!symbol.parentScope && definitions.has(symbol.type))) { return true; }
        const owner = ownerOf(symbol.parentScope);
        if (owner) { return owner === active; }
        // Some parser kinds omit scope; fall back to the declaration's design unit.
        const declarationScope = declarationOf(symbol.startPosition.line);
        if (declarationScope) { return declarationScope === active; }
        return !symbol.parentScope;
    });
}
