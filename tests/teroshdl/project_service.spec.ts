import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocument } from 'vscode';
import { ProjectLanguageService } from '../../src/teroshdl/features/language_provider/index/projectService';
import { FileSymbolCache } from '../../src/teroshdl/features/language_provider/index/fileCache';

// Workers run compiled JavaScript rather than ts-jest's in-process TypeScript transforms.
jest.mock('../../src/teroshdl/features/language_provider/index/bufferService', () =>
    require('../../out/teroshdl/features/language_provider/index/bufferService'));

jest.mock('vscode', () => {
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => 'file://' + file });
    const disposable = () => ({ dispose() {} });
    const watchers: any[] = [];
    return {
        Uri: { file: uri },
        RelativePattern: class { constructor(public base: any, public pattern: string) {} },
        workspace: {
            watchers,
            textDocuments: [], getConfiguration: jest.fn(),
            getWorkspaceFolder: jest.fn(), findFiles: jest.fn(),
            createFileSystemWatcher: jest.fn(() => {
                const watcher: any = { dispose() {} };
                for (const kind of ['Change', 'Create', 'Delete']) {
                    watcher['onDid' + kind] = (callback: any) => { watcher[kind] = callback; return disposable(); };
                }
                watchers.push(watcher); return watcher;
            }),
            onDidSaveTextDocument: jest.fn(disposable), onDidCloseTextDocument: jest.fn(disposable),
            onDidChangeWorkspaceFolders: jest.fn(disposable)
        }
    };
}, { virtual: true });

describe('Project service discovery and buffer overlays', () => {
    let directory: string; let cache: FileSymbolCache; let service: ProjectLanguageService;
    const vscode = jest.requireMock('vscode');
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl-project-'));
        vscode.workspace.watchers.length = 0;
        vscode.workspace.getWorkspaceFolder.mockReset(); vscode.workspace.findFiles.mockReset();
        vscode.workspace.textDocuments = [];
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => 'openFiles' });
    });
    afterEach(() => { service?.dispose(); cache?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    function file(name: string, source: string) { const target = path.join(directory, name); fs.writeFileSync(target, source); return target; }
    function document(target: string, source: string, version = 1): TextDocument {
        return { uri: vscode.Uri.file(target), version, getText: () => source } as unknown as TextDocument;
    }
    function setup(projects: any[] = []) {
        cache = new FileSymbolCache(async () => []);
        service = new ProjectLanguageService(cache, {
            get_projects: () => projects, get_selected_project: () => projects[0]
        } as any, { subscriptions: [] } as any, { log: jest.fn() } as any);
    }
    it('prefers explicit project membership over all workspace files', async () => {
        const top = file('top.sv', 'module top; endmodule');
        const child = file('child.sv', 'module child; endmodule');
        const unrelated = file('unrelated.sv', 'module unrelated; endmodule');
        vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: vscode.Uri.file(directory) });
        vscode.workspace.findFiles.mockResolvedValue([top, child, unrelated].map(vscode.Uri.file));
        setup([{ get_name: () => 'project', get_file: () => [top, child].map(name => ({ name })) }]);
        expect((await service.modules(document(top, 'module top; endmodule'))).map(model => model.name).sort()).toEqual(['child', 'top']);
        expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });
    it('refreshes discovered membership on create/delete and uses current buffer headers', async () => {
        const top = file('top.sv', 'module top; endmodule');
        const child = file('child.sv', 'module child(input clk); endmodule');
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => 'workspace' });
        vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: vscode.Uri.file(directory) });
        vscode.workspace.findFiles.mockResolvedValue([top, child].map(vscode.Uri.file)); setup();
        const doc = document(top, 'module edited(input reset); endmodule');
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'edited']);
        const extra = file('extra.sv', 'module extra; endmodule');
        vscode.workspace.findFiles.mockResolvedValue([top, extra].map(vscode.Uri.file));
        fs.unlinkSync(child); vscode.workspace.watchers[0].Delete(vscode.Uri.file(child));
        vscode.workspace.watchers[0].Create(vscode.Uri.file(extra));
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['edited', 'extra']);
        expect((await service.modules(document(top, 'module newer; endmodule', 2))).map(model => model.name).sort()).toEqual(['extra', 'newer']);
    });
    it('limits standalone documents to their own file', async () => {
        const top = file('top.sv', 'module top; endmodule');
        file('other.sv', 'module other; endmodule'); setup();
        expect((await service.modules(document(top, 'module top; endmodule'))).map(model => model.name)).toEqual(['top']);
        expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
    });

    it('defaults to all open HDL files and removes modules when files close', async () => {
        const top = file('top.sv', 'module top; endmodule');
        const child = file('child.v', 'module child; endmodule');
        const hidden = file('hidden.v', 'module hidden; endmodule');
        const text = file('notes.txt', 'module invalid; endmodule');
        const doc = document(top, 'module top; endmodule');
        vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: vscode.Uri.file(directory) });
        vscode.workspace.textDocuments = [doc, document(child, fs.readFileSync(child, 'utf8')), document(text, '')];
        vscode.workspace.findFiles.mockResolvedValue([top, child, hidden].map(vscode.Uri.file)); setup();
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'top']);
        expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
        vscode.workspace.textDocuments = [doc];
        expect((await service.modules(doc)).map(model => model.name)).toEqual(['top']);
        vscode.workspace.textDocuments.push(document(child, 'module child; endmodule'));
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'top']);
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => 'workspace' });
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'hidden', 'top']);
        vscode.workspace.getConfiguration.mockReturnValue({ get: () => 'openFiles' });
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'top']);
    });
});
