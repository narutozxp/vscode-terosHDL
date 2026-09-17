import { parentPort } from 'worker_threads';
import { performance } from 'perf_hooks';
import * as Parser from 'web-tree-sitter';
import { getVerilogWasmPath } from '../../../../colibri/parser/utils';
import { VerilogModule, VerilogProjectParser, verilogTokens } from '../../../../colibri/parser/ts_verilog/project_model';
import { getSignalDescriptions } from '../ctags/providers/signalDescriptions';
import { SYSTEMVERILOG_KEYWORDS } from '../ctags/providers/keywords';

export interface BufferSymbol {
    name: string; type: string; line: number; endLine: number;
    parentScope: string; parentType: string; outlineDetail?: string; typeRef?: string;
    offset?: number;
}
export interface BufferDelta {
    start: number; end: number; oldEnd: number; offsetDelta: number; lineDelta: number;
    added: BufferSymbol[]; moduleSymbols: BufferSymbol[];
}
const skip = new Set(['continuous_assign', 'blocking_assignment', 'nonblocking_assignment',
    'packed_dimension', 'unpacked_dimension', 'constant_expression', 'expression', 'primary', 'constant_primary']);
const kinds: Record<string, string> = { variable_decl_assignment: 'register', net_decl_assignment: 'net',
    param_assignment: 'constant', type_assignment: 'constant', name_of_instance: 'instance' };
const reserved = new Set(SYSTEMVERILOG_KEYWORDS);
interface State { source: string; tree: Parser.Tree; modules: VerilogModule[]; symbols: BufferSymbol[] }
const states = new Map<string, State>();
let parser: Parser;
const models = new VerilogProjectParser();
const ready = (async () => {
    await Parser.init(); parser = new Parser(); parser.setLanguage(await Parser.Language.load(getVerilogWasmPath()));
})();
// Keep line maps for only the current/previous source, rather than rescanning for every symbol.
const lineMaps = new Map<string, number[]>();

function point(source: string, end: number): Parser.Point {
    let lines = lineMaps.get(source);
    if (!lines) {
        lines = [0];
        for (let index = 0; index < source.length; index++) { if (source.charCodeAt(index) === 10) { lines.push(index + 1); } }
        if (lineMaps.size >= 2) { lineMaps.delete(lineMaps.keys().next().value); }
        lineMaps.set(source, lines);
    }
    let lower = 0; let upper = lines.length;
    while (lower + 1 < upper) {
        const middle = (lower + upper) >>> 1;
        if (lines[middle] <= end) { lower = middle; } else { upper = middle; }
    }
    return { row: lower, column: end - lines[lower] };
}

function collect(node: Parser.SyntaxNode, scope: string): BufferSymbol[] {
    const type = node.type;
    if (skip.has(type) || type === 'ERROR') { return []; }
    const kind = kinds[type];
    if (kind) {
        const identifier = node.namedChild(0);
        // ERROR recovery occasionally interprets keywords as declaration identifiers.
        if (!identifier || !/identifier$/.test(identifier.type) && identifier.type !== 'name_of_instance') { return []; }
        if (reserved.has(identifier.text)) { return []; }
        const symbol: BufferSymbol = { name: identifier.text, type: kind,
            offset: identifier.startIndex,
            line: identifier.startPosition.row - node.startPosition.row,
            endLine: identifier.startPosition.row - node.startPosition.row, parentScope: scope, parentType: 'module' };
        if (kind === 'instance') {
            let parent = node.parent;
            while (parent && !/instantiation$/.test(parent.type)) { parent = parent.parent; }
            if (!parent || parent.hasError()) { return []; }
            symbol.typeRef = parent?.namedChild(0)?.text;
        } else if (kind === 'register' || kind === 'net') {
            let declaration = node.parent;
            while (declaration && !['data_declaration', 'net_declaration'].includes(declaration.type)) { declaration = declaration.parent; }
            if (!declaration || declaration.hasError()) { return []; }
            if (declaration) {
                const metadataTarget = { name: symbol.name, type: kind,
                    startPosition: { line: identifier.startPosition.row - declaration.startPosition.row } };
                symbol.outlineDetail = getSignalDescriptions(declaration.text, [metadataTarget]).get(metadataTarget);
            }
        }
        return [symbol];
    }
    // Ports come from the module model: it preserves inherited ANSI declarations.
    if (['module_header', 'module_ansi_header', 'module_nonansi_header', 'port_declaration'].includes(type)) { return []; }
    const result: BufferSymbol[] = [];
    for (const child of node.namedChildren) {
        const delta = child.startPosition.row - node.startPosition.row;
        for (const symbol of collect(child, scope)) {
            result.push({ ...symbol, line: symbol.line + delta, endLine: symbol.endLine + delta });
        }
    }
    return result;
}

function recoveredSignals(source: string, module: VerilogModule): BufferSymbol[] {
    const body = source.slice(module.bodyStart, module.end);
    const masked = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"/g, text => text.replace(/[^\n]/g, ' '));
    const declarations = /(?:^|[;\n])\s*(?:reg|wire|logic|bit|tri|int|integer|byte|shortint|longint|time)\b[^;]*;/g;
    const symbols: BufferSymbol[] = [];
    let match: RegExpExecArray | null;
    while ((match = declarations.exec(masked))) {
        const tokens = verilogTokens(match[0]);
        const kindIndex = tokens[0]?.text === ';' ? 1 : 0;
        const kind = tokens[kindIndex]?.text;
        let depth = 0; let named = false;
        for (let index = kindIndex + 1; index < tokens.length; index++) {
            const token = tokens[index];
            if (['[', '(', '{'].includes(token.text)) { depth++; continue; }
            if ([']', ')', '}'].includes(token.text)) { depth--; continue; }
            if (depth) { continue; }
            if (token.text === ',') { named = false; continue; }
            if (named || ['signed', 'unsigned', ';'].includes(token.text) || !/^[a-zA-Z_$\\]/.test(token.text)) { continue; }
            named = true;
            const offset = module.bodyStart + match.index + token.start;
            const target = { name: token.text, type: ['wire', 'tri'].includes(kind) ? 'net' : 'register',
                startPosition: { line: (match[0].slice(0, token.start).match(/\n/g) ?? []).length } };
            const line = point(source, offset).row;
            symbols.push({ name: token.text, type: target.type, offset, line, endLine: line,
                parentScope: module.name, parentType: 'module', outlineDetail: getSignalDescriptions(match[0], [target]).get(target) });
        }
    }
    return symbols;
}

function bodyItem(tree: Parser.Tree, offset: number): Parser.SyntaxNode | undefined {
    let node = tree.rootNode.namedDescendantForIndex(Math.max(0, Math.min(offset, tree.rootNode.endIndex - 1)));
    while (node?.parent && node.parent.type !== 'module_declaration') { node = node.parent; }
    return node?.parent?.type === 'module_declaration' ? node : undefined;
}
const structuralTypes = ['module_header', 'module_ansi_header', 'module_nonansi_header', 'port_declaration',
    'parameter_declaration', 'local_parameter_declaration', 'always_construct', 'initial_construct',
    'function_declaration', 'task_declaration', 'generate_region', 'loop_generate_construct', 'conditional_generate_construct'];
function structural(node: Parser.SyntaxNode): boolean {
    return structuralTypes.includes(node.type) || node.descendantsOfType(structuralTypes).length > 0;
}

/** Restrict common body edits to their enclosing items; complex/header edits use full extraction. */
function localUpdate(previous: State, tree: Parser.Tree, source: string, prefix: number, oldEnd: number, newEnd: number):
    { modules: VerilogModule[]; symbols: BufferSymbol[]; delta: BufferDelta } | undefined {
    if (tree.rootNode.hasError() || previous.tree.rootNode.hasError()) { return undefined; }
    const module = previous.modules.find(model => model.bodyStart <= prefix && oldEnd < model.end);
    if (!module || module.ports.some(port => !port.declaration)) { return undefined; }
    const before = [bodyItem(previous.tree, prefix), bodyItem(previous.tree, oldEnd)].filter(Boolean);
    const after = [bodyItem(tree, prefix), bodyItem(tree, newEnd)].filter(Boolean);
    if (!before.length || !after.length || [...before, ...after].some(structural)) { return undefined; }
    const start = Math.min(prefix, ...before.map(node => node.startIndex), ...after.map(node => node.startIndex));
    const end = Math.max(oldEnd, ...before.map(node => node.endIndex));
    const delta = newEnd - oldEnd;
    const oldEndPoint = point(previous.source, oldEnd); const newEndPoint = point(source, newEnd);
    const lineDelta = newEndPoint.row - oldEndPoint.row;
    const shift = (offset: number) => offset >= oldEnd ? offset + delta : offset;
    const updatedModels = previous.modules.map(model => ({ ...model, start: shift(model.start), end: shift(model.end),
        bodyStart: shift(model.bodyStart), line: model.start >= oldEnd ? model.line + lineDelta : model.line,
        proceduralRanges: model.proceduralRanges.map(range => ({ start: shift(range.start), end: shift(range.end) })) }));
    const remaining = previous.symbols.filter(symbol => symbol.type === 'module' || symbol.offset < start || symbol.offset >= end)
        .map(symbol => {
            const model = updatedModels.find(candidate => symbol.type === 'module' && candidate.name === symbol.name);
            return model ? { ...symbol, offset: model.start, line: model.line, endLine: point(source, model.end).row } :
                symbol.offset >= oldEnd ? { ...symbol, offset: symbol.offset + delta, line: symbol.line + lineDelta, endLine: symbol.endLine + lineDelta } : symbol;
        });
    const first = tree.rootNode.namedDescendantForIndex(start, Math.max(start, end + delta - 1));
    let ancestor = first;
    while (ancestor.parent && ancestor.type !== 'module_declaration') { ancestor = ancestor.parent; }
    if (ancestor.type !== 'module_declaration') { return undefined; }
    const seen = new Set<number>();
    const added: BufferSymbol[] = [];
    // Navigate siblings rather than materializing every child of a large module.
    let item = bodyItem(tree, start);
    if (!item) { return undefined; }
    while (item && item.startIndex <= end + delta) {
        if (item.parent?.id !== ancestor.id) { return undefined; }
        if (structural(item)) { return undefined; }
        for (const symbol of collect(item, module.name)) {
            if (!seen.has(symbol.offset)) {
                const record = { ...symbol, line: symbol.line + item.startPosition.row, endLine: symbol.endLine + item.startPosition.row };
                remaining.push(record); added.push(record);
                seen.add(symbol.offset);
            }
        }
        item = item.nextNamedSibling;
    }
    // Ignore symbols beyond the replaced interval if the final sibling was only a boundary probe.
    const unique = new Map(remaining.map(symbol => [`${symbol.offset}:${symbol.type}:${symbol.name}`, symbol]));
    return { modules: updatedModels, symbols: [...unique.values()],
        delta: { start, end, oldEnd, offsetDelta: delta, lineDelta, added,
            moduleSymbols: remaining.filter(symbol => symbol.type === 'module') } };
}

// One queue avoids sharing a WASM parser across overlapping initialization/extraction requests.
let queue = Promise.resolve();
parentPort.on('message', message => {
    let builtTree: Parser.Tree | undefined;
    let oldTree: Parser.Tree | undefined;
    queue = queue.then(async () => {
        await ready;
        if (message.close) { states.get(message.filePath)?.tree.delete(); states.delete(message.filePath); return; }
        const start = performance.now();
        const previous = states.get(message.filePath);
        const source: string = message.source;
        let prefix = 0; let oldEnd = 0; let newEnd = 0;
        if (previous) {
            while (prefix < previous.source.length && prefix < source.length && previous.source[prefix] === source[prefix]) { prefix++; }
            oldEnd = previous.source.length; newEnd = source.length;
            while (oldEnd > prefix && newEnd > prefix && previous.source[oldEnd - 1] === source[newEnd - 1]) { oldEnd--; newEnd--; }
            oldTree = previous.tree.copy();
            previous.tree.edit({ startIndex: prefix, oldEndIndex: oldEnd, newEndIndex: newEnd,
                startPosition: point(previous.source, prefix), oldEndPosition: point(previous.source, oldEnd), newEndPosition: point(source, newEnd) });
        }
        // Bound parser input chunks, and return exact slices for node.text lookups.
        // The default string callback repeatedly creates suffixes of the whole file.
        const tree = parser.parse((index: number, _point: Parser.Point, end?: number) =>
            source.slice(index, end ?? index + 4096), previous?.tree);
        builtTree = tree;
        const parsed = performance.now();
        const local = previous && localUpdate({ ...previous, tree: oldTree }, tree, source, prefix, oldEnd, newEnd);
        oldTree?.delete();
        oldTree = undefined;
        if (local) {
            previous.tree.delete();
            states.set(message.filePath, { source, tree, modules: local.modules, symbols: local.symbols });
            builtTree = undefined;
            parentPort.postMessage({ id: message.id, version: message.version, modules: local.modules, delta: local.delta,
                timing: { parseMs: parsed - start, totalMs: performance.now() - start, retainedFiles: states.size, local: true }, memory: process.memoryUsage() });
            return;
        }
        const moduleModels = await models.extract(tree, source, message.filePath);
        const modeled = performance.now();
        const symbols: BufferSymbol[] = [];
        for (const module of moduleModels) {
            symbols.push({ name: module.name, type: 'module', line: module.line,
                offset: module.start,
                endLine: point(source, module.end).row, parentScope: '', parentType: '' });
            for (const port of module.ports) {
                const target = { name: port.name, type: 'port', startPosition: { line: 0 } };
                const declaration = port.declaration.replace(/\s+/g, ' ');
                const text = source.slice(module.start, module.end);
                const escaped = port.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const match = new RegExp('(?<![\\w$])' + escaped + '(?![\\w$])').exec(text);
                const line = match ? point(source, module.start + match.index).row : module.line;
                symbols.push({ name: port.name, type: 'port', line, endLine: line,
                    offset: match ? module.start + match.index : module.start,
                    parentScope: module.name, parentType: 'module',
                    outlineDetail: getSignalDescriptions(`${declaration} ${port.name};`, [target]).get(target) });
            }
            for (const parameter of module.parameters) {
                const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const match = new RegExp('(?<![\\w$])' + escaped + '(?![\\w$])').exec(source.slice(module.start, module.end));
                const offset = match ? module.start + match.index : module.start;
                const line = point(source, offset).row;
                symbols.push({ name: parameter.name, type: 'constant', offset, line, endLine: line, parentScope: module.name, parentType: 'module' });
            }
            const node = tree.rootNode.namedChildren.find(child => child.type === 'module_declaration' && child.startIndex === module.start);
            if (node) {
                const records = collect(node, module.name);
                const known = new Set(symbols.map(symbol => `${symbol.offset}:${symbol.type}`));
                for (const record of records) {
                    if (known.has(`${record.offset}:${record.type}`)) { continue; }
                    symbols.push({ ...record, line: record.line + node.startPosition.row, endLine: record.endLine + node.startPosition.row });
                }
                if (node.hasError()) {
                    const knownSignals = new Set(symbols.map(symbol => `${symbol.offset}:${symbol.type}`));
                    symbols.push(...recoveredSignals(source, module).filter(symbol => !knownSignals.has(`${symbol.offset}:${symbol.type}`)));
                }
            } else { symbols.push(...recoveredSignals(source, module)); }
        }
        states.set(message.filePath, { source, tree, modules: moduleModels, symbols });
        builtTree = undefined;
        previous?.tree.delete();
        parentPort.postMessage({ id: message.id, version: message.version, modules: moduleModels, symbols,
            timing: { parseMs: parsed - start, modelMs: modeled - parsed, symbolMs: performance.now() - modeled, totalMs: performance.now() - start, retainedFiles: states.size },
            memory: process.memoryUsage() });
    }).catch(error => {
        oldTree?.delete(); builtTree?.delete();
        states.get(message.filePath)?.tree.delete(); states.delete(message.filePath);
        parentPort.postMessage({ id: message.id, error: String(error.stack ?? error) });
    });
});
