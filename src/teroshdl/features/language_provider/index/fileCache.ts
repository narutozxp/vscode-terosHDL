import * as fs from 'fs';
import * as path from 'path';
import type { Symbol } from '../ctags/ctags';
import { VerilogModule, VerilogProjectParser } from 'colibri/parser/ts_verilog/project_model';
import type { TextDocument } from 'vscode';
import { BufferLanguageService } from './bufferService';

export interface FileSnapshot {
    filePath: string;
    source: string;
    symbols: Symbol[];
    modules: VerilogModule[];
}

export function fileKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fingerprint(stat: fs.Stats): string {
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
}

/** Complete saved-file snapshots, shared in-flight requests, bounded parser concurrency. */
export class FileSymbolCache {
    readonly buffers = new BufferLanguageService(message => console.warn(message));
    private entries = new Map<string, { stamp: string; epoch: number; snapshot: FileSnapshot }>();
    private epochs = new Map<string, number>();
    private pending = new Map<string, Promise<FileSnapshot>>();
    private listeners = new Set<(filePath: string) => void>();
    private active = 0;
    private queue: (() => void)[] = [];
    private disposed = false;
    private parser = new VerilogProjectParser();
    private bufferParses = new Set<Promise<VerilogModule[]>>();

    constructor(private loadSymbols: (filePath: string, source: string) => Promise<Symbol[]>) {}

    onInvalidate(listener: (filePath: string) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    invalidate(filePath: string): void {
        const key = fileKey(filePath);
        this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
        this.entries.delete(key);
        for (const listener of this.listeners) { listener(key); }
    }

    peek(filePath: string): FileSnapshot | undefined { return this.entries.get(fileKey(filePath))?.snapshot; }

    private async limited<T>(work: () => Promise<T>): Promise<T> {
        if (this.active >= 2) { await new Promise<void>(resolve => this.queue.push(resolve)); }
        else { this.active++; }
        try {
            if (this.disposed) { throw new Error('File symbol cache disposed'); }
            return await work();
        } finally {
            const next = this.queue.shift();
            if (next) { next(); } else { this.active--; }
        }
    }

    async get(filePath: string): Promise<FileSnapshot> {
        if (this.disposed) { throw new Error('File symbol cache disposed'); }
        const key = fileKey(filePath);
        const stamp = fingerprint(await fs.promises.stat(key));
        if (this.entries.get(key)?.stamp && this.entries.get(key).stamp !== stamp) { this.invalidate(key); }
        const epoch = this.epochs.get(key) ?? 0;
        const cached = this.entries.get(key);
        if (cached?.stamp === stamp && cached.epoch === epoch) { return cached.snapshot; }
        const requestKey = `${key}\0${epoch}\0${stamp}`;
        const existing = this.pending.get(requestKey);
        if (existing) { return existing; }
        const promise = this.limited(async () => {
            const source = await fs.promises.readFile(key, 'utf8');
            const symbols = await this.loadSymbols(key, source);
            const modules = /\.(?:v|sv|vh|svh)$/i.test(key) ? await this.parser.parse(source, key) : [];
            for (const symbol of symbols) {
                if (symbol.type !== 'module') { continue; }
                const module = modules.find(module => module.name === symbol.name && module.line === symbol.startPosition.line);
                if (module) { symbol.setEndPosition(source.slice(0, module.end).split('\n').length - 1); }
            }
            const currentStamp = fingerprint(await fs.promises.stat(key));
            if (this.disposed) { throw new Error('File symbol cache disposed'); }
            if ((this.epochs.get(key) ?? 0) !== epoch || currentStamp !== stamp) { return undefined; }
            const snapshot = { filePath: key, source, symbols, modules };
            this.entries.set(key, { stamp, epoch, snapshot });
            return snapshot;
        }).then(snapshot => snapshot ?? this.get(key)).finally(() => this.pending.delete(requestKey));
        this.pending.set(requestKey, promise);
        return promise;
    }

    async parseBuffer(source: string, filePath: string): Promise<VerilogModule[]> {
        if (this.disposed) { return []; }
        const work = this.parser.parse(source, filePath);
        this.bufferParses.add(work);
        try { return await work; } finally { this.bufferParses.delete(work); }
    }

    async getBuffer(document: TextDocument): Promise<FileSnapshot> {
        const version = document.version;
        const source = document.getText();
        const snapshot = await this.buffers.get(document);
        if (snapshot.version !== version) { return this.getBuffer(document); }
        // Avoid loading VS Code-dependent symbols inside the parser worker.
        const SymbolClass = require('../ctags/ctags').Symbol;
        const symbols: Symbol[] = snapshot.symbols.map(record => {
            const symbol = new SymbolClass(record.name, record.type, '', record.line,
                record.parentScope, record.parentType, record.endLine, true);
            symbol.outlineDetail = record.outlineDetail; symbol.typeRef = record.typeRef;
            return symbol;
        });
        const supported = new Set(['module', 'port', 'register', 'net', 'instance', 'constant']);
        const saved = this.peek(document.uri.fsPath);
        // Keep ctags-only kinds available while the buffer parser is being evaluated.
        symbols.push(...(saved?.symbols.filter(symbol => !supported.has(symbol.type)) ?? []));
        return { filePath: document.uri.fsPath, source, symbols, modules: snapshot.modules };
    }

    dispose(): void {
        this.disposed = true;
        this.buffers.dispose();
        this.entries.clear(); this.listeners.clear();
        // A running load may still be awaiting parser initialization; don't delete its parser early.
        void Promise.allSettled([...this.pending.values(), ...this.bufferParses]).then(() => this.parser.dispose());
    }
}
