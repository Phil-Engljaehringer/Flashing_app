import React, {
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  useDispatch,
  useSelector,
} from 'react-redux';
import { useTranslation } from 'react-i18next';

import Checkbox from '../Input/Checkbox';
import Overlay from '../Overlay';

import {
  loadWsUrl,
  saveWsUrl,
  loadBackendUrl,
  saveBackendUrl,
  loadDirectMode,
  saveDirectMode,
} from '../../utils/LocalStorage';

import {
  hide,
  selectSettings,
  selectShow,
  update,
} from './settingsSlice';

import './style.scss';

function AppSettings() {
  const { t } = useTranslation('settings');
  const dispatch = useDispatch();

  const settings = useSelector(selectSettings);
  const show = useSelector(selectShow);

  const wsUrlRef = useRef(null);
  const backendUrlRef = useRef(null);

  const handleCheckboxChange = useCallback((e) => {
    const name = e.target.name;
    const value = e.target.checked;

    dispatch(update({
      name,
      value,
    }));
  }, [dispatch]);

  const handleSaveWsUrl = useCallback(() => {
    const url = wsUrlRef.current ? wsUrlRef.current.value.trim() : '';
    if (url && !/^wss?:\/\/.+/.test(url)) {
      alert('Please enter a valid WebSocket URL (ws:// or wss://)');
      return;
    }
    saveWsUrl(url || null);
    window.location.reload();
  }, []);

  const handleSaveBackendUrl = useCallback(() => {
    const url = backendUrlRef.current ? backendUrlRef.current.value.trim() : '';
    if (url && !/^wss?:\/\/.+/.test(url)) {
      alert('Please enter a valid WebSocket URL (ws:// or wss://)');
      return;
    }
    saveBackendUrl(url || null);
    window.location.reload();
  }, []);

  const handleDirectModeChange = useCallback((e) => {
    saveDirectMode(e.target.checked);
  }, []);

  const onClose = useCallback((e) => {
    dispatch(hide());
  }, [dispatch]);

  const memoizedSettings = useMemo(() => {
    const settingKeys = Object.keys(settings);
    return settingKeys.map((key) => {
      const setting = settings[key];
      switch(setting.type) {
        case 'boolean': {
          return (
            <Checkbox
              hint={t(`${key}Hint`)}
              key={key}
              label={t(key)}
              name={key}
              onChange={handleCheckboxChange}
              value={setting.value ? 1 : 0}
            />
          );
        }

        default: {
          console.debug(`Setting type "${setting.type}" is not supported`);
          return false;
        }
      }
    });
  }, [handleCheckboxChange, settings, t]);

  if(!show) {
    return false;
  }

  const currentWsUrl = loadWsUrl() || '';
  const currentBackendUrl = loadBackendUrl() || '';
  const currentDirectMode = loadDirectMode();

  return (
    <div className="settings">
      <Overlay
        headline={t('settingsHeader')}
        onClose={onClose}
      >
        <div>
          {memoizedSettings}
        </div>

        <div className="ws-bridge">
          <h3 className="ws-bridge__heading">
            {t('wsBridgeHeading', 'WebSocket Serial Bridge')}
          </h3>

          <p className="ws-bridge__hint">
            {t('wsBridgeHint', 'To connect to serial ports on a remote companion computer, enter the bridge server URL (e.g. ws://192.168.1.100:8080). Leave blank to use the local browser serial API. Saving will reload the page.')}
          </p>

          <div className="ws-bridge__row">
            <input
              className="ws-bridge__input"
              defaultValue={currentWsUrl}
              placeholder="ws://192.168.1.100:8080"
              ref={wsUrlRef}
              type="text"
            />

            <button
              className="ws-bridge__save"
              onClick={handleSaveWsUrl}
              type="button"
            >
              {t('wsBridgeSave', 'Save & Reload')}
            </button>
          </div>

          {currentWsUrl && (
            <p className="ws-bridge__active">
              {t('wsBridgeActive', 'Active bridge: {{url}}', { url: currentWsUrl })}
            </p>
          )}
        </div>

        <div className="ws-bridge">
          <h3 className="ws-bridge__heading">
            {t('backendHeading', 'Backend Server (recommended)')}
          </h3>

          <p className="ws-bridge__hint">
            {t('backendHint', 'Connect to the full backend server running on the companion (node backend/server.js). All protocol logic runs on the companion. Takes priority over the bridge URL above. Leave blank to disable.')}
          </p>

          <div className="ws-bridge__row">
            <input
              className="ws-bridge__input"
              defaultValue={currentBackendUrl}
              placeholder="ws://192.168.1.100:8080"
              ref={backendUrlRef}
              type="text"
            />

            <button
              className="ws-bridge__save"
              onClick={handleSaveBackendUrl}
              type="button"
            >
              {t('wsBridgeSave', 'Save & Reload')}
            </button>
          </div>

          {currentBackendUrl && (
            <p className="ws-bridge__active">
              {t('backendActive', 'Active backend: {{url}}', { url: currentBackendUrl })}
            </p>
          )}
        </div>

        <div className="ws-bridge">
          <h3 className="ws-bridge__heading">
            {t('directModeHeading', 'Direct ESC Mode (AM32, no FC)')}
          </h3>

          <p className="ws-bridge__hint">
            {t('directModeHint', 'Enable when connecting directly to an AM32 ESC UART with no Betaflight FC in the chain. Skips MSP and speaks the FourWay protocol directly. Use baud rate 19200.')}
          </p>

          <label className="ws-bridge__row">
            <input
              defaultChecked={currentDirectMode}
              onChange={handleDirectModeChange}
              type="checkbox"
            />

            {t('directModeLabel', ' Direct ESC mode (no FC)')}
          </label>
        </div>
      </Overlay>
    </div>
  );
}

export default AppSettings;
