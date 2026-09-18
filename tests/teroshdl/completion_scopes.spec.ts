import { getCompletionScopes, getVisibleCompletionSymbols } from '../../src/teroshdl/features/language_provider/ctags/providers/completionScopes';

describe('Completion scopes within a file', () => {
    const source = [
        '// module fake; endmodule',
        'module first(input clk_first);',
        'reg shared;',
        'function logic fn(); logic local_first; endfunction',
        'endmodule',
        'module second(input clk_second);',
        'reg shared;',
        'wire only_second;',
        'string message = "endmodule module fake;";',
        'endmodule'
    ].join('\n');
    const symbol = (name: string, parentScope: string, line: number, type = 'register') =>
        ({ name, type, parentScope, startPosition: { line } });
    const symbols = [
        symbol('first', '', 1, 'module'), symbol('second', '', 5, 'module'),
        symbol('clk_first', 'first', 1, 'port'), symbol('clk_second', 'second', 5, 'port'),
        symbol('shared', 'first', 2), symbol('shared', 'second', 6),
        symbol('local_first', 'first.fn', 3), symbol('only_second', 'second', 7, 'net'),
        symbol('GLOBAL', '', 0, 'define')
    ];

    it('keeps globals and module names but excludes another module’s members, including nested members', () => {
        const scopes = getCompletionScopes(source);
        expect(scopes.map(scope => scope.name)).toEqual(['first', 'second']);
        const visible = getVisibleCompletionSymbols(symbols, scopes, source.indexOf('wire only_second'));
        expect(visible.map(item => item.name)).toEqual(['first', 'second', 'clk_second', 'shared', 'only_second', 'GLOBAL']);
        expect(visible.find(item => item.name === 'shared').parentScope).toBe('second');
    });

    it('changes the visible members when the cursor moves to another module', () => {
        const visible = getVisibleCompletionSymbols(symbols, getCompletionScopes(source), source.indexOf('reg shared'));
        expect(visible.some(item => item.name === 'clk_first')).toBe(true);
        expect(visible.some(item => item.name === 'clk_second')).toBe(false);
    });

    it('offers only globals and design-unit names between modules', () => {
        const visible = getVisibleCompletionSymbols(symbols, getCompletionScopes(source), source.indexOf('\nmodule second'));
        expect(visible.map(item => item.name)).toEqual(['first', 'second', 'GLOBAL']);
    });

    it('handles incomplete modules, lifetime qualifiers, and symbols with omitted scope', () => {
        const buffer = 'module first;\nwire a;\nendmodule\nmodule automatic second;\nwire b;\n';
        const scopes = getCompletionScopes(buffer);
        const visible = getVisibleCompletionSymbols([
            symbol('a', '', 1, 'net'), symbol('b', '', 4, 'net')
        ], scopes, buffer.length);
        expect(visible.map(item => item.name)).toEqual(['b']);
    });

    it('preserves legacy visibility for namespace prefixes, duplicate names and unsorted ranges', () => {
        const legacy = (symbols: any[], scopes: any[], cursor: number) => {
            const active = scopes.filter(scope => scope.start <= cursor && cursor < scope.end).pop();
            return symbols.filter(symbol => {
                if (symbol.type === 'define' || !symbol.parentScope && ['module', 'interface', 'program', 'package'].includes(symbol.type)) { return true; }
                const owner = scopes.find(scope => symbol.parentScope === scope.name || symbol.parentScope.startsWith(scope.name + '.') || symbol.parentScope.startsWith(scope.name + '::'));
                if (owner) { return owner === active; }
                const declaration = scopes.filter(scope => scope.startLine <= symbol.startPosition.line && symbol.startPosition.line <= scope.endLine).pop();
                return declaration ? declaration === active : !symbol.parentScope;
            });
        };
        let seed = 1849;
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
        for (let run = 0; run < 100; run++) {
            const scopes = Array.from({ length: 20 }, (_, index) => {
                const start = random() % 100;
                return { name: ['a', 'a.b', 'a::b', 'other', '\\escaped.name'][index % 5], type: 'module',
                    start, end: start + random() % 100, startLine: start, endLine: start + random() % 100 };
            });
            if (run % 2) { scopes.sort((a, b) => a.startLine - b.startLine); }
            const entries = Array.from({ length: 50 }, (_, index) => symbol(`s_${index}`,
                ['', 'a', 'a.b.fn', 'a::b::fn', 'unknown', '\\escaped.name.fn'][random() % 6], random() % 200,
                ['register', 'net', 'define', 'module'][random() % 4]));
            const cursor = random() % 200;
            expect(getVisibleCompletionSymbols(entries, scopes, cursor)).toEqual(legacy(entries, scopes, cursor));
        }
    });

    it('indexes scope names once rather than scanning all units for every member', () => {
        let reads = 0;
        const scopes = Array.from({ length: 1000 }, (_, index) => ({
            get name() { reads++; return `m_${index}`; }, type: 'module', start: index * 10, end: index * 10 + 9,
            startLine: index * 10, endLine: index * 10 + 9
        }));
        const entries = Array.from({ length: 10000 }, (_, index) => symbol(`s_${index}`, `m_${index % 1000}.fn`, index % 1000 * 10));
        expect(getVisibleCompletionSymbols(entries, scopes, 5000)).toHaveLength(10);
        expect(reads).toBe(1000);
    });
});
