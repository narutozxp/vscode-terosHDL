import * as path from 'path';
import * as vscode from 'vscode';
import type { Multi_project_manager } from 'colibri/project_manager/multi_project_manager';
import type { VerilogModule } from 'colibri/parser/ts_verilog/project_model';
import { FileSymbolCache, fileKey } from './fileCache';
import { ProjectSymbolIndex } from './projectIndex';
import type { Logger } from '../ctags/Logger';

const sourceGlob = '**/*.{v,sv,vh,svh}';
const excludedGlob = '**/{node_modules,.git,out,dist,build}/**';

/** Resolves explicit HDL projects first, then the configured fallback scope. */
export class ProjectLanguageService {
    private index: ProjectSymbolIndex;
    private workspaceFiles = new Map<string, Promise<string[]>>();
    private externalDirectories = new Set<string>();
    private bufferModels = new Map<string, { version: number; models: Promise<VerilogModule[]> }>();
    private disposed = false;

    constructor(private cache: FileSymbolCache, private manager: Multi_project_manager,
        private context: vscode.ExtensionContext, private logger: Logger) {
        this.index = new ProjectSymbolIndex(cache, (file, error) => logger.log(`Cannot index ${file}: ${error}`));
        context.subscriptions.push(this, cache);
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{v,sv,vh,svh,vhd,vhdl,tcl}');
        this.watch(watcher);
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.scheme === 'file') { cache.invalidate(document.uri.fsPath); }
        }));
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => this.bufferModels.delete(document.uri.toString())));
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument?.(event => {
            if (vscode.workspace.getConfiguration('zhdl', event.document.uri).get<boolean>('indexing.liveParsing', false)) {
                cache.buffers.changed(event.document);
            }
        }) ?? { dispose() {} });
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => cache.buffers.close(document)));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration?.(event => {
            if (!event.affectsConfiguration('zhdl.indexing.liveParsing')) { return; }
            this.bufferModels.clear();
            for (const document of vscode.workspace.textDocuments) {
                if (!vscode.workspace.getConfiguration('zhdl', document.uri).get<boolean>('indexing.liveParsing', false)) {
                    cache.buffers.close(document);
                }
            }
        }) ?? { dispose() {} });
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.workspaceFiles.clear()));
    }

    private watch(watcher: vscode.FileSystemWatcher): void {
        const changed = (uri: vscode.Uri) => { this.cache.invalidate(uri.fsPath); };
        const membershipChanged = (uri: vscode.Uri) => { changed(uri); this.workspaceFiles.clear(); };
        this.context.subscriptions.push(watcher, watcher.onDidChange(changed),
            watcher.onDidCreate(membershipChanged), watcher.onDidDelete(membershipChanged));
    }

    private watchExternal(files: string[]): void {
        for (const file of files) {
            if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))) { continue; }
            const directory = path.dirname(file);
            if (this.externalDirectories.has(directory)) { continue; }
            this.externalDirectories.add(directory);
            this.watch(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*.{v,sv,vh,svh}')));
        }
    }

    private async project(document: vscode.TextDocument): Promise<{ id: string; files: string[] }> {
        const current = fileKey(document.uri.fsPath);
        const projects = this.manager.get_projects();
        let selected: typeof projects[number] | undefined;
        try { selected = this.manager.get_selected_project(); } catch { /* No explicit project. */ }
        const candidates = selected ? [selected, ...projects.filter(project => project !== selected)] : projects;
        for (const project of candidates) {
            const files = project.get_file().map(file => file.name).filter(file => path.isAbsolute(file));
            if (files.some(file => fileKey(file) === current)) {
                this.watchExternal(files);
                return { id: `project:${project.get_name()}`, files };
            }
        }
        const scope = vscode.workspace.getConfiguration('zhdl', document.uri).get<string>('indexing.scope', 'openFiles');
        if (scope !== 'workspace') {
            const files = [...new Set([
                ...vscode.workspace.textDocuments.filter(open => open.uri.scheme === 'file' &&
                    /\.(?:v|sv|vh|svh)$/i.test(open.uri.fsPath)).map(open => fileKey(open.uri.fsPath)), current
            ])];
            this.watchExternal(files);
            return { id: 'openFiles', files };
        }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) { return { id: `file:${current}`, files: [current] }; }
        const id = folder.uri.toString();
        let files = this.workspaceFiles.get(id);
        if (!files) {
            files = Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(folder, sourceGlob), excludedGlob))
                .then(uris => uris.map(uri => uri.fsPath)).catch(error => { this.workspaceFiles.delete(id); throw error; });
            this.workspaceFiles.set(id, files);
        }
        return { id: `workspace:${id}`, files: [...new Set([...(await files), current])] };
    }

    async modules(document: vscode.TextDocument): Promise<VerilogModule[]> {
        if (this.disposed || document.uri.scheme !== 'file') { return []; }
        const project = await this.project(document);
        this.index.setFiles(project.id, project.files);
        const models = await this.index.modules(project.id);
        // The edited file's module headers come from the current buffer, without running ctags on keystrokes.
        const key = document.uri.toString();
        let buffer = this.bufferModels.get(key);
        if (!buffer || buffer.version !== document.version) {
            const live = vscode.workspace.getConfiguration('zhdl', document.uri).get<boolean>('indexing.liveParsing', false) === true;
            buffer = { version: document.version, models: live ? this.cache.buffers.get(document).then(snapshot => snapshot.modules) :
                this.cache.parseBuffer(document.getText(), document.uri.fsPath) };
            this.bufferModels.set(key, buffer);
        }
        let local: VerilogModule[];
        try { local = await buffer.models; }
        catch (error) {
            if (this.bufferModels.get(key) === buffer) { this.bufferModels.delete(key); }
            throw error;
        }
        return [...models.filter(model => fileKey(model.filePath) !== fileKey(document.uri.fsPath)), ...local];
    }

    warm(document: vscode.TextDocument): void {
        void this.modules(document).catch(error => this.logger.log(`Project indexing failed: ${error}`));
    }

    dispose(): void {
        this.disposed = true; this.index.dispose(); this.workspaceFiles.clear(); this.bufferModels.clear();
    }
}
