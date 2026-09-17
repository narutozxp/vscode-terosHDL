import { TextDocument } from 'vscode';
import { Ctags, CtagsManager } from '../../src/teroshdl/features/language_provider/ctags/ctags';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import DocumentSymbolProvider from '../../src/teroshdl/features/language_provider/ctags/providers/DocumentSymbolProvider';
import { Logger } from '../../src/teroshdl/features/language_provider/ctags/Logger';

jest.mock('vscode', () => ({
    Position: class Position {
        constructor(public line: number, public character: number) {}
        isBefore(other: Position) { return this.line < other.line || this.line === other.line && this.character < other.character; }
        isAfter(other: Position) { return other.isBefore(this); }
        isEqual(other: Position) { return this.line === other.line && this.character === other.character; }
    },
    Range: class {
        constructor(public start: any, public end: any) {}
        contains(other: any) { return !other.start.isBefore(this.start) && !other.end.isAfter(this.end); }
    },
    DocumentSymbol: class {
        children: unknown[] = [];
        constructor(public name: string, public detail: string, public kind: number, public range: unknown) {}
    },
    SymbolKind: { Module: 1, Variable: 12, Boolean: 16 },
    Uri: { file: (file: string) => ({ scheme: 'file', fsPath: file, toString: () => 'file://' + file }) },
    workspace: {}, window: {}
}), { virtual: true });

describe('Ctags indexing snapshots', () => {
    const logger = { log: jest.fn() } as unknown as Logger;
    const source = 'module first;\nreg a;\nendmodule\nmodule second;\nreg b;\nendmodule\n';
    const tags = [
        'first\ttest.v\t1;"\tmodule', 'a\ttest.v\t2;"\tregister\tmodule:first',
        'second\ttest.v\t4;"\tmodule', 'b\ttest.v\t5;"\tregister\tmodule:second'
    ].join('\n');

    function parser(): Ctags {
        const ctags = new Ctags(logger, undefined);
        const { Position } = jest.requireMock('vscode');
        ctags.doc = {
            uri: { fsPath: '/test.v' }, languageId: 'verilog', getText: () => source,
            positionAt: (offset: number) => new Position(source.slice(0, offset).split('\n').length - 1, 0)
        } as unknown as TextDocument;
        return ctags;
    }

    it('does not duplicate or nest module entries when two indexing requests overlap', async () => {
        const ctags = parser();
        jest.spyOn(ctags, 'execCtags').mockResolvedValue(tags);
        await Promise.all([ctags.index(), ctags.index()]);
        expect(ctags.symbols.filter(symbol => symbol.type === 'module').map(symbol => [symbol.name, symbol.endPosition.line]))
            .toEqual([['first', 2], ['second', 5]]);
        const outline = new DocumentSymbolProvider(logger, undefined).buildDocumentSymbolList(ctags.symbols);
        expect(outline.map(symbol => symbol.name)).toEqual(['first', 'second']);
        expect(outline.map(symbol => symbol.children.map(child => child.name))).toEqual([['a'], ['b']]);
    });

    it('clears old symbols when the next indexing response is empty', async () => {
        const ctags = parser();
        const execute = jest.spyOn(ctags, 'execCtags').mockResolvedValueOnce(tags).mockResolvedValueOnce('');
        await ctags.index();
        await ctags.index();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(ctags.symbols).toEqual([]);
        expect(ctags.isDirty).toBe(false);
    });

    it('rejects promptly when the ctags process fails', async () => {
        const ctags = parser();
        jest.spyOn(ctags, 'execCtags').mockRejectedValue(new Error('process failed'));
        await expect(ctags.index()).rejects.toThrow('process failed');
    });

    (process.platform === 'linux' && process.arch === 'x64' ? it : it.skip)('uses the bundled binary and requested file for cached Outline snapshots', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl outline '));
        const file = path.join(directory, 'multiple modules.v');
        fs.writeFileSync(file, source + 'module inline; wire c; endmodule\n');
        const root = path.resolve(__dirname, '../..');
        new CtagsManager(logger, { asAbsolutePath: (relative: string) => path.join(root, relative) } as any);
        const cache = CtagsManager.fileCache;
        try {
            const doc = { uri: { fsPath: file } } as unknown as TextDocument;
            const provider = new DocumentSymbolProvider(logger, undefined, cache);
            const outlines = await Promise.all([provider.provideDocumentSymbols(doc, undefined), provider.provideDocumentSymbols(doc, undefined)]);
            expect(outlines[0].map(module => module.name)).toEqual(['first', 'second', 'inline']);
            expect(outlines[0].map(module => module.children.map(child => child.name))).toEqual([['a'], ['b'], ['c']]);
            expect(outlines[1].map(module => module.name)).toEqual(['first', 'second', 'inline']);
            fs.writeFileSync(file, 'module replacement; endmodule'); cache.invalidate(file);
            expect((await provider.provideDocumentSymbols(doc, undefined)).map(module => module.name)).toEqual(['replacement']);
        } finally { cache.dispose(); CtagsManager.fileCache = undefined; fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
