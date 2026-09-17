/** Opt-in diagnostics for the extension development host. No request bodies are recorded. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function install(): { dispose(): void } | undefined {
    if (process.env.ZHDL_TRACE_RUNTIME !== '1') { return undefined; }
    const file = path.join(os.tmpdir(), `zhdl-runtime-${process.pid}.jsonl`);
    const seen = new Set<string>();
    let enabled = true;
    let written = 0;
    const record = (event: string, details: object = {}) => {
        if (!enabled || written >= 2 * 1024 * 1024) { return; }
        try {
            const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n';
            fs.appendFileSync(file, line, { mode: 0o600 }); written += Buffer.byteLength(line);
        } catch { /* Diagnostics must not break activation. */ }
    };
    const stack = () => new Error().stack?.split('\n').slice(2, 24).join('\n');
    const moduleLoader = require('module');
    const originalLoad = moduleLoader._load;
    const load = function(request: string, parent: any, ...rest: any[]) {
        if (enabled && ['punycode', 'node:punycode', 'applicationinsights', '@vscode/extension-telemetry'].includes(request)) {
            const key = request + ':' + parent?.filename;
            if (!seen.has(key)) {
                seen.add(key); record('module-load', { request, caller: parent?.filename, stack: stack() });
            }
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
    moduleLoader._load = load;
    const requests: { module: any; original: Function; wrapper: Function }[] = [];
    for (const protocol of ['http', 'https']) {
        const module = require(protocol);
        const original = module.request;
        const wrapper = function(...args: any[]) {
            let host = '';
            try {
                const first = args[0];
                host = typeof first === 'string' ? new URL(first).hostname : first?.hostname ?? first?.host ?? '';
            } catch { /* Keep the original request's validation behavior. */ }
            if (enabled && /(?:^|\.)(?:applicationinsights\.azure\.com|services\.visualstudio\.com)(?::\d+)?$/.test(host) && !seen.has(host)) {
                seen.add(host); record('telemetry-request-callsite', { host, stack: stack() });
            }
            return original.apply(this, args);
        };
        requests.push({ module, original, wrapper }); module.request = wrapper;
    }
    const originals = new Map<string, Function>();
    const wrappers = new Map<string, Function>();
    for (const name of ['log', 'warn', 'error']) {
        const original = console[name]; originals.set(name, original);
        const wrapper = function(...args: unknown[]) {
            const strings = args.filter(value => typeof value === 'string') as string[];
            for (const marker of ['ApplicationInsights:Sender', 'Sending notification failed']) {
                if (enabled && strings.some(text => text.includes(marker)) && !seen.has(marker)) {
                    seen.add(marker); record('console-callsite', { marker, stack: stack() });
                }
            }
            return original.apply(this, args);
        };
        wrappers.set(name, wrapper); console[name] = wrapper;
    }
    const warning = (value: Error & { code?: string }) => record('warning', { name: value.name, code: value.code, stack: value.stack });
    const fatal = (value: Error, origin: string) => record('uncaught-exception', { origin, stack: value.stack });
    const exit = (code: number) => record('exit', { code });
    process.on('warning', warning);
    // Observe without handling the exception or changing Node's normal termination behavior.
    process.on('uncaughtExceptionMonitor', fatal);
    process.on('exit', exit);
    const memory = () => record('memory', process.memoryUsage());
    const timer = setInterval(memory, 30000); timer.unref();
    record('start', { node: process.version, logFile: file }); memory();
    originals.get('log').call(console, `[ZHDL diagnostic] ${file}`);
    return { dispose() {
        record('diagnostics-disposed'); enabled = false; clearInterval(timer);
        process.removeListener('warning', warning); process.removeListener('uncaughtExceptionMonitor', fatal); process.removeListener('exit', exit);
        if (moduleLoader._load === load) { moduleLoader._load = originalLoad; }
        for (const { module, original, wrapper } of requests) { if (module.request === wrapper) { module.request = original; } }
        for (const [name, original] of originals) { if (console[name] === wrappers.get(name)) { console[name] = original; } }
    } };
}

// Loaded before ZHDL dependencies so their startup warnings retain their original stacks.
const diagnostics = install();
export function registerRuntimeDiagnostics(context: { subscriptions: { dispose(): unknown }[] }): void {
    if (diagnostics) { context.subscriptions.push(diagnostics); }
}
