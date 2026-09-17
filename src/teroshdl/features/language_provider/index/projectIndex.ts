import { FileSnapshot, FileSymbolCache, fileKey } from './fileCache';
import { VerilogModule } from 'colibri/parser/ts_verilog/project_model';

interface ProjectState {
    files: Set<string>;
    snapshots: Map<string, FileSnapshot>;
    dirty: Set<string>;
    failed: Set<string>;
    pending?: Promise<void>;
}

/** Project membership is separate from the shared file cache; symbols never leak between projects. */
export class ProjectSymbolIndex {
    private projects = new Map<string, ProjectState>();
    private subscription: { dispose(): void };

    constructor(private cache: FileSymbolCache, private reportError: (file: string, error: unknown) => void) {
        this.subscription = cache.onInvalidate(file => {
            for (const project of this.projects.values()) {
                if (project.files.has(file)) { project.dirty.add(file); }
            }
        });
    }

    setFiles(projectId: string, files: string[]): void {
        let project = this.projects.get(projectId);
        if (!project) {
            project = { files: new Set(), snapshots: new Map(), dirty: new Set(), failed: new Set() };
            this.projects.set(projectId, project);
        }
        const next = new Set(files.filter(file => /\.(?:v|sv|vh|svh)$/i.test(file)).map(fileKey));
        for (const file of next) { if (!project.files.has(file)) { project.dirty.add(file); } }
        for (const file of project.files) {
            if (!next.has(file)) { project.snapshots.delete(file); project.dirty.delete(file); project.failed.delete(file); }
        }
        project.files = next;
    }

    async modules(projectId: string): Promise<VerilogModule[]> {
        const project = this.projects.get(projectId);
        if (!project) { return []; }
        for (const file of project.failed) { project.dirty.add(file); }
        while (project.pending || project.dirty.size > 0) {
            if (!project.pending) {
                const files = [...project.dirty];
                project.dirty.clear();
                const work = Promise.all(files.map(async file => {
                    try {
                        const snapshot = await this.cache.get(file);
                        if (project.files.has(file) && !project.dirty.has(file)) {
                            project.snapshots.set(file, snapshot); project.failed.delete(file);
                        }
                    } catch (error) {
                        project.snapshots.delete(file);
                        if (project.files.has(file)) { project.failed.add(file); }
                        this.reportError(file, error);
                    }
                })).then(() => undefined);
                project.pending = work.finally(() => { project.pending = undefined; });
            }
            await project.pending;
        }
        return [...project.snapshots.values()].flatMap(snapshot => snapshot.modules);
    }

    dispose(): void { this.subscription.dispose(); this.projects.clear(); }
}
