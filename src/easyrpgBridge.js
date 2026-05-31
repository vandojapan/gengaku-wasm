import JSZip from 'jszip';

const PLAYER_CANDIDATES = [
  { scriptPath: '/easyrpg-player.js', wasmPath: '/easyrpg-player.wasm' },
  { scriptPath: '/index.js', wasmPath: '/index.wasm' },
];
const BUILTIN_SOUNDFONT_MANIFESTS = [
  '/soundfonts/manifest.json',
  '/soundfonts.json',
];
const BUILTIN_SOUNDFONT_CANDIDATES = [
  '/GeneralUser-GS.sf2',
  '/GeneralUser2.sf2',
  '/soundfonts/GeneralUser-GS.sf2',
  '/soundfonts/GeneralUser2.sf2',
];
const GAME_ROOT = '/game';
const SOUNDFONT_ROOT = '/soundfont';
const KEYBOARD_ALIASES = {
  w: 'ArrowUp',
  a: 'ArrowLeft',
  s: 'ArrowDown',
  d: 'ArrowRight',
  W: 'ArrowUp',
  A: 'ArrowLeft',
  S: 'ArrowDown',
  D: 'ArrowRight',
};

const scriptLoadPromises = new Map();
const pressedAliases = new Set();
let aliasCleanup = null;
const runtimeEventTarget = new EventTarget();

const RUNTIME_EVENT_LOG_PATTERNS = [
  {
    name: 'gengaku-map0005-a',
    test: /\bGENGAKU_MAP0005_A\b/i,
    build: (message) => ({
      name: 'gengaku-map-a',
      gameName: 'Gengakushoujo',
      mapName: 'Map0005',
      mapId: 5,
      button: 'A',
      source: 'log',
      raw: message,
    }),
  },
  {
    name: 'map0005-a',
    test: /\b(?:map|map_id|mapId)\s*[:=]?\s*(?:Map)?0*005\b.*\b(?:button|key|input)\s*[:=]?\s*A\b/i,
    build: (message) => ({
      name: 'map-button',
      mapName: 'Map0005',
      mapId: 5,
      button: 'A',
      source: 'log',
      raw: message,
    }),
  },
  {
    name: 'show-button',
    test: /\bSHOW_EVENT_BUTTON\b/i,
    build: (message) => ({ name: 'show-button', source: 'log', raw: message }),
  },
  {
    name: 'event-id',
    test: /\b(?:event_id|eventId|event)\s*[:=]\s*(\d+)\b/i,
    build: (message, match) => ({
      name: 'event',
      eventId: Number(match[1]),
      source: 'log',
      raw: message,
    }),
  },
  {
    name: 'command-code',
    test: /\b(?:command_code|commandCode|code)\s*[:=]\s*(\d+)\b/i,
    build: (message, match) => ({
      name: 'command',
      commandCode: Number(match[1]),
      source: 'log',
      raw: message,
    }),
  },
];

async function assetExists(path, expectedType) {
  try {
    const response = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get('content-type') || '';
    if (expectedType === 'script') {
      return contentType.includes('javascript') || contentType.includes('text/plain');
    }
    if (expectedType === 'wasm') {
      return contentType.includes('wasm') || contentType.includes('octet-stream');
    }

    return true;
  } catch {
    return false;
  }
}

function loadScript(path) {
  if (scriptLoadPromises.has(path)) {
    return scriptLoadPromises.get(path);
  }

  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-easyrpg-player="${path}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = path;
    script.async = true;
    script.dataset.easyrpgPlayer = path;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${path}`));
    document.head.appendChild(script);
  });

  scriptLoadPromises.set(path, promise);
  return promise;
}

export function dispatchGamepadKey(key, pressed) {
  const eventType = pressed ? 'keydown' : 'keyup';
  const options = {
    key,
    code: keyToCode(key),
    bubbles: true,
    cancelable: true,
  };
  const event = new KeyboardEvent(eventType, options);
  const canvasEvent = new KeyboardEvent(eventType, options);

  window.dispatchEvent(event);
  document.dispatchEvent(new KeyboardEvent(eventType, options));
  document.getElementById('canvas')?.dispatchEvent(canvasEvent);
}

export function subscribeEasyRpgEvents(listener) {
  const handleInternalEvent = (event) => listener(event.detail);
  const handleWindowEvent = (event) => {
    emitEasyRpgEvent({
      source: 'window',
      ...normalizeRuntimeEventDetail(event.detail),
    });
  };

  runtimeEventTarget.addEventListener('easyrpg-runtime-event', handleInternalEvent);
  window.addEventListener('easyrpg:event', handleWindowEvent);
  exposeEasyRpgEventBridge();

  return () => {
    runtimeEventTarget.removeEventListener('easyrpg-runtime-event', handleInternalEvent);
    window.removeEventListener('easyrpg:event', handleWindowEvent);
  };
}

export function emitEasyRpgEvent(detail) {
  runtimeEventTarget.dispatchEvent(new CustomEvent('easyrpg-runtime-event', {
    detail: normalizeRuntimeEventDetail(detail),
  }));
}

export function requestEasyRpgMapJump(module, target) {
  const detail = {
    mapId: target?.mapId,
    mapName: target?.mapName,
    x: target?.x,
    y: target?.y,
  };

  window.dispatchEvent(new CustomEvent('easyrpg:jump-request', { detail }));

  const candidates = [
    module?.api?.jumpToMap,
    module?.api?.transferPlayer,
    module?.api?.changeMap,
    module?.api?.setMap,
    module?.api_private?.jumpToMap,
    module?.api_private?.transferPlayer,
    module?.api_private?.changeMap,
    module?.api_private?.setMap,
  ].filter((candidate) => typeof candidate === 'function');

  for (const jump of candidates) {
    try {
      jump(detail.mapId, detail.x ?? 0, detail.y ?? 0);
      module?.api?.refreshScene?.();
      return { handled: true, detail };
    } catch (error) {
      return {
        handled: false,
        detail,
        error: {
          name: error?.name,
          message: error?.message || String(error),
        },
      };
    }
  }

  return {
    handled: false,
    detail,
    reason: 'EasyRPG map jump API is not exposed yet',
  };
}

export function installKeyboardAliases() {
  if (aliasCleanup) {
    return aliasCleanup;
  }

  const handleKeyDown = (event) => {
    const mapped = KEYBOARD_ALIASES[event.key];
    if (!mapped || event.repeat || shouldIgnoreKeyboardAlias(event)) {
      return;
    }

    event.preventDefault();
    pressedAliases.add(event.code);
    dispatchGamepadKey(mapped, true);
  };

  const handleKeyUp = (event) => {
    const mapped = KEYBOARD_ALIASES[event.key];
    if (!mapped || shouldIgnoreKeyboardAlias(event)) {
      return;
    }

    event.preventDefault();
    pressedAliases.delete(event.code);
    dispatchGamepadKey(mapped, false);
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);

  aliasCleanup = () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('keyup', handleKeyUp, true);
    pressedAliases.forEach((code) => {
      const key = Object.entries(KEYBOARD_ALIASES).find(([alias]) => `Key${alias.toUpperCase()}` === code)?.[1];
      if (key) {
        dispatchGamepadKey(key, false);
      }
    });
    pressedAliases.clear();
    aliasCleanup = null;
  };

  return aliasCleanup;
}

function shouldIgnoreKeyboardAlias(event) {
  const target = event.target;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target?.isContentEditable;
}

export async function probeEasyRpgRuntime() {
  for (const candidate of PLAYER_CANDIDATES) {
    const [hasScript, hasWasm] = await Promise.all([
      assetExists(candidate.scriptPath, 'script'),
      assetExists(candidate.wasmPath, 'wasm'),
    ]);

    if (hasScript && hasWasm) {
      return {
        hasScript,
        hasWasm,
        ready: hasScript && hasWasm,
        scriptPath: candidate.scriptPath,
        wasmPath: candidate.wasmPath,
      };
    }
  }

  return {
    hasScript: false,
    hasWasm: false,
    ready: false,
    scriptPath: PLAYER_CANDIDATES[0].scriptPath,
    wasmPath: PLAYER_CANDIDATES[0].wasmPath,
  };
}

export async function readGameZip(file, onProgress) {
  if (!file) {
    throw new Error('ZIPファイルを選択してください');
  }

  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const files = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const path = normalizeZipPath(entry.name);
    if (!path) {
      continue;
    }

    const data = await entry.async('uint8array');
    files.push({
      path,
      data,
      size: data.byteLength,
    });

    onProgress?.({
      type: 'progress',
      loaded: index + 1,
      total: entries.length,
      fileName: entry.name,
    });
  }

  if (files.length === 0) {
    throw new Error('ZIPにゲームファイルが見つかりませんでした');
  }

  return {
    name: file.name,
    size: file.size,
    fileCount: files.length,
    files: normalizeGameRoot(files),
  };
}

export async function readServerGameFiles({ name, baseUrl, files }, onProgress) {
  const loadedFiles = [];

  for (let index = 0; index < files.length; index += 1) {
    const path = normalizeZipPath(files[index]);
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/${encodePath(path)}`);
    if (!response.ok) {
      throw new Error(`${path} を読み込めませんでした (${response.status})`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    loadedFiles.push({
      path,
      data,
      size: data.byteLength,
    });

    onProgress?.({
      type: 'progress',
      loaded: index + 1,
      total: files.length,
      fileName: path,
    });
  }

  return {
    name,
    size: loadedFiles.reduce((total, file) => total + file.size, 0),
    fileCount: loadedFiles.length,
    files: loadedFiles,
  };
}

export async function readSoundFontFile(file) {
  if (!file) {
    throw new Error('SoundFontファイルを選択してください');
  }

  const data = new Uint8Array(await file.arrayBuffer());
  return {
    name: file.name,
    path: normalizeZipPath(file.name) || 'soundfont.sf2',
    size: data.byteLength,
    data,
  };
}

export async function readBuiltInSoundFont() {
  const candidates = [
    ...await readSoundFontManifests(),
    ...BUILTIN_SOUNDFONT_CANDIDATES,
  ].filter((path) => path.toLowerCase().endsWith('.sf2'));

  for (const path of [...new Set(candidates)]) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok || isHtmlResponse(response)) {
      continue;
    }

    const data = new Uint8Array(await response.arrayBuffer());
    return {
      name: basename(path),
      path: basename(path),
      sourcePath: path,
      size: data.byteLength,
      data,
    };
  }

  return null;
}

async function readSoundFontManifests() {
  const paths = [];

  for (const manifestPath of BUILTIN_SOUNDFONT_MANIFESTS) {
    const response = await fetch(manifestPath, { cache: 'no-store' });
    if (!response.ok || isHtmlResponse(response)) {
      continue;
    }

    const manifest = await response.json();
    const entries = Array.isArray(manifest) ? manifest : manifest.files;
    if (!Array.isArray(entries)) {
      continue;
    }

    entries
      .filter((entry) => typeof entry === 'string' && entry.toLowerCase().endsWith('.sf2'))
      .forEach((entry) => {
        if (entry.startsWith('/')) {
          paths.push(entry);
        } else if (manifestPath.startsWith('/soundfonts/')) {
          paths.push(`/soundfonts/${entry}`);
        } else {
          paths.push(`/${entry}`);
        }
      });
  }

  return paths;
}

export async function bootEasyRpgPlayer({
  canvas,
  canvasContainer,
  gameArchive,
  soundFont,
  onStatus,
  onLog,
} = {}) {
  const log = (message, detail) => {
    onLog?.({
      time: new Date().toLocaleTimeString(),
      message,
      detail,
    });
  };
  const logRuntimeText = (message, text) => {
    log(message, text);
    detectEasyRpgEventsFromText(text);
  };

  const runtime = await probeEasyRpgRuntime();
  log('Runtime probe', runtime);

  if (!runtime.ready) {
    onStatus?.({
      state: 'waiting',
      message: 'WASM本体待ち',
      runtime,
    });
    return {
      runtime,
      started: false,
      stop: () => {},
    };
  }

  if (!gameArchive?.files?.length) {
    onStatus?.({
      state: 'waiting-game',
      message: 'ゲームを選択してください',
      runtime,
    });
    return {
      runtime,
      started: false,
      stop: () => {},
    };
  }

  onStatus?.({
    state: 'loading',
    message: 'EasyRPG本体を読み込み中',
    runtime,
  });
  log('Loading EasyRPG script', runtime.scriptPath);

  const manualZipBoot = Boolean(gameArchive?.files?.length);
  const moduleOptions = {
    ...(typeof window.Module === 'object' ? window.Module : {}),
    canvas,
    canvasContainer,
    game: undefined,
    noInitialRun: true,
    arguments: [GAME_ROOT],
    locateFile: (file) => (file.endsWith('.wasm') ? runtime.wasmPath : file),
    print: (...args) => logRuntimeText('[stdout]', args.join(' ')),
    printErr: (...args) => logRuntimeText('[stderr]', args.join(' ')),
    onAbort: (reason) => log('EasyRPG aborted', reason),
    setStatus: (message) => {
      log('EasyRPG status', message);
      onStatus?.({
        state: 'loading',
        message,
        runtime,
      });
    },
  };

  window.Module = moduleOptions;
  await loadScript(runtime.scriptPath);
  log('EasyRPG script loaded', runtime.scriptPath);

  const factory = window.createEasyRpgPlayer || window.EasyRPGPlayer || window.EasyRPG;
  log('EasyRPG factory', factory?.name || typeof factory);
  if (typeof factory === 'function') {
    const module = await factory(moduleOptions);
    log('EasyRPG module ready', {
      hasFS: Boolean(module.FS),
      hasMain: Boolean(module._main),
      noInitialRun: moduleOptions.noInitialRun,
      gameFiles: gameArchive.files.length,
      soundFont: soundFont?.name,
    });
    module.initApi?.();
    applySoundFontApi(module, soundFont, log);
    canvas?.focus?.();

    if (manualZipBoot) {
      mountGameArchive(module.FS, gameArchive);
      const soundFontPath = mountSoundFont(module.FS, soundFont);
      log('Mounted game archive', {
        root: GAME_ROOT,
        files: gameArchive.files.length,
        sample: gameArchive.files.slice(0, 8).map((file) => file.path),
        soundFontPath,
      });
      onStatus?.({
        state: 'mounting',
        message: `${GAME_ROOT} にゲームファイルを配置しました`,
        runtime,
        module,
      });
      const args = buildMainArgs(soundFontPath);
      callMain(module, args);
      log('Called EasyRPG main', args);
      window.setTimeout(() => applySoundFontApi(module, soundFont, log), 250);
    }

    onStatus?.({
      state: 'running',
      message: '実行中',
      runtime,
      module,
    });

    return {
      module,
      runtime,
      started: true,
      stop: () => stopEasyRpgModule(module),
    };
  }

  if (manualZipBoot) {
    mountGameArchive(window.Module?.FS || window.FS, gameArchive);
    const soundFontPath = mountSoundFont(window.Module?.FS || window.FS, soundFont);
    log('Mounted game archive via global Module', {
      root: GAME_ROOT,
      files: gameArchive.files.length,
      soundFontPath,
    });
    const args = buildMainArgs(soundFontPath);
    callMain(window.Module, args);
    log('Called EasyRPG main via global Module', args);
  }

  onStatus?.({
    state: 'running',
    message: 'EasyRPG本体を読み込み済み',
    runtime,
    module: window.Module,
  });

  return {
    module: window.Module,
    runtime,
    started: true,
    stop: () => stopEasyRpgModule(window.Module),
  };
}

function stopEasyRpgModule(module) {
  try {
    module?.pauseMainLoop?.();
  } catch {
    // Best effort shutdown.
  }

  try {
    module?.exit?.(0);
  } catch {
    // Emscripten exit may throw in the browser.
  }
}

function mountSoundFont(fs, soundFont) {
  if (!soundFont) {
    return '';
  }

  ensureDir(fs, SOUNDFONT_ROOT);
  const path = `${SOUNDFONT_ROOT}/${basename(soundFont.path)}`;
  try {
    fs.writeFile(path, soundFont.data);
  } catch (error) {
    throw enrichFsError(error, `FS write failed: ${path}`);
  }

  return path;
}

function applySoundFontApi(module, soundFont, log) {
  if (!soundFont) {
    return false;
  }

  const upload = module?.api_private?.uploadSoundfontStep2;
  if (typeof upload !== 'function') {
    log?.('SoundFont API not available', {
      hasApiPrivate: Boolean(module?.api_private),
      apiPrivateKeys: module?.api_private ? Object.keys(module.api_private) : [],
    });
    return false;
  }

  if (!module?._malloc || !module?._free || !module?.HEAPU8) {
    log?.('SoundFont API skipped: missing memory helpers');
    return false;
  }

  const pointer = module._malloc(soundFont.data.length);
  try {
    module.HEAPU8.set(soundFont.data, pointer);
    upload(soundFont.name, pointer, soundFont.data.length);
    module.api?.refreshScene?.();
    log?.('SoundFont applied via EasyRPG API', {
      name: soundFont.name,
      size: soundFont.size,
    });
    return true;
  } catch (error) {
    log?.('SoundFont API apply failed', {
      name: error?.name,
      message: error?.message || String(error),
      stack: error?.stack,
    });
    return false;
  } finally {
    module._free(pointer);
  }
}

function detectEasyRpgEventsFromText(text) {
  if (!text) {
    return;
  }

  const message = String(text);
  for (const pattern of RUNTIME_EVENT_LOG_PATTERNS) {
    const match = message.match(pattern.test);
    if (match) {
      emitEasyRpgEvent(pattern.build(message, match));
    }
  }
}

function normalizeRuntimeEventDetail(detail) {
  if (detail && typeof detail === 'object') {
    return {
      receivedAt: new Date().toISOString(),
      ...detail,
    };
  }

  return {
    receivedAt: new Date().toISOString(),
    name: String(detail || 'unknown'),
  };
}

function exposeEasyRpgEventBridge() {
  if (window.easyRpgEventBridge) {
    return;
  }

  window.easyRpgEventBridge = {
    emit: (detail) => emitEasyRpgEvent({
      source: 'manual',
      ...normalizeRuntimeEventDetail(detail),
    }),
  };
}

function buildMainArgs(soundFontPath) {
  const args = ['--project-path', GAME_ROOT];
  if (soundFontPath) {
    args.push('--soundfont', soundFontPath);
  }

  return args;
}

function mountGameArchive(fs, gameArchive) {
  if (!fs) {
    throw new Error('Emscripten FSが見つかりません');
  }

  ensureDir(fs, GAME_ROOT);

  gameArchive.files.forEach((file) => {
    const targetPath = `${GAME_ROOT}/${file.path}`;
    try {
      ensureDir(fs, dirname(targetPath));
      fs.writeFile(targetPath, file.data);
    } catch (error) {
      throw enrichFsError(error, `FS write failed: ${targetPath}`);
    }
  });
}

function callMain(module, args) {
  if (!module?._main || !module?._malloc || !module?.HEAPU8) {
    throw new Error('EasyRPG Module does not expose _main/_malloc/HEAPU8');
  }

  const encoder = new TextEncoder();
  const values = ['easyrpg-player', '--save-path', 'Save', ...args];
  const stringPointers = values.map((value) => {
    const bytes = encoder.encode(`${value}\0`);
    const pointer = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  });
  const argv = module._malloc((stringPointers.length + 1) * 4);
  const heapU32 = getHeapU32(module);
  stringPointers.forEach((pointer, index) => {
    heapU32[(argv >> 2) + index] = pointer;
  });
  heapU32[(argv >> 2) + stringPointers.length] = 0;

  try {
    module._main(stringPointers.length, argv);
  } catch (error) {
    if (error?.name !== 'ExitStatus') {
      throw error;
    }
  }
}

function getHeapU32(module) {
  if (module.HEAPU32) {
    return module.HEAPU32;
  }

  return new Uint32Array(module.HEAPU8.buffer);
}

function ensureDir(fs, path) {
  const parts = path.split('/').filter(Boolean);
  let current = '';

  parts.forEach((part) => {
    current += `/${part}`;
    if (fs.analyzePath?.(current).exists) {
      return;
    }

    try {
      fs.mkdir(current);
    } catch (error) {
      const alreadyExists = fs.analyzePath?.(current).exists
        || error?.code === 'EEXIST'
        || error?.errno === 20
        || /exists/i.test(error?.message || '');
      if (!alreadyExists) {
        throw enrichFsError(error, `FS mkdir failed: ${current}`);
      }
    }
  });
}

function enrichFsError(error, message) {
  const detail = [
    message,
    `name=${error?.name || 'Unknown'}`,
    `errno=${error?.errno ?? 'n/a'}`,
    `code=${error?.code || 'n/a'}`,
    `message=${error?.message || String(error)}`,
  ].join(' ');

  const enriched = new Error(detail);
  enriched.name = error?.name || 'FSError';
  enriched.stack = error?.stack || enriched.stack;
  return enriched;
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function basename(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function normalizeZipPath(path) {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function normalizeGameRoot(files) {
  const detectedRoot = findGameRoot(files);
  if (detectedRoot) {
    return files
      .filter((file) => file.path === detectedRoot || file.path.startsWith(`${detectedRoot}/`))
      .map((file) => ({
        ...file,
        path: file.path.slice(detectedRoot.length).replace(/^\/+/, ''),
      }))
      .filter((file) => file.path);
  }

  return stripSingleCommonRoot(files);
}

function findGameRoot(files) {
  const rootMarkers = ['RPG_RT.ldb', 'RPG_RT.lmt', 'RPG_RT.ini'];
  const markerFile = files.find((file) => {
    const name = basename(file.path).toLowerCase();
    return rootMarkers.some((marker) => marker.toLowerCase() === name);
  });

  if (!markerFile) {
    return '';
  }

  return dirname(markerFile.path).replace(/^\/+|\/+$/g, '');
}

function stripSingleCommonRoot(files) {
  const firstParts = files[0]?.path.split('/') || [];
  if (firstParts.length < 2) {
    return files;
  }

  const root = firstParts[0];
  const hasSharedRoot = files.every((file) => file.path.startsWith(`${root}/`));
  if (!hasSharedRoot) {
    return files;
  }

  return files.map((file) => ({
    ...file,
    path: file.path.slice(root.length + 1),
  }));
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isHtmlResponse(response) {
  return (response.headers.get('content-type') || '').includes('text/html');
}

function keyToCode(key) {
  if (key.startsWith('Arrow')) {
    return key;
  }

  return `Key${key.toUpperCase()}`;
}
