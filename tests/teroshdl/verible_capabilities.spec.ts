import { ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { Verilbe_lsp } from '../../src/teroshdl/features/language_provider/lsp/verible';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('vscode', () => ({ commands: { registerCommand: jest.fn() } }), { virtual: true });
jest.mock('vscode-languageclient/node', () => ({
    LanguageClient: jest.fn(), RevealOutputChannelOn: { Never: 0 }
}));

describe('Verible capabilities and outline integration', () => {
    it('ignores old directories without a runnable server binary', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl-verible-'));
        try {
            fs.mkdirSync(path.join(root, 'v0.0-3958-old'));
            const current = path.join(root, 'v0.0-4219-new');
            fs.mkdirSync(current);
            fs.writeFileSync(path.join(current,
                process.platform === 'win32' ? 'verible-verilog-ls.exe' : 'verible-verilog-ls'), '');
            const server = Object.create(Verilbe_lsp.prototype) as Verilbe_lsp;
            expect(server.embeddedVersion(root)).toBe('v0.0-4219-new');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
    it.each([false, true])('exposes server hover support=%s and suppresses the duplicate outline', async hoverProvider => {
        (LanguageClient as unknown as jest.Mock).mockImplementation(() => ({
            initializeResult: { capabilities: { hoverProvider, documentSymbolProvider: true } },
            start: async () => undefined
        }));
        const context = {
            subscriptions: [], asAbsolutePath: (file: string) => file
        } as unknown as ExtensionContext;
        const server = new Verilbe_lsp(context, undefined, '/project/filelist');
        jest.spyOn(server, 'check_run').mockResolvedValue(true);
        jest.spyOn(server, 'embeddedVersion').mockReturnValue('test-version');
        expect(server.supportsHover()).toBe(false);
        await server.run();
        expect(server.supportsHover()).toBe(hoverProvider);
        const clientOptions = (LanguageClient as unknown as jest.Mock).mock.calls.slice(-1)[0][3];
        expect(clientOptions.middleware.provideDocumentSymbols()).toEqual([]);
    });
});
