import Provider from '../../src/teroshdl/features/language_provider/ctags/providers/DocumentSymbolProvider';

jest.mock('vscode', () => ({ SymbolKind: { Module: 1, Variable: 2 } }), { virtual: true });
jest.mock('../../src/teroshdl/features/language_provider/ctags/ctags', () => ({ CtagsManager: {} }));
jest.mock('../../src/teroshdl/features/language_provider/ctags/Logger', () => ({ Log_Severity: { Warn: 1, Error: 2 } }));
jest.mock('../../src/teroshdl/features/language_provider/index/settings', () => ({ getIndexingSettings: () => ({ liveParsing: true }) }));

function symbol(name: string, type: string, start: number, end = start): any {
    return { name, type,
        startPosition: { line: start, isBefore: (other: any) => start < other.line, isAfter: (other: any) => start > other.line },
        endPosition: { line: end },
        getDocumentSymbol: () => ({ name, kind: type === 'module' ? 1 : 2, children: [],
            range: { start, end, contains: (other: any) => start <= other.start && other.end <= end } }) };
}

describe('Document symbol hierarchy', () => {
    const provider = new Provider({ log() {} } as any, {} as any);
    it('deduplicates leaves and preserves nested containers and separate modules', () => {
        const leaf = symbol('a', 'register', 4);
        const result = provider.buildDocumentSymbolList([
            symbol('first', 'module', 0, 10), symbol('outer_signal', 'register', 1),
            symbol('nested', 'module', 2, 5), leaf, leaf,
            symbol('after', 'register', 7), symbol('second', 'module', 11, 15), symbol('b', 'net', 12)
        ]);
        expect(result.map(item => item.name)).toEqual(['first', 'second']);
        expect(result[0].children.map(item => item.name)).toEqual(['outer_signal', 'nested', 'after']);
        expect(result[0].children[1].children.map(item => item.name)).toEqual(['a']);
        expect(result[1].children.map(item => item.name)).toEqual(['b']);
    });
    it('does not rescan leaves to place each new signal in a large module', () => {
        let checks = 0;
        const container = symbol('top', 'module', 0, 2001);
        const original = container.getDocumentSymbol;
        container.getDocumentSymbol = () => {
            const item = original();
            const contains = item.range.contains;
            item.range.contains = (other: any) => { checks++; return contains(other); };
            return item;
        };
        const isContainer = jest.spyOn(provider, 'isContainer');
        const result = provider.buildDocumentSymbolList([container,
            ...Array.from({ length: 2000 }, (_, index) => symbol(`signal_${index}`, 'register', index + 1))]);
        expect(result[0].children).toHaveLength(2000);
        expect(checks).toBe(2000);
        expect(isContainer.mock.calls.length).toBeLessThanOrEqual(4000);
        isContainer.mockRestore();
    });
    it('falls back to saved symbols when the live worker fails', async () => {
        const cache = { getBuffer: jest.fn().mockRejectedValue(new Error('Worker failed')),
            get: jest.fn().mockResolvedValue({ symbols: [symbol('top', 'module', 0, 3)] }) };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        const document = { uri: { fsPath: '/tmp/top.sv' }, languageId: 'systemverilog', isDirty: true, version: 1 };
        const result = await local.provideDocumentSymbols(document as any, undefined);
        expect(result.map(item => item.name)).toEqual(['top']);
        expect(cache.get).toHaveBeenCalledWith('/tmp/top.sv');
    });
    it('discards outlines if the document changes during extraction', async () => {
        const document = { uri: { fsPath: '/tmp/top.sv' }, languageId: 'systemverilog', isDirty: true, version: 1 };
        const cache = { getBuffer: async () => {
            document.version++;
            return { symbols: [symbol('stale', 'module', 0, 3)] };
        } };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        expect(await local.provideDocumentSymbols(document as any, undefined)).toEqual([]);
    });

    it('reuses the outline when a later document version has the same symbol array', async () => {
        const symbols = [symbol('top', 'module', 0, 3), symbol('a', 'register', 1)];
        const cache = { getBuffer: async () => ({ symbols }) };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        const build = jest.spyOn(local, 'buildDocumentSymbolList');
        const document = { uri: { fsPath: '/tmp/top.sv' }, languageId: 'systemverilog', isDirty: true, version: 1 };
        const initial = await local.provideDocumentSymbols(document as any, undefined);
        document.version++;
        expect(await local.provideDocumentSymbols(document as any, undefined)).toBe(initial);
        expect(build).toHaveBeenCalledTimes(1);
    });

    it('uses live snapshots for clean virtual documents without reading the disk path', async () => {
        const cache = { getBuffer: jest.fn().mockResolvedValue({ symbols: [symbol('virtual', 'module', 0, 1)] }), get: jest.fn() };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        const doc = { uri: { scheme: 'memory', fsPath: '/same.sv' }, languageId: 'systemverilog', isDirty: false, version: 1 };
        expect((await local.provideDocumentSymbols(doc as any, undefined)).map(item => item.name)).toEqual(['virtual']);
        expect(cache.get).not.toHaveBeenCalled();
    });

    it('does not use local saved symbols when a virtual buffer fails', async () => {
        const cache = { getBuffer: jest.fn().mockRejectedValue(new Error('Worker failure')), get: jest.fn() };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        const doc = { uri: { scheme: 'memory', fsPath: '/same.sv' }, languageId: 'systemverilog', isDirty: true, version: 1 };
        expect(await local.provideDocumentSymbols(doc as any, undefined)).toEqual([]);
        expect(cache.get).not.toHaveBeenCalled();
    });

    it('does no extraction for already cancelled or closed requests', async () => {
        const cache = { getBuffer: jest.fn(), get: jest.fn() };
        const local = new Provider({ log() {} } as any, {} as any, cache as any);
        const doc: any = { uri: { scheme: 'file', fsPath: '/a.sv' }, languageId: 'systemverilog', isDirty: true, version: 1 };
        expect(await local.provideDocumentSymbols(doc, { isCancellationRequested: true } as any)).toEqual([]);
        doc.isClosed = true;
        expect(await local.provideDocumentSymbols(doc, undefined)).toEqual([]);
        expect(cache.getBuffer).not.toHaveBeenCalled(); expect(cache.get).not.toHaveBeenCalled();
    });

});
