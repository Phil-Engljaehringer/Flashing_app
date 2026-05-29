import BLHeliSource from '../index.js';
import eeprom from '../eeprom.js';
import settingsDescriptions from '../settings.js';
import escs from './escs.json' assert { type: 'json' };
import versions from './versions.json' assert { type: 'json' };

class BLHeliAtmelSource extends BLHeliSource {
  async getVersions() {
    return versions;
  }
}

const source = new BLHeliAtmelSource(
  'BLHeli',
  eeprom,
  settingsDescriptions,
  escs
);

export default BLHeliAtmelSource;
export {
  source,
};
