import { GlobalConfigManager } from 'colibri/config/config_manager';

/** Indexing is configured in ZHDL's global settings, alongside tool settings. */
export function getIndexingSettings(): { scope: 'openFiles' | 'workspace'; liveParsing: boolean } {
    try {
        const settings = GlobalConfigManager.getInstance().get_config().general.general;
        return { scope: settings.indexing_scope === 'workspace' ? 'workspace' : 'openFiles',
            liveParsing: settings.live_parsing === true };
    } catch {
        // Providers may be constructed before global configuration during tests.
        return { scope: 'openFiles', liveParsing: false };
    }
}
