import BLHeliSource from '../Blheli/index.js';
import eeprom from '../Blheli/eeprom.js';
import settingsDescriptions from './settings.js';
import escs from './escs.json' assert { type: 'json' };
import versions from './versions.json' assert { type: 'json' };
import Silabs from '../../Hardware/Silabs.js';

class BLHeliSSource extends BLHeliSource {
  getMcus() {
    return Silabs.getMcus();
  }

  async getVersions() {
    return versions;
  }
}

const source = new BLHeliSSource(
  'BLHeli_S',
  eeprom,
  settingsDescriptions,
  escs
);

export default BLHeliSSource;
export {
  source,
};
