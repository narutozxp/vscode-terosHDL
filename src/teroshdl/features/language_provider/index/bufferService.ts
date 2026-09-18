import * as path from 'path';
import { Worker } from 'worker_threads';
import type { TextDocument, TextDocumentContentChangeEvent } from 'vscode';
import type { CompletionScope } from '../ctags/providers/completionScopes';
import type { BufferEdit } from './bufferText';
import type { VerilogModule } from '../../../../colibri/parser/ts_verilog/project_model';
import type { BufferDelta, BufferSymbol } from './bufferWorker';

export interface BufferSnapshot {
    version: number; modules: VerilogModule[]; symbols: BufferSymbol[]; scopes: CompletionScope[];
    timing: { parseMs: number; totalMs: number; retainedFiles: number; local?: boolean; extraction?: 'expression' | 'trivia' | 'items' | 'header' | 'module' | 'full'; inputMode: 'edits' | 'full'; inputChars: number; editCount: number; pieces?: number };
}

function compareSymbols(a: BufferSymbol, b: BufferSymbol): number {
    return a.offset - b.offset || a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
}

/** Sorted snapshots allow a linear merge without hashing or cloning unchanged symbols. */
export function applyBufferDelta(previous: BufferSymbol[], delta: BufferDelta): BufferSymbol[] {
    const added = [...delta.moduleSymbols, ...delta.added].sort(compareSymbols);
    const result: BufferSymbol[] = [];
    let index = 0; let right = 0;
    const next = (): BufferSymbol | undefined => {
        while (index < previous.length) {
            const symbol = previous[index++];
            if (symbol.type === 'module' || symbol.offset >= delta.start && symbol.offset < delta.end) { continue; }
            const renamed = delta.scopeRename && symbol.offset >= delta.scopeRename.start && symbol.offset < delta.scopeRename.end;
            const follows = symbol.offset >= delta.oldEnd;
            const column = follows && delta.oldEndPoint && delta.newEndPoint && symbol.line === delta.oldEndPoint.row && symbol.column !== undefined ?
                symbol.column + delta.newEndPoint.column - delta.oldEndPoint.column : symbol.column;
            const endColumn = follows && delta.oldEndPoint && delta.newEndPoint && symbol.endLine === delta.oldEndPoint.row && symbol.endColumn !== undefined ?
                symbol.endColumn + delta.newEndPoint.column - delta.oldEndPoint.column : symbol.endColumn;
            const updated = follows && (delta.offsetDelta || delta.lineDelta || column !== symbol.column || endColumn !== symbol.endColumn) ?
                { ...symbol, offset: symbol.offset + delta.offsetDelta, line: symbol.line + delta.lineDelta,
                    endLine: symbol.endLine + delta.lineDelta, column, endColumn } : symbol;
            return renamed ? { ...updated, parentScope: delta.scopeRename.name } : updated;
        }
    };
    let left = next();
    while (left || right < added.length) {
        let symbol: BufferSymbol;
        if (right >= added.length || left && compareSymbols(left, added[right]) < 0) {
            symbol = left; left = next();
        } else { symbol = added[right++]; }
        if (!result.length || compareSymbols(result[result.length - 1], symbol)) { result.push(symbol); }
    }
    return result;
}
interface Entry {
    document: TextDocument; snapshot?: BufferSnapshot; timer?: NodeJS.Timeout;
    running?: Promise<BufferSnapshot>; firstChange?: number;
    observedVersion?: number; generation?: number; edits?: BufferEdit[];
}

function documentKey(document: TextDocument): string {
    return !document.uri.scheme || document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString();
}

function editsFromChanges(changes: readonly TextDocumentContentChangeEvent[]): BufferEdit[] | undefined {
    // A VS Code event's ranges refer to the same old document. Apply from right to left.
    const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    const edits: BufferEdit[] = [];
    let boundary = Infinity;
    for (const change of sorted) {
        if (change.rangeOffset + change.rangeLength > boundary || change.rangeOffset === boundary) { return undefined; }
        boundary = change.rangeOffset;
        const rows = change.text.split('\n');
        const startPosition = { row: change.range.start.line, column: change.range.start.character };
        edits.push({ startIndex: change.rangeOffset, oldEndIndex: change.rangeOffset + change.rangeLength,
            text: change.text, startPosition,
            oldEndPosition: { row: change.range.end.line, column: change.range.end.character },
            newEndPosition: { row: startPosition.row + rows.length - 1,
                column: rows.length === 1 ? startPosition.column + change.text.length : rows[rows.length - 1].length } });
    }
    return edits;
}

/** Lazy shared worker; at most one request per file in flight, with edits coalesced. */
export class BufferLanguageService {
    private worker?: Worker;
    private sequence = 0;
    private generation = 0;
    private pending = new Map<number, { filePath: string; resolve(value: BufferSnapshot): void; reject(error: Error): void }>();
    private entries = new Map<string, Entry>();
    private disposed = false;
    constructor(private log: (message: string) => void) {}

    private entry(document: TextDocument, key: string): Entry {
        const existing = this.entries.get(key);
        // A reopened document can reuse both URI and version. It is a new lifetime.
        if (existing && existing.document !== document) { this.close(existing.document); }
        return this.entries.get(key) ?? { document };
    }

    private start(): Worker {
        if (!this.worker) {
            this.worker = new Worker(path.join(__dirname, 'bufferWorker.js'));
            this.generation++;
            const worker = this.worker;
            this.worker.on('message', message => {
                const request = this.pending.get(message.id); if (!request) { return; }
                this.pending.delete(message.id);
                if (message.error) { request.reject(new Error(message.error)); } else {
                    try { request.resolve(message); } catch (error) { request.reject(error); }
                }
                if (message.fatal) { failed(new Error(message.error)); void worker.terminate(); }
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

    changed(document: TextDocument, changes?: readonly TextDocumentContentChangeEvent[]): void {
        if (this.disposed || document.isClosed || !['verilog', 'systemverilog'].includes(document.languageId)) { return; }
        const key = documentKey(document);
        const entry = this.entry(document, key);
        entry.document = document;
        if (entry.observedVersion !== document.version) {
            const edits = changes && entry.observedVersion + 1 === document.version ? editsFromChanges(changes) : undefined;
            entry.edits = entry.edits && edits ? [...entry.edits, ...edits] : undefined;
            if (entry.edits && (entry.edits.length > 128 || entry.edits.reduce((size, edit) => size + edit.text.length, 0) > 65536)) {
                entry.edits = undefined;
            }
            entry.observedVersion = document.version;
        }
        entry.firstChange ??= Date.now();
        if (entry.timer) { clearTimeout(entry.timer); }
        if (entry.running) {
            // The in-flight get drains accumulated edits before returning the latest version.
            // Avoid creating more timers and awaiters while a long extraction is running.
            entry.timer = undefined; this.entries.set(key, entry); return;
        }
        const delay = Math.max(0, Math.min(150 - (Date.now() - entry.firstChange),
            Math.max(30, Math.min(100, entry.snapshot?.timing.totalMs ?? 30))));
        entry.timer = setTimeout(() => { entry.timer = undefined; void this.get(document).catch(error => this.log(`Buffer parsing failed: ${error}`)); }, delay);
        this.entries.set(key, entry);
    }

    async get(document: TextDocument): Promise<BufferSnapshot> {
        if (this.disposed) { throw new Error('Buffer service disposed'); }
        const key = documentKey(document);
        if (document.isClosed) {
            if (this.entries.get(key)?.document === document) { this.close(document); }
            throw new Error('Document closed');
        }
        const entry = this.entry(document, key);
        entry.document = document; this.entries.set(key, entry);
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
        if (entry.snapshot?.version === document.version) { entry.firstChange = undefined; return entry.snapshot; }
        if (!entry.running) {
            const id = ++this.sequence;
            const worker = this.start();
            const generation = this.generation;
            const version = document.version;
            const edits = entry.generation === generation && entry.snapshot && entry.observedVersion === version ? entry.edits : undefined;
            const baseVersion = entry.snapshot?.version;
            entry.edits = []; entry.observedVersion = version;
            entry.running = new Promise<BufferSnapshot>((resolve, reject) => {
                this.pending.set(id, { filePath: key, resolve: (message: any) => {
                    if (message.resync) {
                        const error = new Error('Buffer worker requires full sync'); error.name = 'BufferResync'; reject(error); return;
                    }
                    resolve(message.reused ? { ...entry.snapshot, ...message } : message.delta ?
                        { ...message, symbols: message.delta.symbolsUnchanged ? entry.snapshot.symbols :
                            applyBufferDelta(entry.snapshot?.symbols ?? [], message.delta) } :
                        { ...message, symbols: message.symbols.sort(compareSymbols) });
                }, reject });
                try {
                    worker.postMessage(edits ? { id, filePath: key, version, baseVersion, edits } :
                        { id, filePath: key, version, source: document.getText() });
                } catch (error) {
                    this.pending.delete(id); reject(error);
                }
            }).then(snapshot => {
                entry.snapshot = snapshot; entry.generation = generation; entry.firstChange = undefined; return snapshot;
            }).catch(error => { entry.generation = undefined; throw error; })
                .finally(() => { entry.running = undefined; });
        }
        let result: BufferSnapshot;
        try { result = await entry.running; }
        catch (error) {
            if (error.name === 'BufferResync' && this.entries.get(key) === entry && !this.disposed) { return this.get(document); }
            throw error;
        }
        if (this.entries.get(key) !== entry || this.disposed) { throw new Error('Document closed'); }
        return result.version === document.version ? result : this.get(document);
    }

    close(document: TextDocument): void {
        const key = documentKey(document); const entry = this.entries.get(key);
        if (entry?.timer) { clearTimeout(entry.timer); }
        this.entries.delete(key);
        for (const [id, request] of this.pending) {
            if (request.filePath === key) {
                this.pending.delete(id); request.reject(new Error('Document closed'));
            }
        }
        this.worker?.postMessage({ close: true, filePath: key, beforeId: this.sequence });
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
