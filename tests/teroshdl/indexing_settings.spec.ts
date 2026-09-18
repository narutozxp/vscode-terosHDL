import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GlobalConfigManager } from '../../src/colibri/config/config_manager';
import { e_general_general_indexing_scope, get_config_from_json } from '../../src/colibri/config/config_declaration';
import { getIndexingSettings } from '../../src/teroshdl/features/language_provider/index/settings';

describe('ZHDL indexing configuration', () => {
    it('supplies safe defaults for older and invalid imported configuration', () => {
        GlobalConfigManager.newInstance('');
        for (const settings of [{}, { indexing_scope: 'invalid', live_parsing: 'true' }]) {
            GlobalConfigManager.getInstance().set_config(get_config_from_json({ general: { general: settings } }));
            expect(getIndexingSettings()).toEqual({ scope: 'openFiles', liveParsing: false });
        }
    });

    it('persists indexing settings through the plugin configuration save and load flow', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdl-settings-'));
        const file = path.join(directory, '.zhdl_config.json');
        try {
            const manager = GlobalConfigManager.newInstance(file);
            const changed = jest.fn();
            const subscription = manager.onDidChange(changed);
            const config = manager.get_config();
            config.general.general.indexing_scope = e_general_general_indexing_scope.workspace;
            config.general.general.live_parsing = true;
            manager.set_config(config);
            manager.save();
            expect(changed).toHaveBeenCalledTimes(1);
            subscription.dispose();
            manager.set_config(config);
            expect(changed).toHaveBeenCalledTimes(1);
            GlobalConfigManager.newInstance(file).load();
            expect(getIndexingSettings()).toEqual({ scope: 'workspace', liveParsing: true });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
