import { useCallback, useEffect, useRef, useState } from 'react';
import { Expand, FileArchive, Gamepad2, Info, Maximize2, MonitorPlay, Play, Shrink, Terminal, X } from 'lucide-react';
import VirtualGamepad from './VirtualGamepad.jsx';
import {
  bootEasyRpgPlayer,
  dispatchGamepadKey,
  installKeyboardAliases,
  probeEasyRpgRuntime,
  readBuiltInSoundFont,
  readGameZip,
  requestEasyRpgMapJump,
  subscribeEasyRpgEvents,
} from './easyrpgBridge.js';

const EVENT_BUTTON_LABEL = 'EVENT';
const GENGAKU_TEST_GAME_NAME = 'Gengakushoujo';
const GENGAKU_TEST_SOURCE_MAP_ID = 5;
const GENGAKU_TEST_TARGET_MAP = { mapId: 4, mapName: 'Map0004' };
const A_BUTTON_KEY = 'K';
const EVENT_BUTTON_EVENT_IDS = [];
const EVENT_BUTTON_COMMAND_CODES = [];

export default function App() {
  const canvasRef = useRef(null);
  const playerFrameRef = useRef(null);
  const fileInputRef = useRef(null);
  const playerRef = useRef(null);
  const [gamepadVisible, setGamepadVisible] = useState(true);
  const [runtime, setRuntime] = useState(null);
  const [gameArchive, setGameArchive] = useState(null);
  const [soundFont, setSoundFont] = useState(null);
  const [zipProgress, setZipProgress] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsVisible, setLogsVisible] = useState(false);
  const [licenseVisible, setLicenseVisible] = useState(false);
  const [runtimeEventButton, setRuntimeEventButton] = useState({
    visible: false,
    detail: null,
  });
  const [currentRuntimeMap, setCurrentRuntimeMap] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const [fitWidth, setFitWidth] = useState(false);
  const [status, setStatus] = useState({
    state: 'checking',
    message: 'WASM本体を確認中',
  });

  useEffect(() => {
    let cancelled = false;

    probeEasyRpgRuntime().then((nextRuntime) => {
      if (cancelled) {
        return;
      }

      setRuntime(nextRuntime);
      setStatus({
        state: nextRuntime.ready ? 'ready' : 'waiting',
        message: nextRuntime.ready ? 'ゲームZIPを選択してください' : 'WASM本体待ち',
        runtime: nextRuntime,
      });
    }).catch((error) => {
      if (!cancelled) {
        setStatus({
          state: 'error',
          message: error.message || 'WASM本体の確認に失敗しました',
        });
      }
    });

    return () => {
      cancelled = true;
      playerRef.current?.stop?.();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => installKeyboardAliases(), []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreenActive(getFullscreenElement() === playerFrameRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => subscribeEasyRpgEvents((detail) => {
    appendLog(setLogs, 'EasyRPG event detected', detail);
    if (hasMapDetail(detail)) {
      setCurrentRuntimeMap(detail);
    }
  }), [gameArchive]);

  useEffect(() => {
    const handleAButton = (event) => {
      if (event.repeat || event.key?.toUpperCase() !== A_BUTTON_KEY || shouldIgnoreInputTrigger(event)) {
        return;
      }

      const detail = {
        name: 'a-button',
        button: 'A',
        mapId: currentRuntimeMap?.mapId,
        mapName: currentRuntimeMap?.mapName,
        source: 'keyboard',
      };

      if (shouldShowRuntimeEventButton(detail, gameArchive)) {
        appendLog(setLogs, 'Gengakushoujo Map0005 A trigger detected', detail);
      }
    };

    window.addEventListener('keydown', handleAButton);
    return () => window.removeEventListener('keydown', handleAButton);
  }, [currentRuntimeMap, gameArchive]);

  useEffect(() => {
    let cancelled = false;

    readBuiltInSoundFont().then((builtInSoundFont) => {
      if (cancelled) {
        return;
      }

      if (builtInSoundFont) {
        setSoundFont(builtInSoundFont);
        appendLog(setLogs, 'Built-in SoundFont loaded', {
          name: builtInSoundFont.name,
          source: builtInSoundFont.sourcePath,
          size: builtInSoundFont.size,
        });
      } else {
        appendLog(setLogs, 'Built-in SoundFont not found', {
          expected: [
            'public/*.sf2 via known candidates',
            'public/soundfonts/*.sf2 via manifest.json',
            'public/soundfonts.json',
          ],
        });
      }
    }).catch((error) => {
      if (!cancelled) {
        appendLog(setLogs, 'Built-in SoundFont load failed', errorToDetail(error));
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleError = (event) => {
      appendLog(setLogs, 'Browser error', {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        error: errorToDetail(event.error),
      });
    };

    const handleUnhandledRejection = (event) => {
      appendLog(setLogs, 'Unhandled promise rejection', errorToDetail(event.reason));
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  const handleZipChange = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setGameArchive(null);
    setRuntimeEventButton({ visible: false, detail: null });
    setCurrentRuntimeMap(null);
    setZipProgress({ loaded: 0, total: 0, fileName: file.name });
    appendLog(setLogs, 'ZIP selected', { name: file.name, size: file.size });
    setStatus((current) => ({
      ...current,
      state: 'unzipping',
      message: 'ZIPをブラウザ内で展開中',
    }));

    try {
      const archive = await readGameZip(file, (progress) => {
        setZipProgress(progress);
        if (progress.loaded === progress.total || progress.loaded % 20 === 0) {
          appendLog(setLogs, 'ZIP extract progress', progress);
        }
      });
      setGameArchive(archive);
      appendLog(setLogs, 'ZIP extracted', {
        name: archive.name,
        files: archive.fileCount,
        sample: archive.files.slice(0, 8).map((entry) => entry.path),
      });
      setStatus((current) => ({
        ...current,
        state: runtime?.ready ? 'ready' : 'waiting',
        message: runtime?.ready ? '起動できます' : 'WASM本体待ち',
      }));
    } catch (error) {
      appendLog(setLogs, 'ZIP load failed', errorToDetail(error));
      setStatus((current) => ({
        ...current,
        state: 'error',
        message: error.message || 'ZIPの読み込みに失敗しました',
      }));
    } finally {
      event.target.value = '';
    }
  }, [runtime]);

  const handleStart = useCallback(async () => {
    if (!gameArchive || isStarting) {
      return;
    }

    setIsStarting(true);
    setRuntimeEventButton({ visible: false, detail: null });
    setCurrentRuntimeMap(null);

    try {
      if (playerRef.current?.started) {
        setStatus((current) => ({
          ...current,
          state: 'resetting',
          message: 'リセット中',
        }));
        appendLog(setLogs, 'Resetting EasyRPG before restart');
        playerRef.current.stop?.();
        playerRef.current = null;
        setIsRunning(false);
        await waitForReset();
      }

      appendLog(setLogs, 'Starting EasyRPG', {
        archive: gameArchive.name,
        files: gameArchive.fileCount,
        soundFont: soundFont?.name,
      });
      const player = await bootEasyRpgPlayer({
        canvas: canvasRef.current,
        canvasContainer: playerFrameRef.current,
        gameArchive,
        soundFont,
        onStatus: setStatus,
        onLog: (entry) => setLogs((current) => [...current.slice(-80), entry]),
      });
      playerRef.current = player;
      setRuntime(player.runtime);
      setIsRunning(Boolean(player.started));
    } catch (error) {
      appendLog(setLogs, 'EasyRPG start failed', errorToDetail(error));
      setIsRunning(false);
      setStatus({
        state: 'error',
        message: formatErrorMessage(error, 'EasyRPG本体の起動に失敗しました'),
      });
    } finally {
      setIsStarting(false);
    }
  }, [gameArchive, isStarting, soundFont]);

  const handleFullscreen = useCallback(async () => {
    const target = playerFrameRef.current;
    if (!target) {
      return;
    }

    try {
      if (fullscreenActive || getFullscreenElement()) {
        await exitFullscreen();
        setFullscreenActive(false);
        setLogsVisible(false);
        setLicenseVisible(false);
        unlockLandscapeOrientation();
        return;
      }

      setLogsVisible(false);
      setLicenseVisible(false);
      await requestFullscreen(target);
      setFullscreenActive(true);
      await lockLandscapeOrientation();
    } catch (error) {
      setStatus((current) => ({
        ...current,
        message: error.message || '全画面表示に切り替えられませんでした',
      }));
    }
  }, [fullscreenActive]);

  const handleRuntimeEventButton = useCallback(() => {
    const buttonDetail = runtimeEventButton.detail || buildGengakuMap0004ButtonDetail();
    appendLog(setLogs, 'Runtime event button pressed', buttonDetail);
    if (buttonDetail?.targetMap) {
      const result = requestEasyRpgMapJump(playerRef.current?.module, buttonDetail.targetMap);
      appendLog(setLogs, 'Map jump requested', result);
    } else {
      dispatchGamepadKey('K', true);
      window.setTimeout(() => dispatchGamepadKey('K', false), 60);
    }
    setRuntimeEventButton({ visible: false, detail: null });
  }, [runtimeEventButton.detail]);

  const canStart = Boolean(runtime?.ready && gameArchive && !isStarting);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">EasyRPG Web Launcher</p>
          <h1>弦楽プレイヤー</h1>
        </div>
        <div className="toolbar" aria-label="表示設定">
          <button
            type="button"
            className="icon-button"
            onClick={() => setGamepadVisible((visible) => !visible)}
            aria-pressed={gamepadVisible}
            title="仮想パッド表示切替"
          >
            <Gamepad2 aria-hidden="true" />
            <span>{gamepadVisible ? 'Pad On' : 'Pad Off'}</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={handleFullscreen}
            title="全画面"
          >
            <Expand aria-hidden="true" />
            <span>Full</span>
          </button>
        </div>
      </header>

      <section className="launcher-panel" aria-label="ゲームZIP選択">
        <div className="launcher-actions">
          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            onChange={handleZipChange}
          />
          <div className="archive-summary" aria-live="polite">
            <span>{gameArchive?.name || 'ZIP未選択'}</span>
            <span>{soundFont ? `Built-in: ${soundFont.name}` : 'Built-in SoundFont未検出'}</span>
            <span>
              {gameArchive
                ? `${gameArchive.fileCount} files`
                : 'File APIでローカルから読み込みます'}
            </span>
            {zipProgress && (
              <span>
                展開: {zipProgress.total ? `${zipProgress.loaded}/${zipProgress.total}` : '準備中'}
              </span>
            )}
          </div>
          <button
            type="button"
            className="primary-button start-launch"
            onClick={handleStart}
            disabled={!canStart}
          >
            <Play aria-hidden="true" />
            {isStarting ? (isRunning ? 'リセット中' : '起動中') : (isRunning ? 'リセット' : '起動')}
          </button>
        </div>
      </section>

      <section className="player-layout" aria-label="EasyRPG player">
        <div
          ref={playerFrameRef}
          className={[
            'player-frame',
            fullscreenActive ? 'is-fullscreen is-landscape-layout' : '',
            fitWidth ? 'is-fit-width' : '',
          ].filter(Boolean).join(' ')}
        >
          <button
            type="button"
            className="fit-width-button"
            onClick={() => setFitWidth((current) => !current)}
            aria-pressed={fitWidth}
            title="比率を保って横幅にフィット"
          >
            <Maximize2 aria-hidden="true" />
            <span>Fit</span>
          </button>
          {fullscreenActive && (
            <button
              type="button"
              className="fullscreen-exit-button"
              onClick={handleFullscreen}
              title="全画面を戻す"
            >
              <Shrink aria-hidden="true" />
              <span>Full</span>
            </button>
          )}
          <div className="canvas-frame">
            <canvas
              id="canvas"
              ref={canvasRef}
              className="game-canvas"
              width="640"
              height="480"
              tabIndex="0"
              aria-label="ゲーム表示領域"
            />
            <div id="status" className="native-status" aria-hidden="true" />
            {status.state !== 'running' && (
              <div className="status-overlay" role="status">
                <MonitorPlay aria-hidden="true" />
                <strong>{status.message}</strong>
                <button
                  type="button"
                  className="primary-button overlay-zip-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileArchive aria-hidden="true" />
                  ZIPを選択
                </button>
              </div>
            )}
            {runtimeEventButton.visible && (
              <button
                type="button"
                className="runtime-event-button"
                onClick={handleRuntimeEventButton}
              >
                {runtimeEventButton.detail?.label || EVENT_BUTTON_LABEL}
              </button>
            )}
          </div>

          <VirtualGamepad visible={gamepadVisible} />
        </div>
      </section>

      {!fullscreenActive && (
        <div className="floating-actions" aria-label="補助メニュー">
          <button
            type="button"
            className="floating-toggle-button license-toggle-button"
            onClick={() => {
              setLicenseVisible((visible) => !visible);
              setLogsVisible(false);
            }}
            aria-expanded={licenseVisible}
            aria-label="ライセンスと謝辞を表示"
            title="ライセンスと謝辞"
          >
            <Info aria-hidden="true" />
          </button>
          <button
            type="button"
            className="floating-toggle-button log-toggle-button"
            onClick={() => {
              setLogsVisible((visible) => !visible);
              setLicenseVisible(false);
            }}
            aria-expanded={logsVisible}
            aria-label="起動ログを表示"
            title="起動ログ"
        >
          <Terminal aria-hidden="true" />
        </button>
      </div>
      )}

      {licenseVisible && (
        <section className="info-panel" aria-label="ライセンスと謝辞">
          <div className="log-header">
            <h2>ライセンスと謝辞</h2>
            <button
              type="button"
              className="icon-only-button"
              onClick={() => setLicenseVisible(false)}
              aria-label="ライセンスと謝辞を閉じる"
              title="閉じる"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <p>EasyRPG Player is developed by the EasyRPG project.</p>
          <p>
            Runtime repository:{' '}
            <a
              href="https://github.com/sevenc-nanashi/easyrpg-player/tree/gengaku-player/master"
              target="_blank"
              rel="noreferrer"
            >
              sevenc-nanashi/easyrpg-player
            </a>
          </p>
          <p>Runtime patched by Nanashi.</p>
          <p>Built with React, Vite, JSZip, and lucide-react.</p>
          <p>Game assets are not distributed with this launcher.</p>
        </section>
      )}

      {logsVisible && (
        <section className="log-panel" aria-label="起動ログ">
          <div className="log-header">
            <h2>起動ログ</h2>
            <div className="log-actions">
              <button type="button" className="text-button" onClick={() => setLogs([])}>
                Clear
              </button>
              <button
                type="button"
                className="icon-only-button"
                onClick={() => setLogsVisible(false)}
                aria-label="ログを閉じる"
                title="閉じる"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          <pre>{logs.length ? logs.map(formatLogEntry).join('\n') : 'ログはまだありません。'}</pre>
        </section>
      )}
    </main>
  );
}

function formatErrorMessage(error, fallback) {
  if (error?.message) {
    return `${fallback}: ${error.message}`;
  }

  if (typeof error === 'string') {
    return `${fallback}: ${error}`;
  }

  return fallback;
}

function shouldShowRuntimeEventButton(detail, gameArchive) {
  if (isGengakuMap0005AButton(detail, gameArchive)) {
    Object.assign(detail, buildGengakuMap0004ButtonDetail());
    return true;
  }

  return Boolean(
    detail?.showButton
      || detail?.name === 'show-button'
      || detail?.eventName === 'show-button'
      || detail?.action === 'show-button'
      || EVENT_BUTTON_EVENT_IDS.includes(detail?.eventId)
      || EVENT_BUTTON_COMMAND_CODES.includes(detail?.commandCode)
  );
}

function isGengakuMap0005AButton(detail, gameArchive) {
  if (!gameArchiveNameMatches(gameArchive, GENGAKU_TEST_GAME_NAME)) {
    return false;
  }

  return isMap0005(detail) && isAButtonEvent(detail);
}

function buildGengakuMap0004ButtonDetail() {
  return {
    label: 'Map0004',
    targetMap: GENGAKU_TEST_TARGET_MAP,
  };
}

function gameArchiveNameMatches(gameArchive, expectedName) {
  return normalizeGameName(gameArchive?.name).includes(normalizeGameName(expectedName));
}

function isMap0005(detail) {
  const mapName = normalizeMatchText(detail?.mapName || detail?.map || detail?.mapFile);
  return Number(detail?.mapId) === GENGAKU_TEST_SOURCE_MAP_ID
    || mapName === 'map0005'
    || mapName === 'map0005lmu'
    || mapName.endsWith('map0005lmu');
}

function isAButtonEvent(detail) {
  const button = normalizeMatchText(detail?.button || detail?.key || detail?.input);
  const type = normalizeMatchText(detail?.eventType || detail?.type || detail?.action || detail?.name);
  return button === 'a'
    || button === 'k'
    || type === 'abutton'
    || type === 'buttona'
    || type === 'keya'
    || type === 'keyk';
}

function hasMapDetail(detail) {
  return detail?.mapId !== undefined
    || detail?.mapName !== undefined
    || detail?.map !== undefined
    || detail?.mapFile !== undefined;
}

function shouldIgnoreInputTrigger(event) {
  const target = event.target;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable;
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeGameName(value) {
  return normalizeMatchText(value).replace(/syoujo/g, 'shoujo');
}

async function lockLandscapeOrientation() {
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Orientation lock support varies by mobile browser.
  }
}

function unlockLandscapeOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // Best effort only.
  }
}

function getFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.msFullscreenElement
    || null;
}

async function requestFullscreen(target) {
  const request = target.requestFullscreen
    || target.webkitRequestFullscreen
    || target.webkitEnterFullscreen
    || target.msRequestFullscreen;

  if (typeof request !== 'function') {
    return;
  }

  await request.call(target);
}

async function exitFullscreen() {
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.webkitCancelFullScreen
    || document.msExitFullscreen;

  if (typeof exit !== 'function') {
    return;
  }

  await exit.call(document);
}

function appendLog(setLogs, message, detail) {
  setLogs((current) => [
    ...current.slice(-80),
    {
      time: new Date().toLocaleTimeString(),
      message,
      detail,
    },
  ]);
}

function formatLogEntry(entry) {
  const detail = entry.detail === undefined ? '' : ` ${stringifyDetail(entry.detail)}`;
  return `[${entry.time}] ${entry.message}${detail}`;
}

function stringifyDetail(detail) {
  if (typeof detail === 'string') {
    return detail;
  }

  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function errorToDetail(error) {
  return {
    name: error?.name,
    message: error?.message || String(error),
    errno: error?.errno,
    code: error?.code,
    stack: error?.stack,
  };
}

function waitForReset() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 150);
  });
}
