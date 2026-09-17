import { verilogTokens, VerilogToken } from 'colibri/parser/ts_verilog/project_model';
import { getCompletionScopes } from '../ctags/providers/completionScopes';

export interface InstanceContext {
    kind: 'ports' | 'parameters' | 'members';
    moduleName: string;
    instanceName?: string;
    usedNames: Set<string>;
    hasDot: boolean;
}

function identifier(text: string): boolean { return /^[a-zA-Z_$\\]/.test(text); }

function closeGroup(tokens: VerilogToken[], start: number): number {
    const close = tokens[start].text === '(' ? ')' : ']';
    let depth = 1;
    for (let index = start + 1; index < tokens.length; index++) {
        if (tokens[index].text === tokens[start].text) { depth++; }
        if (tokens[index].text === close && --depth === 0) { return index; }
    }
    return tokens.length;
}

function namedContext(tokens: VerilogToken[], open: number, close: number, offset: number,
    kind: 'ports' | 'parameters', moduleName: string, instanceName?: string): InstanceContext | undefined {
    if (offset < tokens[open].end || close < tokens.length && offset > tokens[close].start) { return; }
    const usedNames = new Set<string>();
    let depth = 0;
    let cursorDepth = 0;
    let lastSeparator = open;
    for (let index = open + 1; index < Math.min(close, tokens.length); index++) {
        const token = tokens[index];
        if (depth === 0 && token.text === '.' && identifier(tokens[index + 1]?.text ?? '')) {
            const name = tokens[index + 1];
            // Keep the currently edited name available; exclude other connections, even after the cursor.
            if (!(token.end <= offset && offset <= name.end)) { usedNames.add(name.text); }
        }
        if (['(', '[', '{'].includes(token.text)) { depth++; }
        if ([')', ']', '}'].includes(token.text)) { depth--; }
        if (token.start < offset) {
            cursorDepth = depth;
            if (depth === 0 && token.text === ',') { lastSeparator = index; }
        }
    }
    if (cursorDepth !== 0) { return; } // Inside .port(expression), ordinary local-signal completion applies.
    const prefix = tokens.slice(lastSeparator + 1, close).filter(token => token.start < offset);
    if (prefix.length > 2 || prefix.length && prefix[0].text !== '.') { return; }
    return { kind, moduleName, instanceName, usedNames, hasDot: prefix[0]?.text === '.' };
}

/** Recognizes unfinished connection lists without relying on a complete AST. */
export function getInstanceContext(source: string, offset: number, moduleNames: Set<string>): InstanceContext | undefined {
    const tokens = verilogTokens(source);
    const scopes = getCompletionScopes(source);
    const active = scopes.filter(scope => scope.start <= offset && offset < scope.end).pop();
    const declarations: { moduleName: string; instanceName: string; start: number }[] = [];
    for (let index = 0; index < tokens.length; index++) {
        if (!moduleNames.has(tokens[index].text)) { continue; }
        const previous = tokens[index - 1]?.text;
        if (['module', 'macromodule', 'interface', 'program', '.', '::'].includes(previous)) { continue; }
        const moduleName = tokens[index].text;
        let next = index + 1;
        if (tokens[next]?.text === '#') {
            if (tokens[next + 1]?.text !== '(') { continue; }
            const close = closeGroup(tokens, next + 1);
            const context = namedContext(tokens, next + 1, close, offset, 'parameters', moduleName);
            if (context) { return context; }
            next = close + 1;
        }
        while (identifier(tokens[next]?.text ?? '')) {
            const instanceName = tokens[next].text;
            const start = tokens[next].start;
            next++;
            while (tokens[next]?.text === '[') { next = closeGroup(tokens, next) + 1; }
            if (tokens[next]?.text !== '(') { break; }
            declarations.push({ moduleName, instanceName, start });
            const close = closeGroup(tokens, next);
            const context = namedContext(tokens, next, close, offset, 'ports', moduleName, instanceName);
            if (context) { return context; }
            next = close + 1;
            if (tokens[next]?.text !== ',') { break; }
            next++;
        }
    }
    // Hierarchical u_instance.member completion uses only instances in the active design unit.
    const before = tokens.filter(token => token.start < offset);
    let dot = before.length - 1;
    if (before[dot]?.text !== '.' && identifier(before[dot]?.text ?? '')) { dot--; }
    if (before[dot]?.text === '.' && identifier(before[dot - 1]?.text ?? '')) {
        const name = before[dot - 1].text;
        const instance = declarations.find(declaration => declaration.instanceName === name && active &&
            declaration.start >= active.start && declaration.start < active.end);
        if (instance) { return { kind: 'members', moduleName: instance.moduleName, instanceName: name, usedNames: new Set(), hasDot: true }; }
    }
    return undefined;
}
