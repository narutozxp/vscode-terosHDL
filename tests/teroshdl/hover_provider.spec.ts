import { TextDocument } from 'vscode';
import HoverProvider from '../../src/teroshdl/features/language_provider/ctags/providers/HoverProvider';
import { CtagsManager } from '../../src/teroshdl/features/language_provider/ctags/ctags';
import { Logger } from '../../src/teroshdl/features/language_provider/ctags/Logger';

jest.mock('vscode', () => ({
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class {},
    MarkdownString: class {
        value = '';
        appendCodeblock(code: string) { this.value = code; }
    },
    Hover: class { constructor(public contents: { value: string }) {} }
}), { virtual: true });
jest.mock('../../src/teroshdl/features/language_provider/ctags/ctags', () => ({
    CtagsManager: { ctags: {} }
}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/Logger', () => ({ Log_Severity: {} }));

describe('Ctags hover fallback', () => {
    it('matches equivalent URI values and displays the declaration of a saved symbol', async () => {
        const wordRange = { isEmpty: false };
        const uri = { toString: () => 'file:///project/example.v' };
        CtagsManager.ctags = {
            doc: { uri: { toString: () => uri.toString() } },
            symbols: [{ name: 'signal', startPosition: { line: 1 } }]
        } as unknown as typeof CtagsManager.ctags;
        const document = {
            uri, languageId: 'verilog', getWordRangeAtPosition: () => wordRange,
            getText: (range: unknown) => range === wordRange ? 'signal' : 'reg signal;'
        } as unknown as TextDocument;
        const provider = new HoverProvider({ log: jest.fn() } as unknown as Logger);
        const hover = await provider.provideHover(document, undefined, undefined);
        expect(hover).toBeDefined();
        expect((hover.contents as unknown as { value: string }).value).toBe('reg signal;');
    });

    it('returns no hover when the cursor is outside a word', () => {
        const document = {
            getWordRangeAtPosition: () => undefined, getText: jest.fn()
        } as unknown as TextDocument;
        const provider = new HoverProvider({ log: jest.fn() } as unknown as Logger);
        expect(provider.provideHover(document, undefined, undefined)).toBeUndefined();
        expect(document.getText).not.toHaveBeenCalled();
    });
});
