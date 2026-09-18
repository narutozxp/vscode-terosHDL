import { parentPort } from 'worker_threads';
import { performance } from 'perf_hooks';
import * as Parser from 'web-tree-sitter';
import { getVerilogWasmPath } from '../../../../colibri/parser/utils';
import { ModuleSymbolPositions, VerilogModule, VerilogProjectParser, verilogTokens } from '../../../../colibri/parser/ts_verilog/project_model';
import { CompletionScope, getCompletionScopes } from '../ctags/providers/completionScopes';
import { getSignalDescriptions } from '../ctags/providers/signalDescriptions';
import { BufferText, BufferEdit } from './bufferText';
import { SYSTEMVERILOG_KEYWORDS } from '../ctags/providers/keywords';

export interface BufferSymbol {
    name: string; type: string; line: number; endLine: number;
    parentScope: string; parentType: string; outlineDetail?: string; typeRef?: string;
    offset: number;
    column?: number; endColumn?: number;
}
export interface BufferDelta {
    start: number; end: number; oldEnd: number; offsetDelta: number; lineDelta: number;
    added: BufferSymbol[]; moduleSymbols: BufferSymbol[];
    symbolsUnchanged?: boolean;
    scopeRename?: { start: number; end: number; name: string };
    oldEndPoint?: Parser.Point; newEndPoint?: Parser.Point;
}
const skip = new Set(['continuous_assign', 'blocking_assignment', 'nonblocking_assignment',
    'packed_dimension', 'unpacked_dimension', 'constant_expression', 'expression', 'primary', 'constant_primary']);
const kinds: Record<string, string> = { variable_decl_assignment: 'register', net_decl_assignment: 'net',
    param_assignment: 'constant', type_assignment: 'constant', name_of_instance: 'instance' };
const reserved = new Set(SYSTEMVERILOG_KEYWORDS);
interface State { text: BufferText; version: number; tree: Parser.Tree; modules: VerilogModule[]; scopes: CompletionScope[]; scopeMode: 'syntax' | 'text' }
const states = new Map<string, State>();
let parser: Parser;
let initialized = false;
const models = new VerilogProjectParser();
const ready = (async () => {
    await Parser.init(); parser = new Parser(); parser.setLanguage(await Parser.Language.load(getVerilogWasmPath()));
    initialized = true;
})();
/** Iterative DFS avoids JavaScript stack/argument limits in generated HDL. */
function collect(root: Parser.SyntaxNode, scope: string): BufferSymbol[] {
    const result: BufferSymbol[] = [];
    type Work = { node: Parser.SyntaxNode; declaration?: Parser.SyntaxNode; siblings?: boolean; describeFrom?: number };
    const work: Work[] = [{ node: root }];
    while (work.length) {
        const item = work.pop();
        const node = item.node;
        if (item.describeFrom !== undefined) {
            const signals = result.slice(item.describeFrom).filter(symbol => ['register', 'net'].includes(symbol.type));
            const targets = signals.map(symbol => ({ name: symbol.name, type: symbol.type,
                startPosition: { line: symbol.line - node.startPosition.row } }));
            const descriptions = getSignalDescriptions(node.text, targets);
            for (let index = 0; index < targets.length; index++) {
                signals[index].outlineDetail ??= descriptions.get(targets[index]);
            }
            continue;
        }
        const sibling = item.siblings && node.nextNamedSibling;
        if (sibling) {
            work.push({ node: sibling, declaration: item.declaration, siblings: true });
        }
        const type = node.type;
        if (skip.has(type) || type === 'ERROR' ||
            ['module_header', 'module_ansi_header', 'module_nonansi_header', 'port_declaration'].includes(type)) { continue; }
        let declaration = item.declaration;
        if (['data_declaration', 'net_declaration'].includes(type)) {
            if (node.hasError()) { continue; }
            declaration = node;
            work.push({ node, describeFrom: result.length });
        }
        const kind = kinds[type];
        if (kind) {
            const identifier = node.namedChild(0);
            if (!identifier || !/identifier$/.test(identifier.type) && identifier.type !== 'name_of_instance' || reserved.has(identifier.text)) { continue; }
            const symbol: BufferSymbol = { name: identifier.text, type: kind, offset: identifier.startIndex,
                line: identifier.startPosition.row, endLine: identifier.endPosition.row,
                column: identifier.startPosition.column, endColumn: identifier.endPosition.column, parentScope: scope, parentType: 'module' };
            if (kind === 'instance') {
                let parent = node.parent;
                while (parent && !/instantiation$/.test(parent.type)) { parent = parent.parent; }
                if (!parent || parent.hasError()) { continue; }
                symbol.typeRef = parent.namedChild(0)?.text;
            } else if ((kind === 'register' || kind === 'net') && !declaration) { continue; }
            result.push(symbol);
        } else {
            const child = node.firstNamedChild;
            if (child) { work.push({ node: child, declaration, siblings: true }); }
        }
    }
    return result;
}

function recoveredSignals(source: string, module: VerilogModule, text: BufferText): BufferSymbol[] {
    const body = source.slice(module.bodyStart, module.end);
    const masked = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"/g, text => text.replace(/[^\n]/g, ' '));
    const declarations = /(?:^|[;\n])\s*(?:reg|wire|logic|bit|tri|int|integer|byte|shortint|longint|time)\b[^;]*;/g;
    const symbols: BufferSymbol[] = [];
    let match: RegExpExecArray | null;
    while ((match = declarations.exec(masked))) {
        const tokens = verilogTokens(match[0]);
        const kindIndex = tokens[0]?.text === ';' ? 1 : 0;
        const kind = tokens[kindIndex]?.text;
        const statementLine = text.point(module.bodyStart + match.index).row;
        const records: BufferSymbol[] = [];
        const targets: { name: string; type: string; startPosition: { line: number } }[] = [];
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
            const point = text.point(offset);
            const line = point.row;
            const target = { name: token.text, type: ['wire', 'tri'].includes(kind) ? 'net' : 'register',
                startPosition: { line: line - statementLine } };
            targets.push(target);
            records.push({ name: token.text, type: target.type, offset, line, endLine: line, column: point.column, endColumn: point.column + token.text.length,
                parentScope: module.name, parentType: 'module' });
        }
        const descriptions = getSignalDescriptions(match[0], targets);
        for (let index = 0; index < records.length; index++) {
            records[index].outlineDetail = descriptions.get(targets[index]); symbols.push(records[index]);
        }
    }
    return symbols;
}

function bodyItem(tree: Parser.Tree, offset: number): Parser.SyntaxNode | undefined {
    let node = tree.rootNode.namedDescendantForIndex(Math.max(0, Math.min(offset, tree.rootNode.endIndex - 1)));
    if (node.type === 'module_declaration') {
        // Trivia has no named descendant. Locate the nearest body item without allocating
        // the entire child list; a formatter can otherwise force full module extraction.
        let low = 0; let high = node.namedChildCount;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (node.namedChild(middle).endIndex <= offset) { low = middle + 1; } else { high = middle; }
        }
        const before = low > 0 ? node.namedChild(low - 1) : undefined;
        const after = low < node.namedChildCount ? node.namedChild(low) : undefined;
        return before && (!after || offset - before.endIndex <= after.startIndex - offset) ? before : after;
    }
    while (node?.parent && node.parent.type !== 'module_declaration') { node = node.parent; }
    return node?.parent?.type === 'module_declaration' ? node : undefined;
}
const structuralTypes = ['module_header', 'module_ansi_header', 'module_nonansi_header', 'port_declaration',
    'parameter_declaration', 'module_declaration', 'interface_declaration', 'package_declaration', 'program_declaration'];
const proceduralTypes = ['always_construct', 'initial_construct', 'function_declaration', 'task_declaration'];
const unitTypes = ['module_declaration', 'interface_declaration', 'package_declaration', 'program_declaration'];
function structural(node: Parser.SyntaxNode): boolean {
    return structuralTypes.includes(node.type) || node.descendantsOfType(structuralTypes).length > 0;
}

function shiftModels(modules: VerilogModule[], oldEnd: number, offsetDelta: number, lineDelta: number): VerilogModule[] {
    if (!offsetDelta && !lineDelta) { return [...modules]; }
    const shift = (offset: number) => offset >= oldEnd ? offset + offsetDelta : offset;
    return modules.map(model => model.end < oldEnd ? model : ({ ...model, start: shift(model.start), end: shift(model.end),
        bodyStart: shift(model.bodyStart), line: model.start >= oldEnd ? model.line + lineDelta : model.line,
        proceduralRanges: model.proceduralRanges.map(range => range.end < oldEnd ? range : ({ start: shift(range.start), end: shift(range.end) })) }));
}

function extractScopes(tree: Parser.Tree, text: BufferText, modules: VerilogModule[], nodes: Map<number, Parser.SyntaxNode>, knownFlatModules = false):
    { scopes: CompletionScope[]; scopeMode: 'syntax' | 'text' } {
    const root = tree.rootNode;
    if (!root.hasError() && modules.length === nodes.size &&
        root.namedChildren.every(node => node.type === 'module_declaration' || node.type === 'comment') &&
        (knownFlatModules || root.descendantsOfType(unitTypes).length === modules.length)) {
        const scopes: CompletionScope[] = [];
        for (const module of modules) {
            const node = nodes.get(module.start);
            let header = node.firstNamedChild;
            while (header && header.type !== 'module_header') { header = header.nextNamedSibling; }
            let keyword = header?.firstNamedChild;
            while (keyword && keyword.type !== 'module_keyword') { keyword = keyword.nextNamedSibling; }
            let end = node.lastChild;
            while (end && end.type !== 'endmodule') { end = end.previousSibling; }
            if (!keyword || !end) { break; }
            scopes.push({ name: module.name, type: 'module', start: keyword.startIndex, end: end.endIndex,
                startLine: keyword.startPosition.row, endLine: end.endPosition.row });
        }
        if (scopes.length === modules.length) { return { scopes, scopeMode: 'syntax' }; }
    }
    // Preserve lexical recovery and interface/package behavior for more complex source layouts.
    return { scopes: getCompletionScopes(text.toString()), scopeMode: 'text' };
}

function moduleRecords(module: VerilogModule, node: Parser.SyntaxNode | undefined, text: BufferText, recover = true,
    positions = models.symbolPositions(module)): BufferSymbol[] {
    const symbols: BufferSymbol[] = [];
    symbols.push(moduleSymbol(module, text));
    for (const port of module.ports) {
        const target = { name: port.name, type: 'port', startPosition: { line: 0 } };
        const declaration = port.declaration.replace(/\s+/g, ' ');
        const location = positions?.ports.get(port.name);
        const line = location?.line ?? module.line;
        symbols.push({ name: port.name, type: 'port', line, endLine: line,
            offset: location?.offset ?? module.start,
            column: location?.column, endColumn: location?.endColumn,
            parentScope: module.name, parentType: 'module',
            outlineDetail: getSignalDescriptions(`${declaration} ${port.name};`, [target]).get(target) });
    }
    for (const parameter of module.parameters) {
        const location = positions?.parameters.get(parameter.name);
        const offset = location?.offset ?? module.start;
        const line = location?.line ?? module.line;
        symbols.push({ name: parameter.name, type: 'constant', offset, line, endLine: line,
            column: location?.column, endColumn: location?.endColumn, parentScope: module.name, parentType: 'module' });
    }
    if (node) {
        const records = collect(node, module.name);
        const known = new Set(symbols.map(symbol => `${symbol.offset}:${symbol.type}`));
        for (const record of records) {
            if (known.has(`${record.offset}:${record.type}`)) { continue; }
            symbols.push(record);
        }
        if (node.hasError()) {
            const knownSignals = new Set(symbols.map(symbol => `${symbol.offset}:${symbol.type}`));
            for (const symbol of recoveredSignals(text.toString(), module, text)) {
                if (!knownSignals.has(`${symbol.offset}:${symbol.type}`)) { symbols.push(symbol); }
            }
        }
    } else if (recover) { for (const symbol of recoveredSignals(text.toString(), module, text)) { symbols.push(symbol); } }
    return symbols;
}

function moduleSymbol(module: VerilogModule, text: BufferText): BufferSymbol {
    const start = text.point(module.start); const end = text.point(module.end);
    return { name: module.name, type: 'module', offset: module.start, line: start.row, endLine: end.row,
        column: start.column, endColumn: end.column, parentScope: '', parentType: '' };
}

/** Both trees prove the edited interval stays inside the same symbol-free assignment. */
function expressionUpdate(previous: State, tree: Parser.Tree, text: BufferText, prefix: number, oldEnd: number, newEnd: number):
    { modules: VerilogModule[]; delta: BufferDelta } | undefined {
    const assignments = ['continuous_assign', 'blocking_assignment', 'nonblocking_assignment'];
    const enclosing = (view: Parser.Tree, end: number) => {
        let node = view.rootNode.namedDescendantForIndex(prefix, Math.max(prefix, end - 1));
        while (node?.parent && !assignments.includes(node.type)) { node = node.parent; }
        return node && assignments.includes(node.type) ? node : undefined;
    };
    const before = enclosing(previous.tree, oldEnd); const after = enclosing(tree, newEnd);
    const offsetDelta = newEnd - oldEnd;
    if (!before || !after || before.type !== after.type || before.startIndex !== after.startIndex ||
        before.endIndex + offsetDelta !== after.endIndex || oldEnd > before.endIndex || newEnd > after.endIndex) { return undefined; }
    const owner = (node: Parser.SyntaxNode) => {
        while (node.parent && node.type !== 'module_declaration') { node = node.parent; }
        return node.type === 'module_declaration' ? node : undefined;
    };
    const oldOwner = owner(before); const newOwner = owner(after);
    const module = oldOwner && previous.modules.find(model => model.start === oldOwner.startIndex);
    if (!module || !newOwner || oldOwner.hasError() || newOwner.hasError() || oldOwner.startIndex !== newOwner.startIndex ||
        oldOwner.endIndex + offsetDelta !== newOwner.endIndex || prefix < module.bodyStart) { return undefined; }
    const oldPoint = previous.text.point(oldEnd); const newPoint = text.point(newEnd);
    const lineDelta = newPoint.row - oldPoint.row;
    const modules = shiftModels(previous.modules, oldEnd, offsetDelta, lineDelta);
    return { modules, delta: { start: before.startIndex, end: before.endIndex, oldEnd, offsetDelta, lineDelta, added: [],
        moduleSymbols: modules.map(model => moduleSymbol(model, text)),
        symbolsUnchanged: !offsetDelta && !lineDelta && oldPoint.column === newPoint.column } };
}

/** Re-extract affected body items and their procedural ranges; header/context edits fall back. */
function localUpdate(previous: State, tree: Parser.Tree, text: BufferText, prefix: number, oldEnd: number, newEnd: number):
    { modules: VerilogModule[]; delta: BufferDelta } | undefined {
    const module = previous.modules.find(model => model.bodyStart <= prefix && oldEnd < model.end);
    if (!module || module.ports.some(port => !port.declaration)) { return undefined; }
    const before = [bodyItem(previous.tree, prefix), bodyItem(previous.tree, Math.max(prefix, oldEnd - 1))].filter(Boolean);
    const after = [bodyItem(tree, prefix), bodyItem(tree, Math.max(prefix, newEnd - 1))].filter(Boolean);
    if ([...before, ...after].some(node => node.parent.hasError())) { return undefined; }
    if (!before.length || !after.length || [...before, ...after].some(structural)) { return undefined; }
    const start = Math.min(prefix, ...before.map(node => node.startIndex), ...after.map(node => node.startIndex));
    const delta = newEnd - oldEnd;
    const end = Math.max(oldEnd, ...before.map(node => node.endIndex), ...after.map(node => node.endIndex - delta));
    const oldEndPoint = previous.text.point(oldEnd); const newEndPoint = text.point(newEnd);
    const lineDelta = newEndPoint.row - oldEndPoint.row;
    const shift = (offset: number) => offset >= oldEnd ? offset + delta : offset;
    const updatedModels = shiftModels(previous.modules, oldEnd, delta, lineDelta);
    const moduleSymbols = updatedModels.map(model => moduleSymbol(model, text));
    const first = tree.rootNode.namedDescendantForIndex(start, Math.max(start, end + delta - 1));
    let ancestor = first;
    while (ancestor.parent && ancestor.type !== 'module_declaration') { ancestor = ancestor.parent; }
    if (ancestor.type !== 'module_declaration') { return undefined; }
    const seen = new Set<number>();
    const added: BufferSymbol[] = [];
    const proceduralRanges: { start: number; end: number }[] = [];
    // Navigate siblings rather than materializing every child of a large module.
    let item = bodyItem(tree, start);
    if (!item) { return undefined; }
    while (item && item.startIndex < end + delta) {
        if (item.parent?.id !== ancestor.id) { return undefined; }
        if (structural(item)) { return undefined; }
        for (const node of item.descendantsOfType(proceduralTypes)) {
            proceduralRanges.push({ start: node.startIndex, end: node.endIndex });
        }
        if (proceduralTypes.includes(item.type)) { proceduralRanges.push({ start: item.startIndex, end: item.endIndex }); }
        for (const symbol of collect(item, module.name)) {
            if (!seen.has(symbol.offset)) {
                added.push(symbol);
                seen.add(symbol.offset);
            }
        }
        item = item.nextNamedSibling;
    }
    const updatedIndex = updatedModels.findIndex(model => model.start === shift(module.start));
    const updated = updatedModels[updatedIndex];
    const ranges = [
        ...module.proceduralRanges.filter(range => range.end <= start || range.start >= end)
            .map(range => ({ start: shift(range.start), end: shift(range.end) })),
        ...proceduralRanges
    ].sort((a, b) => a.start - b.start);
    if (ranges.length !== updated.proceduralRanges.length || ranges.some((range, index) =>
        range.start !== updated.proceduralRanges[index].start || range.end !== updated.proceduralRanges[index].end)) {
        updatedModels[updatedIndex] = { ...updated, proceduralRanges: ranges };
    }
    // A same-length expression edit often changes no declarations or positions at all.
    // Verify the old interval before allowing consumers to keep their symbol views.
    let symbolsUnchanged = !delta && !lineDelta && oldEndPoint.column === newEndPoint.column && !added.length;
    if (symbolsUnchanged) {
        let oldItem = bodyItem(previous.tree, start);
        if (!oldItem) { symbolsUnchanged = false; }
        while (oldItem && oldItem.startIndex < end) {
            if (kinds[oldItem.type] || oldItem.descendantsOfType(Object.keys(kinds)).length) {
                symbolsUnchanged = false; break;
            }
            oldItem = oldItem.nextNamedSibling;
        }
    }
    return { modules: updatedModels,
        delta: { start, end, oldEnd, offsetDelta: delta, lineDelta, added, moduleSymbols, symbolsUnchanged } };
}

/** Whitespace/comments between complete modules cannot change their declaration models. */
function triviaUpdate(previous: State, tree: Parser.Tree, text: BufferText, prefix: number, oldEnd: number, newEnd: number):
    { modules: VerilogModule[]; delta: BufferDelta; extraction: 'trivia' } | undefined {
    const clean = (root: Parser.SyntaxNode) => !root.hasError() &&
        root.namedChildren.every(node => node.type === 'module_declaration' || node.type === 'comment');
    if (!clean(tree.rootNode) || !clean(previous.tree.rootNode) ||
        previous.modules.some(model => prefix < model.end && oldEnd > model.start || prefix >= model.start && prefix < model.end)) {
        return undefined;
    }
    const offsetDelta = newEnd - oldEnd;
    const lineDelta = text.point(newEnd).row - previous.text.point(oldEnd).row;
    const modules = shiftModels(previous.modules, oldEnd, offsetDelta, lineDelta);
    const nodes = new Map(tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration').map(node => [node.startIndex, node]));
    if (nodes.size !== modules.length || modules.some(model => {
        const node = nodes.get(model.start);
        return !node || node.endIndex !== model.end || prefix < model.end && newEnd > model.start;
    })) { return undefined; }
    const moduleSymbols = modules.map(model => moduleSymbol(model, text));
    return { modules, extraction: 'trivia', delta: { start: prefix, end: oldEnd, oldEnd, offsetDelta, lineDelta,
        added: [], moduleSymbols, symbolsUnchanged: !offsetDelta && !lineDelta } };
}

/** Structural edits invalidate a header or one module before invalidating the file. */
async function contextUpdate(previous: State, tree: Parser.Tree, text: BufferText, filePath: string,
    prefix: number, oldEnd: number, newEnd: number, edits?: BufferEdit[]): Promise<
        { modules: VerilogModule[]; delta: BufferDelta; extraction: 'header' | 'module'; flatModules?: boolean } | undefined> {
    const affected = previous.modules.filter(model => model.end > prefix && model.start <= oldEnd);
    if (!affected.length) { return undefined; }
    const module = affected[0];
    const offsetDelta = newEnd - oldEnd;
    const lineDelta = text.point(newEnd).row - previous.text.point(oldEnd).row;
    const shift = (offset: number) => offset >= oldEnd ? offset + offsetDelta : offset;
    // Multi-event edits are in successive buffer coordinates. Map old unit boundaries
    // through every edit; a single net shift loses intermediate modules' positions.
    const mapped = new Map<number, number>();
    const mapOffset = (offset: number) => {
        if (!edits) { return shift(offset); }
        if (!mapped.has(offset)) {
            let position = offset;
            for (const edit of edits) {
                if (position >= edit.oldEndIndex) { position += edit.text.length - (edit.oldEndIndex - edit.startIndex); }
                else if (position >= edit.startIndex) { position = edit.startIndex; }
            }
            mapped.set(offset, position);
        }
        return mapped.get(offset);
    };
    const nodes = tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration');
    const oldNodes = previous.tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration');
    const nodeByStart = new Map(nodes.map(node => [node.startIndex, node]));
    // Boundary changes, newly created units and recovery models need the file-wide path.
    if (nodes.length !== previous.modules.length || oldNodes.length !== nodes.length ||
        previous.modules.some(model => nodeByStart.get(mapOffset(model.start))?.endIndex !== mapOffset(model.end))) {
        return undefined;
    }
    if (affected.length > 1) {
        const oldByStart = new Map(oldNodes.map(node => [node.startIndex, node]));
        const affectedNodes = affected.map(model => nodeByStart.get(mapOffset(model.start)));
        if (affected.some((model, index) => !oldByStart.get(model.start) || oldByStart.get(model.start).hasError() ||
            !affectedNodes[index] || affectedNodes[index].hasError())) { return undefined; }
        const replacements = await models.extract(tree, text.toString(), filePath, false, affectedNodes);
        if (replacements.length !== affected.length) { return undefined; }
        const byStart = new Map(replacements.map(model => [model.start, model]));
        const shifted = shiftModels(previous.modules, oldEnd, offsetDelta, lineDelta);
        const modules = previous.modules.map((model, index) => byStart.get(mapOffset(model.start)) ?? shifted[index]);
        const added = replacements.flatMap((model, index) => moduleRecords(model, affectedNodes[index], text))
            .filter(symbol => symbol.type !== 'module');
        const moduleSymbols = modules.map(model => moduleSymbol(model, text));
        return { modules, extraction: 'module', flatModules: affectedNodes.every(node => node.descendantsOfType(unitTypes).length === 1), delta: { start: module.start, end: affected[affected.length - 1].end,
            oldEnd, offsetDelta, lineDelta, added, moduleSymbols } };
    }
    if (module.start > prefix || oldEnd >= module.end) { return undefined; }
    const node = nodes.find(node => node.startIndex === shift(module.start));
    const oldNode = oldNodes.find(node => node.startIndex === module.start);
    if (!node || !oldNode || node.hasError() || oldNode.hasError()) { return undefined; }
    const shifted = shiftModels(previous.modules, oldEnd, offsetDelta, lineDelta);
    let updated: VerilogModule;
    let added: BufferSymbol[];
    let end = module.end;
    let extraction: 'header' | 'module' = 'module';
    let bodyStart = node.endIndex;
    let nonAnsi = false;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        nonAnsi ||= child.type === 'module_nonansi_header';
        if (child.type === ';') { bodyStart = child.endIndex; break; }
    }
    let oldNonAnsi = false;
    for (let child = oldNode.firstChild; child; child = child.nextSibling) {
        oldNonAnsi ||= child.type === 'module_nonansi_header';
        if (child.type === ';') { break; }
    }
    if (prefix < module.bodyStart && oldEnd <= module.bodyStart && newEnd <= bodyStart &&
        bodyStart === shift(module.bodyStart) && !nonAnsi && !oldNonAnsi) {
        // Parse only the small, self-contained ANSI header. The untouched body is reused.
        const readHeader = async (view: BufferText, start: number, end: number) => {
            const source = view.slice(start, end) + '\nendmodule';
            const headerTree = parser.parse(source);
            try {
                if (headerTree.rootNode.hasError()) { return undefined; }
                return (await models.extract(headerTree, source, filePath, false))[0];
            } finally { headerTree.delete(); }
        };
        const oldHeader = await readHeader(previous.text, module.start, module.bodyStart);
        const header = await readHeader(text, node.startIndex, bodyStart);
        if (oldHeader && header) {
            const oldNames = new Set(oldHeader.parameters.map(parameter => parameter.name));
            const newNames = new Set(header.parameters.map(parameter => parameter.name));
            // Parameter identity changes can expose a previously shadowed body parameter.
            if (oldNames.size === newNames.size && [...oldNames].every(name => newNames.has(name))) {
                const bodyParameters = module.parameters.filter(parameter => !oldNames.has(parameter.name));
                updated = { ...shifted.find(model => model.start === node.startIndex), name: header.name,
                    line: header.line + node.startPosition.row, ports: header.ports,
                    parameters: [...header.parameters, ...bodyParameters] };
                const headerModel = { ...updated, end: bodyStart, parameters: header.parameters, proceduralRanges: [] };
                const headerPositions = models.symbolPositions(header);
                const relocate = (records: ModuleSymbolPositions['ports']) => new Map([...records].map(([name, record]) =>
                    [name, { offset: record.offset + node.startIndex, line: record.line + node.startPosition.row,
                        column: record.column + (record.line === 0 ? node.startPosition.column : 0),
                        endColumn: record.endColumn + (record.line === 0 ? node.startPosition.column : 0) }]));
                added = moduleRecords(headerModel, undefined, text, false, {
                    ports: relocate(headerPositions.ports), parameters: relocate(headerPositions.parameters)
                }).filter(symbol => symbol.type !== 'module');
                end = module.bodyStart;
                extraction = 'header';
            }
        }
    }
    if (!updated) {
        const source = text.toString();
        updated = (await models.extract(tree, source, filePath, false, [node]))[0];
        if (!updated) { return undefined; }
        added = moduleRecords(updated, node, text).filter(symbol => symbol.type !== 'module');
    }
    const modules = shifted.map(model => model.start === node.startIndex ? updated : model);
    const moduleSymbols = modules.map(model => moduleSymbol(model, text));
    return { modules, extraction, flatModules: extraction === 'header' || node.descendantsOfType(unitTypes).length === 1,
        delta: { start: module.start, end, oldEnd, offsetDelta, lineDelta, added, moduleSymbols,
        scopeRename: extraction === 'header' && updated.name !== module.name ? { start: module.bodyStart, end: module.end, name: updated.name } : undefined } };
}

// One queue avoids sharing a WASM parser across overlapping initialization/extraction requests.
let queue = Promise.resolve();
const closedUpTo = new Map<string, number>();
parentPort.on('message', message => {
    if (message.close && typeof message.beforeId === 'number') { closedUpTo.set(message.filePath, message.beforeId); }
    let builtTree: Parser.Tree | undefined;
    let oldTree: Parser.Tree | undefined;
    queue = queue.then(async () => {
        // Let queued close messages arrive before spending CPU on the next file.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (!message.close && message.id <= (closedUpTo.get(message.filePath) ?? -1)) {
            parentPort.postMessage({ id: message.id, error: 'Document closed' }); return;
        }
        await ready;
        if (!message.close && message.id <= (closedUpTo.get(message.filePath) ?? -1)) {
            parentPort.postMessage({ id: message.id, error: 'Document closed' }); return;
        }
        if (message.close) {
            states.get(message.filePath)?.tree.delete(); states.delete(message.filePath);
            if (closedUpTo.get(message.filePath) === message.beforeId) { closedUpTo.delete(message.filePath); }
            return;
        }
        const start = performance.now();
        const previous = states.get(message.filePath);
        const incremental = Array.isArray(message.edits);
        if (incremental && (!previous || previous.version !== message.baseVersion)) {
            parentPort.postMessage({ id: message.id, resync: true }); return;
        }
        const timing = { inputMode: incremental ? 'edits' : 'full',
            inputChars: incremental ? message.edits.reduce((size: number, edit: BufferEdit) => size + edit.text.length, 0) : message.source.length,
            editCount: incremental ? message.edits.length : 0 };
        const before = !incremental && previous ? previous.text.toString() : undefined;
        if (incremental && !message.edits.length || !incremental && before === message.source) {
            previous.version = message.version;
            parentPort.postMessage({ id: message.id, version: message.version, reused: true,
                timing: { ...timing, parseMs: 0, totalMs: performance.now() - start, retainedFiles: states.size } });
            return;
        }
        let text: BufferText;
        let prefix = 0; let oldEnd = 0; let newEnd = 0;
        if (previous) { oldTree = previous.tree.copy(); }
        if (incremental) {
            text = previous.text;
            prefix = Infinity;
            let offsetDelta = 0;
            for (const edit of message.edits as BufferEdit[]) {
                const start = edit.startIndex; const end = edit.oldEndIndex;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > text.length) {
                    const error = new Error('Buffer edit ranges are out of sync'); error.name = 'BufferResync'; throw error;
                }
                const startPoint = text.point(start); const endPoint = text.point(end);
                if (startPoint.row !== edit.startPosition.row || startPoint.column !== edit.startPosition.column ||
                    endPoint.row !== edit.oldEndPosition.row || endPoint.column !== edit.oldEndPosition.column) {
                    const error = new Error('Buffer edit positions are out of sync'); error.name = 'BufferResync'; throw error;
                }
                const oldStart = start < prefix ? start : start >= newEnd ? start - offsetDelta : prefix;
                const oldFinish = end < prefix ? end : end >= newEnd ? end - offsetDelta : oldEnd;
                prefix = Math.min(prefix, oldStart); oldEnd = Math.max(oldEnd, oldFinish);
                offsetDelta += edit.text.length - (end - start); newEnd = oldEnd + offsetDelta;
                previous.tree.edit({ ...edit, newEndIndex: start + edit.text.length });
                text = text.edit(edit);
            }
        } else {
            const source: string = message.source;
            text = new BufferText(source);
            if (previous) {
                // Recovery path when events were missed or an edit batch exceeded the transport budget.
                while (prefix < before.length && prefix < source.length && before[prefix] === source[prefix]) { prefix++; }
                oldEnd = before.length; newEnd = source.length;
                while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === source[newEnd - 1]) { oldEnd--; newEnd--; }
                previous.tree.edit({ startIndex: prefix, oldEndIndex: oldEnd, newEndIndex: newEnd,
                    startPosition: previous.text.point(prefix), oldEndPosition: previous.text.point(oldEnd), newEndPosition: text.point(newEnd) });
            }
        }
        // Reads are bounded; local extraction never materializes the whole piece table.
        const tree = parser.parse((index: number, _point: Parser.Point, end?: number) =>
            text.slice(index, end ?? index + 4096), previous?.tree);
        builtTree = tree;
        const parsed = performance.now();
        const oldState = previous && { ...previous, tree: oldTree };
        const expression = previous && expressionUpdate(oldState, tree, text, prefix, oldEnd, newEnd);
        const items = expression || previous && localUpdate(oldState, tree, text, prefix, oldEnd, newEnd);
        const local = items ? { ...items, extraction: expression ? 'expression' as const : 'items' as const } : previous &&
            (triviaUpdate(oldState, tree, text, prefix, oldEnd, newEnd) ??
                await contextUpdate(oldState, tree, text, message.filePath, prefix, oldEnd, newEnd, incremental ? message.edits : undefined));
        oldTree?.delete();
        oldTree = undefined;
        if (local) {
            local.delta.oldEndPoint = previous.text.point(oldEnd);
            local.delta.newEndPoint = text.point(newEnd);
            if (local.delta.oldEndPoint.column !== local.delta.newEndPoint.column) { local.delta.symbolsUnchanged = false; }
            previous.tree.delete();
            const shift = (offset: number) => offset >= oldEnd ? offset + newEnd - oldEnd : offset;
            const lineDelta = text.point(newEnd).row - previous.text.point(oldEnd).row;
            const scoped = local.extraction === 'expression' || local.extraction === 'items' || local.extraction === 'trivia' ? { scopeMode: previous.scopeMode,
                scopes: previous.scopes.map(scope => ({ ...scope, start: shift(scope.start), end: shift(scope.end),
                startLine: scope.startLine + (scope.start >= oldEnd ? lineDelta : 0),
                endLine: scope.endLine === Number.MAX_SAFE_INTEGER ? scope.endLine :
                    scope.endLine + (scope.end >= oldEnd ? lineDelta : 0) })) } :
                extractScopes(tree, text, local.modules, new Map(tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration').map(node => [node.startIndex, node])),
                    previous.scopeMode === 'syntax' && 'flatModules' in local && local.flatModules);
            const { scopes, scopeMode } = scoped;
            states.set(message.filePath, { text, version: message.version, tree, modules: local.modules, scopes, scopeMode });
            builtTree = undefined;
            parentPort.postMessage({ id: message.id, version: message.version, modules: local.modules, scopes, delta: local.delta,
                timing: { ...timing, scopeMode, extraction: local.extraction, pieces: text.pieceCount, parseMs: parsed - start, totalMs: performance.now() - start, retainedFiles: states.size, local: true } });
            return;
        }
        const source = text.toString();
        const moduleModels = await models.extract(tree, source, message.filePath);
        const modeled = performance.now();
        const symbols: BufferSymbol[] = [];
        const moduleNodes = new Map(tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration').map(node => [node.startIndex, node]));
        for (const module of moduleModels) {
            for (const symbol of moduleRecords(module, moduleNodes.get(module.start), text)) { symbols.push(symbol); }
        }
        const { scopes, scopeMode } = extractScopes(tree, text, moduleModels, moduleNodes);
        states.set(message.filePath, { text, version: message.version, tree, modules: moduleModels, scopes, scopeMode });
        builtTree = undefined;
        previous?.tree.delete();
        parentPort.postMessage({ id: message.id, version: message.version, modules: moduleModels, scopes, symbols,
            timing: { ...timing, extraction: 'full', scopeMode, pieces: text.pieceCount, parseMs: parsed - start, modelMs: modeled - parsed, symbolMs: performance.now() - modeled, totalMs: performance.now() - start, retainedFiles: states.size } });
    }).catch(error => {
        oldTree?.delete(); builtTree?.delete();
        states.get(message.filePath)?.tree.delete(); states.delete(message.filePath);
        parentPort.postMessage(error.name === 'BufferResync' ? { id: message.id, resync: true } :
            { id: message.id, fatal: !initialized, error: String(error.stack ?? error) });
    });
});
