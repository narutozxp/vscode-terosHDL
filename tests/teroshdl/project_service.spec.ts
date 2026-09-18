import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocument } from 'vscode';
import { ProjectLanguageService } from '../../src/teroshdl/features/language_provider/index/projectService';
import { FileSymbolCache } from '../../src/teroshdl/features/language_provider/index/fileCache';
import { GlobalConfigManager } from '../../src/colibri/config/config_manager';
import { e_general_general_indexing_scope } from '../../src/colibri/config/config_declaration';

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
            textDocuments: [],
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
        GlobalConfigManager.newInstance('');
    });
    afterEach(() => { service?.dispose(); cache?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
    function file(name: string, source: string) { const target = path.join(directory, name); fs.writeFileSync(target, source); return target; }
    function scope(value: e_general_general_indexing_scope) {
        const config = GlobalConfigManager.getInstance().get_config();
        config.general.general.indexing_scope = value;
        GlobalConfigManager.getInstance().set_config(config);
    }
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
        scope(e_general_general_indexing_scope.workspace);
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

    it('releases buffer workers when live parsing is disabled and unsubscribes on disposal', () => {
        const top = file('top.sv', 'module top; endmodule');
        const doc = document(top, 'module top; endmodule');
        vscode.workspace.textDocuments = [doc];
        setup();
        const close = jest.spyOn(cache.buffers, 'close');
        const config = GlobalConfigManager.getInstance().get_config();
        config.general.general.live_parsing = true;
        GlobalConfigManager.getInstance().set_config(config);
        expect(close).not.toHaveBeenCalled();
        config.general.general.live_parsing = false;
        GlobalConfigManager.getInstance().set_config(config);
        expect(close).toHaveBeenCalledWith(doc);
        service.dispose();
        GlobalConfigManager.getInstance().set_config(config);
        expect(close).toHaveBeenCalledTimes(1);
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
        scope(e_general_general_indexing_scope.workspace);
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'hidden', 'top']);
        scope(e_general_general_indexing_scope.openFiles);
        expect((await service.modules(doc)).map(model => model.name).sort()).toEqual(['child', 'top']);
    });

    it('consumes unsaved interfaces from other open project files and restores disk models on close', async () => {
        const top = file('top.sv', 'module top; endmodule');
        const header = file('child.svh', 'module child(input old_port); endmodule');
        const excluded = file('excluded.sv', 'module excluded; endmodule');
        const current = document(top, 'module top; endmodule');
        vscode.workspace.textDocuments = [current, document(header, 'module child(input new_port); endmodule'),
            document(excluded, 'module must_not_leak; endmodule')];
        setup([{ get_name: () => 'project', get_file: () => [top, header].map(name => ({ name })) }]);
        const config = GlobalConfigManager.getInstance().get_config();
        config.general.general.live_parsing = true;
        GlobalConfigManager.getInstance().set_config(config);
        let models = await service.modules(current);
        expect(models.map(model => model.name).sort()).toEqual(['child', 'top']);
        expect(models.find(model => model.name === 'child').ports.map(port => port.name)).toEqual(['new_port']);
        const requests = jest.spyOn(cache.buffers, 'get');
        await service.modules(current);
        expect(requests).not.toHaveBeenCalled();
        vscode.workspace.textDocuments[1] = document(header, 'module renamed(input reset); endmodule', 2);
        models = await service.modules(current);
        expect(models.map(model => model.name).sort()).toEqual(['renamed', 'top']);
        expect(models.find(model => model.name === 'renamed').ports.map(port => port.name)).toEqual(['reset']);
        vscode.workspace.textDocuments[1] = document(header, 'module reopened(input current); endmodule', 2);
        models = await service.modules(current);
        expect(models.map(model => model.name).sort()).toEqual(['reopened', 'top']);
        vscode.workspace.textDocuments = [current];
        models = await service.modules(current);
        expect(models.find(model => model.name === 'child').ports.map(port => port.name)).toEqual(['old_port']);
        expect(models.some(model => model.name === 'renamed')).toBe(false);
    });

    it('uses saved models for other clean tabs without initializing extra buffer states', async () => {
        const top = file('top.sv', 'module top; endmodule');
        const child = file('child.sv', 'module child(input clk); endmodule');
        const current = document(top, 'module top; endmodule');
        const clean = { ...document(child, 'module child(input clk); endmodule'), isDirty: false };
        vscode.workspace.textDocuments = [current, clean];
        setup([{ get_name: () => 'project', get_file: () => [top, child].map(name => ({ name })) }]);
        const config = GlobalConfigManager.getInstance().get_config();
        config.general.general.live_parsing = true;
        GlobalConfigManager.getInstance().set_config(config);
        const requests = jest.spyOn(cache.buffers, 'get');
        expect((await service.modules(current)).map(model => model.name).sort()).toEqual(['child', 'top']);
        expect(requests).toHaveBeenCalledTimes(1);
        expect(requests).toHaveBeenCalledWith(current);
    });
});
