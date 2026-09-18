import * as fs from 'fs';
import * as path from 'path';
import type { Symbol } from '../ctags/ctags';
import { VerilogModule, VerilogProjectParser } from 'colibri/parser/ts_verilog/project_model';
import type { TextDocument } from 'vscode';
import { BufferLanguageService } from './bufferService';
import type { CompletionScope } from '../ctags/providers/completionScopes';
import type { BufferSymbol } from './bufferWorker';

export interface LanguageSnapshot {
    filePath: string;
    symbols: Symbol[];
    modules: VerilogModule[];
    scopes?: CompletionScope[];
}

export interface FileSnapshot extends LanguageSnapshot { source: string }
export interface LiveFileSnapshot extends LanguageSnapshot { version: number }

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
    private liveSnapshots = new WeakMap<TextDocument, { version: number; epoch: number; saved?: FileSnapshot; work: Promise<LiveFileSnapshot> }>();
    private liveSymbols = new WeakMap<BufferSymbol, Symbol>();
    private liveArrays = new WeakMap<BufferSymbol[], Symbol[]>();

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
            const byNameLine = new Map<string, VerilogModule>();
            const endLines = new Map<VerilogModule, number>();
            let line = 0; let newline = source.indexOf('\n');
            for (const module of [...modules].sort((a, b) => a.end - b.end)) {
                while (newline >= 0 && newline < module.end) { line++; newline = source.indexOf('\n', newline + 1); }
                endLines.set(module, line);
                const key = `${module.name}\0${module.line}`;
                if (!byNameLine.has(key)) { byNameLine.set(key, module); }
            }
            for (const symbol of symbols) {
                if (symbol.type !== 'module') { continue; }
                const module = byNameLine.get(`${symbol.name}\0${symbol.startPosition.line}`);
                if (module) { symbol.setEndPosition(endLines.get(module)); }
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

    getBuffer(document: TextDocument): Promise<LiveFileSnapshot> {
        if (this.disposed) { return Promise.reject(new Error('File symbol cache disposed')); }
        if (document.isClosed) { return Promise.reject(new Error('Document closed')); }
        const version = document.version;
        const onDisk = !document.uri.scheme || document.uri.scheme === 'file';
        const epoch = onDisk ? this.epochs.get(fileKey(document.uri.fsPath)) ?? 0 : 0;
        const saved = onDisk ? this.peek(document.uri.fsPath) : undefined;
        const existing = this.liveSnapshots.get(document);
        if (existing?.version === version && existing.epoch === epoch && existing.saved === saved) { return existing.work; }
        const entry = { version, epoch, saved, work: this.bufferSnapshot(document, version) };
        this.liveSnapshots.set(document, entry);
        void entry.work.catch(() => {
            if (this.liveSnapshots.get(document) === entry) { this.liveSnapshots.delete(document); }
        });
        return entry.work;
    }

    private async bufferSnapshot(document: TextDocument, version: number): Promise<LiveFileSnapshot> {
        const snapshot = await this.buffers.get(document);
        if (snapshot.version !== version) { return this.getBuffer(document); }
        let converted = this.liveArrays.get(snapshot.symbols);
        if (!converted) {
            // Avoid loading VS Code-dependent symbols inside the parser worker.
            const SymbolClass = require('../ctags/ctags').Symbol;
            const PositionClass = require('vscode').Position;
            converted = snapshot.symbols.map(record => {
                const cached = this.liveSymbols.get(record);
                if (cached) { return cached; }
                const symbol = new SymbolClass(record.name, record.type, '', record.line,
                    record.parentScope, record.parentType, record.endLine, true);
                symbol.outlineDetail = record.outlineDetail; symbol.typeRef = record.typeRef;
                if (record.column !== undefined) { symbol.startPosition = new PositionClass(record.line, record.column); }
                if (record.endColumn !== undefined) { symbol.endPosition = new PositionClass(record.endLine, record.endColumn); }
                this.liveSymbols.set(record, symbol);
                return symbol;
            });
            this.liveArrays.set(snapshot.symbols, converted);
        }
        const supported = new Set(['module', 'port', 'register', 'net', 'instance', 'constant']);
        const saved = !document.uri.scheme || document.uri.scheme === 'file' ? this.peek(document.uri.fsPath) : undefined;
        // Keep ctags-only kinds available while the buffer parser is being evaluated.
        const extra = saved?.symbols.filter(symbol => !supported.has(symbol.type)) ?? [];
        const symbols = extra.length ? [...converted, ...extra] : converted;
        return { filePath: document.uri.fsPath, version, symbols, modules: snapshot.modules, scopes: snapshot.scopes };
    }

    closeBuffer(document: TextDocument): void {
        this.liveSnapshots.delete(document);
        this.buffers.close(document);
    }

    dispose(): void {
        this.disposed = true;
        this.buffers.dispose();
        this.liveSnapshots = new WeakMap(); this.liveSymbols = new WeakMap(); this.liveArrays = new WeakMap();
        this.entries.clear(); this.listeners.clear();
        // A running load may still be awaiting parser initialization; don't delete its parser early.
        void Promise.allSettled([...this.pending.values(), ...this.bufferParses]).then(() => this.parser.dispose());
    }
}
