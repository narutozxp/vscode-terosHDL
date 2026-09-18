import * as Parser from 'web-tree-sitter';
import { getVerilogWasmPath } from '../utils';

export interface VerilogPort {
    name: string;
    declaration: string;
    direction: string;
}

export interface VerilogParameter {
    name: string;
    defaultValue: string;
}

export interface VerilogModule {
    name: string;
    filePath: string;
    start: number;
    end: number;
    line: number;
    bodyStart: number;
    proceduralRanges: { start: number; end: number }[];
    ports: VerilogPort[];
    parameters: VerilogParameter[];
}

export interface ModuleSymbolPosition { offset: number; line: number; column: number; endColumn: number }
export interface ModuleSymbolPositions {
    ports: Map<string, ModuleSymbolPosition>;
    parameters: Map<string, ModuleSymbolPosition>;
}

export interface VerilogToken {
    text: string;
    start: number;
    end: number;
}

/** Tokens retain buffer offsets; comments and strings never become identifiers. */
export function verilogTokens(source: string): VerilogToken[] {
    const result: VerilogToken[] = [];
    const lexer = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|\s+|\\[^\s]+|[a-zA-Z_$][\w$]*|[0-9]+|[^\s]/g;
    let match: RegExpExecArray | null;
    while ((match = lexer.exec(source)) !== null) {
        if (!/^\s|^\/\/|^\/\*|^"/.test(match[0])) {
            result.push({ text: match[0], start: match.index, end: lexer.lastIndex });
        }
    }
    return result;
}

function descendants(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    return node.type === type ? [node] : node.descendantsOfType(type);
}

/** Extract every module separately; the documenter parser returns a single HDL element. */
export class VerilogProjectParser {
    private parser?: Parser;
    private initializing?: Promise<void>;
    private positions = new WeakMap<VerilogModule, ModuleSymbolPositions>();

    symbolPositions(module: VerilogModule): ModuleSymbolPositions | undefined { return this.positions.get(module); }

    private init(): Promise<void> {
        if (!this.initializing) {
            this.initializing = (async () => {
                await Parser.init();
                const language = await Parser.Language.load(getVerilogWasmPath());
                this.parser = new Parser();
                this.parser.setLanguage(language);
            })().catch(error => { this.initializing = undefined; throw error; });
        }
        return this.initializing;
    }

    async parse(source: string, filePath: string, recover = true): Promise<VerilogModule[]> {
        await this.init();
        const tree = this.parser.parse(source);
        try { return await this.extract(tree, source, filePath, recover); }
        finally { tree.delete(); }
    }

    async extract(tree: Parser.Tree, source: string, filePath: string, recover = true,
        moduleNodes?: Parser.SyntaxNode[]): Promise<VerilogModule[]> {
        try {
            const models: VerilogModule[] = (moduleNodes ?? tree.rootNode.namedChildren.filter(node => node.type === 'module_declaration')).flatMap(node => {
                let header: Parser.SyntaxNode | undefined;
                let ansi: Parser.SyntaxNode | undefined;
                let nonansi: Parser.SyntaxNode | undefined;
                let bodyStart = node.endIndex;
                // Only visit the header prefix; a large module's body need not be materialized here.
                for (let child = node.firstChild; child; child = child.nextSibling) {
                    if (child.type === 'module_header') { header = child; }
                    if (child.type === 'module_ansi_header') { ansi = child; }
                    if (child.type === 'module_nonansi_header') { nonansi = child; }
                    if (child.type === ';') { bodyStart = child.endIndex; break; }
                }
                const identifier = header?.namedChildren.find(child => /identifier$/.test(child.type));
                if (!identifier?.text) { return []; }
                const ports: VerilogPort[] = [];
                const positions: ModuleSymbolPositions = { ports: new Map(), parameters: new Map() };
                const position = (node: Parser.SyntaxNode): ModuleSymbolPosition => ({ offset: node.startIndex, line: node.startPosition.row,
                    column: node.startPosition.column, endColumn: node.endPosition.column });
                let inherited = 'wire';
                let direction = '';
                if (ansi) {
                    for (const declaration of descendants(ansi, 'ansi_port_declaration')) {
                        const port = declaration.namedChildren.find(child => child.type === 'port_identifier');
                        if (!port?.text) { continue; }
                        const prefix = source.slice(declaration.startIndex, port.startIndex).trim();
                        if (prefix) {
                            inherited = prefix;
                            direction = /\b(input|output|inout|ref)\b/.exec(prefix)?.[1] ?? '';
                        }
                        ports.push({ name: port.text, declaration: inherited, direction });
                        if (!positions.ports.has(port.text)) { positions.ports.set(port.text, position(port)); }
                    }
                } else if (nonansi) {
                    const declared = new Map<string, VerilogPort>();
                    for (const declaration of node.namedChildren.filter(child => child.type === 'port_declaration')) {
                        const identifiers = descendants(declaration, 'port_identifier');
                        const first = identifiers[0];
                        if (!first) { continue; }
                        const prefix = source.slice(declaration.startIndex, first.startIndex).trim();
                        const dir = /\b(input|output|inout|ref)\b/.exec(prefix)?.[1] ?? '';
                        for (const port of identifiers) { declared.set(port.text, { name: port.text, declaration: prefix, direction: dir }); }
                    }
                    // Preserve external port names/order, including .external(internal) headers.
                    for (const port of descendants(nonansi, 'port')) {
                        const identifier = descendants(port, 'port_identifier')[0];
                        const name = identifier?.text;
                        if (name) {
                            ports.push(declared.get(name) ?? { name, declaration: '', direction: '' });
                            if (!positions.ports.has(name)) { positions.ports.set(name, position(identifier)); }
                        }
                    }
                }
                const parameters: VerilogParameter[] = [];
                const parameterNames = new Set<string>();
                const collectParameters = (current: Parser.SyntaxNode) => {
                    if (current.type === 'local_parameter_declaration' || current.type === 'function_declaration' ||
                        current.type === 'task_declaration' || current !== node && current.type === 'module_declaration') { return; }
                    if (current.type === 'param_assignment' || current.type === 'type_assignment') {
                        let identifier = current.namedChildren[0];
                        // The bundled grammar puts an inherited parameter name in its parent data_type.
                        if (!identifier?.text && current.parent?.parent?.type === 'parameter_port_declaration') {
                            identifier = current.parent.parent.namedChildren.find(child => child.type === 'data_type');
                        }
                        const name = identifier?.text;
                        if (name && !parameterNames.has(name)) {
                            const equal = current.text.indexOf('=');
                            let defaultValue = '';
                            if (equal >= 0) {
                                const start = current.startIndex + equal + 1;
                                let end = source.length; let depth = 0;
                                // Some grammar nodes truncate system-function expressions to '$'.
                                // Read through the actual balanced expression from the original source.
                                const lexer = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|[()[\]{},;]/g;
                                lexer.lastIndex = start;
                                let match: RegExpExecArray | null;
                                while ((match = lexer.exec(source)) && match.index < node.endIndex) {
                                    const text = match[0];
                                    if (text.length !== 1) { continue; }
                                    if (depth === 0 && [',', ')', ';'].includes(text)) { end = match.index; break; }
                                    if (['(', '[', '{'].includes(text)) { depth++; }
                                    if ([')', ']', '}'].includes(text)) { depth--; }
                                }
                                defaultValue = source.slice(start, end).trim();
                            }
                            parameters.push({ name, defaultValue });
                            parameterNames.add(name);
                            positions.parameters.set(name, position(identifier));
                        }
                        return;
                    }
                    for (const child of current.namedChildren) { collectParameters(child); }
                };
                for (const declaration of node.descendantsOfType(['parameter_port_declaration', 'parameter_declaration'])) {
                    let parent = declaration.parent;
                    let excluded = false;
                    while (parent && parent.id !== node.id) {
                        if (['function_declaration', 'task_declaration', 'local_parameter_declaration', 'module_declaration'].includes(parent.type)) { excluded = true; break; }
                        parent = parent.parent;
                    }
                    if (!excluded) { collectParameters(declaration); }
                }
                const proceduralRanges = node.descendantsOfType(['always_construct', 'initial_construct', 'function_declaration', 'task_declaration'])
                    .map(child => ({ start: child.startIndex, end: child.endIndex }))
                    .sort((a, b) => a.start - b.start);
                const model: VerilogModule = { name: identifier.text, filePath, start: node.startIndex, end: node.endIndex,
                    line: identifier.startPosition.row, bodyStart,
                    proceduralRanges, ports, parameters };
                this.positions.set(model, positions);
                return [model];
            });
            // A half-typed body statement can make the grammar classify an entire module as ERROR.
            // Recover its intact header rather than losing module completion while the user types.
            if (recover && !moduleNodes && tree.rootNode.hasError()) {
                const tokens = verilogTokens(source);
                for (let index = 0; index < tokens.length; index++) {
                    const start = tokens[index];
                    if (!['module', 'macromodule'].includes(start.text)) { continue; }
                    let finish = index + 1;
                    while (finish < tokens.length && tokens[finish].text !== 'endmodule') { finish++; }
                    if (!models.some(model => model.start === start.start)) {
                        let depth = 0; let headerEnd: number | undefined;
                        for (let cursor = index + 1; cursor < finish; cursor++) {
                            const token = tokens[cursor];
                            if (['(', '[', '{'].includes(token.text)) { depth++; }
                            if ([')', ']', '}'].includes(token.text)) { depth--; }
                            if (token.text === ';' && depth === 0) { headerEnd = token.end; break; }
                        }
                        if (headerEnd !== undefined) {
                            const recovered = await this.parse(source.slice(start.start, headerEnd) + '\nendmodule', filePath, false);
                            for (const model of recovered) {
                                const lineOffset = source.slice(0, start.start).split('\n').length - 1;
                                const columnOffset = start.start - source.lastIndexOf('\n', start.start - 1) - 1;
                                const positions = this.positions.get(model);
                                if (positions) {
                                    for (const records of [positions.ports, positions.parameters]) {
                                        for (const [name, record] of records) {
                                            records.set(name, { offset: record.offset + start.start, line: record.line + lineOffset,
                                                column: record.column + (record.line === 0 ? columnOffset : 0),
                                                endColumn: record.endColumn + (record.line === 0 ? columnOffset : 0) });
                                        }
                                    }
                                }
                                model.start = start.start;
                                model.end = tokens[finish]?.end ?? source.length;
                                model.line += lineOffset;
                                model.bodyStart += start.start;
                                // An invalid body cannot safely determine procedural context for snippets.
                                const bodyTokens = tokens.slice(index + 1, finish).filter(token => token.start >= headerEnd);
                                if (bodyTokens.some(token => /^(always(_ff|_comb|_latch)?|initial|function|task)$/.test(token.text))) {
                                    model.proceduralRanges = [{ start: headerEnd, end: model.end }];
                                }
                                models.push(model);
                            }
                        }
                    }
                    index = finish;
                }
            }
            return models.sort((a, b) => a.start - b.start);
        } finally { /* The caller owns the tree, including incremental trees. */ }
    }

    dispose(): void { this.parser?.delete(); this.parser = undefined; this.initializing = undefined; }
}
