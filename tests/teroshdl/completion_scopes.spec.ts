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
});
