import { LanguageProviderManager } from '../../src/teroshdl/features/language_provider/language_provider';
import { Verilbe_lsp } from '../../src/teroshdl/features/language_provider/lsp/verible';
import * as vscode from 'vscode';

jest.mock('vscode', () => ({
    languages: {
        registerCompletionItemProvider: jest.fn(),
        registerDocumentSymbolProvider: jest.fn(),
        registerHoverProvider: jest.fn(),
        registerDefinitionProvider: jest.fn()
    },
    commands: { registerCommand: jest.fn() }
}), { virtual: true });
jest.mock('../../src/teroshdl/features/utils/utils', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/lsp/verible', () => ({
    Verilbe_lsp: jest.fn()
}));
jest.mock('../../src/teroshdl/features/language_provider/lsp/rust_hdl', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/ctags', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/Logger', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/providers/CompletionItemProvider', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/providers/DocumentSymbolProvider', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/providers/HoverProvider', () => ({}));
jest.mock('../../src/teroshdl/features/language_provider/ctags/providers/DefinitionProvider', () => ({}));

describe('Verilog language service fallback registration', () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
        [true, false, 1, 0],
        [true, true, 0, 0],
        [false, false, 1, 1]
    ])('server running=%s, hover supported=%s', async (running, hoverSupported, hoverCount, definitionCount) => {
        (Verilbe_lsp as jest.Mock).mockImplementation(() => ({
            run: async () => running,
            supportsHover: () => hoverSupported
        }));
        // Exercise configuration without starting the unrelated VHDL and project managers.
        const manager = Object.create(LanguageProviderManager.prototype);
        manager.context = { subscriptions: [] };
        manager.provider_list = { completion: {}, doc: {}, hover: {}, def: {} };
        await manager.configure_verilog('/project/filelist');

        expect(vscode.languages.registerHoverProvider).toHaveBeenCalledTimes(hoverCount as number);
        expect(vscode.languages.registerDefinitionProvider).toHaveBeenCalledTimes(definitionCount as number);
        expect(vscode.languages.registerDocumentSymbolProvider).toHaveBeenCalledTimes(1);
        expect(vscode.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1);
    });
});
