import { ExtensionContext } from 'vscode';
import { ExtensionManager } from '../../src/teroshdl/features/utils/webview/utils';

jest.mock('vscode', () => ({
    workspace: {
        fs: {
            readFile: jest.fn().mockRejectedValue(new Error('No previous user config')),
            writeFile: jest.fn().mockResolvedValue(undefined)
        }
    }
}), { virtual: true });

import { workspace } from 'vscode';

describe('ExtensionManager for a renamed extension', () => {
    it('initializes using its own installation directory and package metadata', async () => {
        const extensionUri = {
            path: '/extensions/narutozxp.zhdl',
            with: (change: { path: string }) => change
        };
        const packageJSON = { version: '8.0.6', contributes: {} };
        const context = { extensionUri, extension: { packageJSON } } as unknown as ExtensionContext;

        const manager = new ExtensionManager(context);
        expect(manager.get_package_json()).toBe(packageJSON);
        await manager.init();

        expect(manager.get_installation_type()).toEqual(expect.objectContaining({ firstInstall: true }));
        expect(workspace.fs.writeFile).toHaveBeenCalledWith(
            { path: '/extensions/narutozxp.zhdl/user.teros-hdl.config.json' },
            expect.any(Uint8Array)
        );
        const bytes = (workspace.fs.writeFile as jest.Mock).mock.calls[0][1];
        expect(JSON.parse(Buffer.from(bytes).toString('utf8')).changelog.lastversion).toBe('8.0.6');
    });
});
