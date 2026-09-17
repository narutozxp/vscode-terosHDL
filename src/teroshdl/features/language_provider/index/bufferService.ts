import * as path from 'path';
import { Worker } from 'worker_threads';
import type { TextDocument } from 'vscode';
import type { VerilogModule } from '../../../../colibri/parser/ts_verilog/project_model';
import type { BufferDelta, BufferSymbol } from './bufferWorker';

export interface BufferSnapshot {
    version: number; modules: VerilogModule[]; symbols: BufferSymbol[];
    timing: { parseMs: number; totalMs: number; retainedFiles: number };
}

export function applyBufferDelta(previous: BufferSymbol[], delta: BufferDelta): BufferSymbol[] {
    const records = previous.filter(symbol => symbol.type !== 'module' && (symbol.offset < delta.start || symbol.offset >= delta.end))
        .map(symbol => symbol.offset >= delta.oldEnd ? { ...symbol, offset: symbol.offset + delta.offsetDelta,
            line: symbol.line + delta.lineDelta, endLine: symbol.endLine + delta.lineDelta } : symbol);
    records.push(...delta.moduleSymbols, ...delta.added);
    return [...new Map(records.map(symbol => [`${symbol.offset}:${symbol.type}:${symbol.name}`, symbol])).values()];
}
interface Entry {
    document: TextDocument; snapshot?: BufferSnapshot; timer?: NodeJS.Timeout;
    running?: Promise<BufferSnapshot>; firstChange: number;
}

/** Lazy shared worker; at most one request per file in flight, with edits coalesced. */
export class BufferLanguageService {
    private worker?: Worker;
    private sequence = 0;
    private pending = new Map<number, { resolve(value: BufferSnapshot): void; reject(error: Error): void }>();
    private entries = new Map<string, Entry>();
    private disposed = false;
    constructor(private log: (message: string) => void) {}

    private start(): Worker {
        if (!this.worker) {
            this.worker = new Worker(path.join(__dirname, 'bufferWorker.js'));
            const worker = this.worker;
            this.worker.on('message', message => {
                const request = this.pending.get(message.id); if (!request) { return; }
                this.pending.delete(message.id);
                if (message.error) { request.reject(new Error(message.error)); } else { request.resolve(message); }
            });
            const failed = (error: Error) => {
                if (this.worker !== worker) { return; }
                for (const request of this.pending.values()) { request.reject(error); }
                this.pending.clear(); this.worker = undefined;
            };
            worker.on('error', failed);
            worker.on('exit', code => failed(new Error(`Buffer worker exited (${code})`)));
        }
        return this.worker;
    }

    changed(document: TextDocument): void {
        if (this.disposed || !['verilog', 'systemverilog'].includes(document.languageId)) { return; }
        const key = document.uri.fsPath;
        const entry = this.entries.get(key) ?? { document, firstChange: Date.now() };
        entry.document = document;
        if (entry.timer) { clearTimeout(entry.timer); }
        const delay = Math.max(0, Math.min(150 - (Date.now() - entry.firstChange),
            Math.max(30, Math.min(100, entry.snapshot?.timing.totalMs ?? 30))));
        entry.timer = setTimeout(() => { entry.timer = undefined; void this.get(document).catch(error => this.log(`Buffer parsing failed: ${error}`)); }, delay);
        this.entries.set(key, entry);
    }

    async get(document: TextDocument): Promise<BufferSnapshot> {
        if (this.disposed) { throw new Error('Buffer service disposed'); }
        const key = document.uri.fsPath;
        const entry = this.entries.get(key) ?? { document, firstChange: Date.now() };
        entry.document = document; this.entries.set(key, entry);
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
        if (entry.snapshot?.version === document.version) { return entry.snapshot; }
        if (!entry.running) {
            const id = ++this.sequence;
            const worker = this.start();
            entry.running = new Promise<BufferSnapshot>((resolve, reject) => {
                this.pending.set(id, { resolve: (message: any) => resolve(message.delta ?
                    { ...message, symbols: applyBufferDelta(entry.snapshot?.symbols ?? [], message.delta) } : message), reject });
                worker.postMessage({ id, filePath: key, version: document.version, source: document.getText() });
            }).then(snapshot => { entry.snapshot = snapshot; entry.firstChange = Date.now(); return snapshot; })
                .finally(() => { entry.running = undefined; });
        }
        const result = await entry.running;
        if (this.entries.get(key) !== entry || this.disposed) { throw new Error('Document closed'); }
        return result.version === document.version ? result : this.get(document);
    }

    close(document: TextDocument): void {
        const key = document.uri.fsPath; const entry = this.entries.get(key);
        if (entry?.timer) { clearTimeout(entry.timer); }
        this.entries.delete(key); this.worker?.postMessage({ close: true, filePath: key });
        if (!this.entries.size && this.worker) {
            for (const request of this.pending.values()) { request.reject(new Error('Documents closed')); }
            this.pending.clear(); void this.worker.terminate(); this.worker = undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const entry of this.entries.values()) { if (entry.timer) { clearTimeout(entry.timer); } }
        this.entries.clear();
        for (const request of this.pending.values()) { request.reject(new Error('Buffer service disposed')); }
        this.pending.clear(); void this.worker?.terminate(); this.worker = undefined;
    }
}
