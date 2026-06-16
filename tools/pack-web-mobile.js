// UTF-8 BOM
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'web-mobile');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_HTML = path.join(OUTPUT_DIR, 'index.html');
const PACK_PLATFORMS = ['default', 'facebook', 'google', 'tiktok', 'applovin'];
const PACK_CONFIG = loadPackConfig();
const MINIFY_JS = process.env.MINIFY_JS !== '0';
const EXTREME_PACK = process.env.EXTREME_PACK !== '0';
const EXTREME_PACK_MIN_BYTES = 1024;
const OPTIMIZE_WEBP = process.env.OPTIMIZE_WEBP !== '0';
const WEBP_QUALITY = clampNumber(Number(process.env.WEBP_QUALITY || 70), 1, 100);
const WEBP_ALPHA_QUALITY = clampNumber(Number(process.env.WEBP_ALPHA_QUALITY || 60), 1, 100);
const WEBP_MIN_BYTES = Number(process.env.WEBP_MIN_BYTES || 4096);
const WEBP_ENCODER = process.env.WEBP_ENCODER || 'cwebp';
const APPLOVIN_CLICK_URL = process.env.APPLOVIN_CLICK_URL || PACK_CONFIG.applovinClickUrl || '';

function log(message) {
  console.log(`[pack] ${message}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function loadPackConfig() {
  const configPath = path.join(ROOT, 'tools', 'pack-config.json');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readText(configPath));
  } catch (err) {
    throw new Error(`读取打包配置失败: ${configPath}\n${err.message}`);
  }
}

async function step(label, fn) {
  const started = Date.now();
  log(`开始 ${label}`);
  try {
    const result = await fn();
    log(`完成 ${label} (${formatDuration(Date.now() - started)})`);
    return result;
  } catch (err) {
    log(`失败 ${label} (${formatDuration(Date.now() - started)})`);
    throw err;
  }
}

function askQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function selectPlatform() {
  const envPlatform = (process.env.PACK_PLATFORM || '').trim().toLowerCase();
  if (envPlatform === 'all' || envPlatform === '6') {
    return 'all';
  }
  if (envPlatform === 'default' || envPlatform === '1') {
    return 'default';
  }
  if (envPlatform === 'facebook' || envPlatform === '2') {
    return 'facebook';
  }
  if (envPlatform === 'google' || envPlatform === '3') {
    return 'google';
  }
  if (envPlatform === 'tiktok' || envPlatform === '4') {
    return 'tiktok';
  }
  if (envPlatform === 'applovin' || envPlatform === '5') {
    return 'applovin';
  }
  console.log('请选择打包平台：');
  console.log('1. MTG');
  console.log('2. facebook');
  console.log('3. 谷歌');
  console.log('4. TikTok');
  console.log('5. AppLovin');
  console.log('6. 一键全打包');
  const answer = (await askQuestion('请输入序号，直接回车默认选择 1（MTG）：')).trim();
  if (answer === '2') return 'facebook';
  if (answer === '3') return 'google';
  if (answer === '4') return 'tiktok';
  if (answer === '5') return 'applovin';
  if (answer === '6') return 'all';
  return 'default';
}

function platformLabel(platform) {
  if (platform === 'facebook') return 'facebook';
  if (platform === 'google') return '谷歌';
  if (platform === 'tiktok') return 'TikTok';
  if (platform === 'applovin') return 'AppLovin';
  return 'MTG';
}

function platformOutputName(platform) {
  if (platform === 'default') return 'MTG';
  return platform;
}

function readText(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }
  return text;
}

function escapeScriptContent(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003C');
}

function lzwBase64(text) {
  const input = Buffer.from(text, 'utf8');
  const dict = new Map();
  for (let i = 0; i < 256; i++) {
    dict.set(String.fromCharCode(i), i);
  }
  const codes = [];
  let phrase = '';
  let nextCode = 256;
  for (let i = 0; i < input.length; i++) {
    const ch = String.fromCharCode(input[i]);
    const combo = phrase + ch;
    if (dict.has(combo)) {
      phrase = combo;
    } else {
      codes.push(dict.get(phrase));
      dict.set(combo, nextCode++);
      phrase = ch;
    }
  }
  if (phrase) {
    codes.push(dict.get(phrase));
  }
  let maxCode = 0;
  for (const code of codes) {
    if (code > maxCode) maxCode = code;
  }
  const bits = Math.max(9, Math.ceil(Math.log2(maxCode + 1)));
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const code of codes) {
    bitBuffer += code * Math.pow(2, bitCount);
    bitCount += bits;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 255);
      bitBuffer = Math.floor(bitBuffer / 256);
      bitCount -= 8;
    }
  }
  if (bitCount > 0) {
    bytes.push(bitBuffer & 255);
  }
  return `${bits},${codes.length}:${Buffer.from(bytes).toString('base64')}`;
}

function plainScript(name, js) {
  const rawSize = Buffer.byteLength(js, 'utf8');
  return { name, js, packed: false, rawSize, packedSize: rawSize };
}

function packScript(name, js) {
  const rawSize = Buffer.byteLength(js, 'utf8');
  if (!EXTREME_PACK || rawSize < EXTREME_PACK_MIN_BYTES) {
    return plainScript(name, js);
  }
  const data = lzwBase64(js);
  const packedSize = Buffer.byteLength(data, 'utf8');
  if (packedSize >= rawSize) {
    log(`极限压缩跳过 ${name}: ${formatMB(rawSize)} -> ${formatMB(packedSize)}，未变小`);
    return plainScript(name, js);
  }
  return { name, data, packed: true, rawSize, packedSize };
}

function renderScriptFunction(fnName, entry) {
  if (entry.packed) {
    return `function ${fnName}(){\n  return runPackedScript(${JSON.stringify(entry.name)});\n}`;
  }
  return `function ${fnName}(){\n${escapeScriptContent(entry.js)}\n  return true;\n}`;
}

function renderScriptBody(entry) {
  if (entry.packed) {
    return `  return runPackedScript(${JSON.stringify(entry.name)});`;
  }
  return `${escapeScriptContent(entry.js)}\n  return true;`;
}

function renderHeadPlatformScripts(platform) {
  if (platform !== 'google') {
    return '';
  }
  return `
  <script type="text/javascript" src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"> </script>
`;
}

function renderTikTokSdk(platform) {
  if (platform !== 'tiktok') {
    return '';
  }
  return `
  <script src="https://sf16-muse-va.ibytedtos.com/obj/union-fe-nc-i18n/Playable/sdk/Playable-sdk.js"></script>
`;
}

function renderGoogleRuntimeShim(platform) {
  if (platform !== 'google') {
    return '';
  }
  return `
  <script>
    window.install = function () {
      if (window.ExitApi && typeof window.ExitApi.exit === 'function') {
        window.ExitApi.exit();
        return;
      }
      console.error('ExitApi.exit is not available');
    };
  </script>
`;
}

function renderAppLovinRuntimeShim(platform) {
  if (platform !== 'applovin') {
    return '';
  }
  return `
  <script>
    (function installAppLovinRuntimeShim() {
      var clickUrl = ${safeJson(APPLOVIN_CLICK_URL)};
      window.APPLOVIN_CLICK_URL = clickUrl;
      window.install = function () {
        if (!clickUrl) {
          console.error('APPLOVIN_CLICK_URL is empty');
          return;
        }
        if (window.mraid && typeof window.mraid.open === 'function') {
          window.mraid.open(clickUrl);
          return;
        }
        console.error('mraid.open is not available');
      };
    })();
  </script>
`;
}

function renderFacebookRuntimeShim(platform) {
  if (platform !== 'facebook') {
    return '';
  }
  return `
  <script>
    (function installFacebookRuntimeGuards() {
      function dataUriToArrayBuffer(dataURI) {
        var comma = dataURI.indexOf(',');
        var meta = dataURI.slice(0, comma);
        var data = dataURI.slice(comma + 1);
        var binary = meta.indexOf(';base64') >= 0 ? atob(data) : decodeURIComponent(data);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
      }

      function makeInlineBinaryResponse(dataURI) {
        var buffer = dataUriToArrayBuffer(dataURI);
        return new Response(buffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        });
      }

      function resolveInlineBinary(input) {
        if (!input) return '';
        var key = String(input);
        if (key.indexOf('data:') === 0) return key;
        var keys = [key];
        try {
          keys.push(new URL(key, window.location.href).pathname.replace(/^\\/+/, ''));
        } catch (err) {}
        var name = key.split('?')[0].split('#')[0].split('/').pop();
        if (name) {
          keys.push(name);
          if (name.indexOf('spine.js.mem') === 0) {
            keys.push('spine.js.mem');
            keys.push('assets/spine.js.mem');
          }
          if (name.indexOf('spine.wasm') === 0) {
            keys.push('spine.wasm');
            keys.push('assets/spine.wasm');
          }
        }
        for (var i = 0; i < keys.length; i++) {
          var candidate = String(keys[i]).split('?')[0].split('#')[0].replace(/^\\/+/, '');
          if (!candidate) continue;
          if (window.wasmMap && window.wasmMap[candidate]) {
            return window.wasmMap[candidate];
          }
          var assetIndex = candidate.lastIndexOf('assets/');
          if (assetIndex >= 0) {
            candidate = candidate.slice(assetIndex);
            if (window.wasmMap && window.wasmMap[candidate]) {
              return window.wasmMap[candidate];
            }
          }
        }
        return '';
      }

      window.fbPlayableCTAClick = function () {
        if (window.FbPlayableAd && typeof window.FbPlayableAd.onCTAClick === 'function') {
          window.FbPlayableAd.onCTAClick();
        }
      };

      var nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function') {
        window.fetch = function (input, init) {
          var url = typeof input === 'string' ? input : input && input.url;
          var wasmValue = resolveInlineBinary(url);
          if (wasmValue) {
            return Promise.resolve(makeInlineBinaryResponse(wasmValue));
          }
          return nativeFetch.apply(this, arguments);
        };
      }

      var NativeXMLHttpRequest = window.XMLHttpRequest;
      if (typeof NativeXMLHttpRequest === 'function') {
        window.XMLHttpRequest = function () {
          var xhr = new NativeXMLHttpRequest();
          var method = 'GET';
          var url = '';
          var async = true;
          var headers = {};
          var intercepted = false;
          var listeners = {};
          var responseType = '';
          var response = null;
          var responseText = '';
          var readyState = 0;
          var status = 0;
          var statusText = '';
          var eventHandlers = {};

          function notify(type) {
            var event = { type: type, target: proxy, currentTarget: proxy };
            var handler = eventHandlers[type];
            if (typeof handler === 'function') handler.call(proxy, event);
            var list = listeners[type] || [];
            for (var i = 0; i < list.length; i++) {
              list[i].call(proxy, event);
            }
          }

          function setReadyState(value) {
            readyState = value;
            notify('readystatechange');
          }

          function completeWithInlineData(dataURI) {
            intercepted = true;
            status = 200;
            statusText = 'OK';
            setReadyState(2);
            setReadyState(3);
            var buffer = dataUriToArrayBuffer(dataURI);
            if (responseType === 'blob') {
              response = new Blob([buffer], { type: 'application/octet-stream' });
            } else if (responseType === 'text' || responseType === '') {
              responseText = atob(dataURI.split(',')[1]);
              response = responseText;
            } else {
              response = buffer;
            }
            setReadyState(4);
            notify('load');
            notify('loadend');
          }

          var proxy = {
            open: function (nextMethod, nextUrl, nextAsync) {
              method = nextMethod || 'GET';
              url = nextUrl || '';
              async = nextAsync !== false;
              var dataURI = resolveInlineBinary(url);
              intercepted = !!dataURI;
              if (!intercepted) {
                return xhr.open.apply(xhr, arguments);
              }
              setReadyState(1);
            },
            send: function () {
              var dataURI = resolveInlineBinary(url);
              if (!dataURI) {
                return xhr.send.apply(xhr, arguments);
              }
              var run = function () { completeWithInlineData(dataURI); };
              if (async) setTimeout(run, 0);
              else run();
            },
            abort: function () {
              if (!intercepted) return xhr.abort();
              status = 0;
              statusText = '';
              notify('abort');
              notify('loadend');
            },
            setRequestHeader: function (name, value) {
              headers[name] = value;
              if (!intercepted) xhr.setRequestHeader(name, value);
            },
            getResponseHeader: function (name) {
              if (!intercepted) return xhr.getResponseHeader(name);
              return String(name).toLowerCase() === 'content-type' ? 'application/octet-stream' : null;
            },
            getAllResponseHeaders: function () {
              if (!intercepted) return xhr.getAllResponseHeaders();
              return 'content-type: application/octet-stream\\r\\n';
            },
            overrideMimeType: function (mime) {
              if (!intercepted && xhr.overrideMimeType) xhr.overrideMimeType(mime);
            },
            addEventListener: function (type, handler) {
              if (!listeners[type]) listeners[type] = [];
              listeners[type].push(handler);
              if (!intercepted) xhr.addEventListener(type, handler);
            },
            removeEventListener: function (type, handler) {
              var list = listeners[type] || [];
              var index = list.indexOf(handler);
              if (index >= 0) list.splice(index, 1);
              if (!intercepted) xhr.removeEventListener(type, handler);
            },
            dispatchEvent: function (event) {
              if (!intercepted) return xhr.dispatchEvent(event);
              notify(event.type);
              return true;
            }
          };

          Object.defineProperties(proxy, {
            readyState: { get: function () { return intercepted ? readyState : xhr.readyState; } },
            status: { get: function () { return intercepted ? status : xhr.status; } },
            statusText: { get: function () { return intercepted ? statusText : xhr.statusText; } },
            response: { get: function () { return intercepted ? response : xhr.response; } },
            responseText: { get: function () { return intercepted ? responseText : xhr.responseText; } },
            responseType: {
              get: function () { return intercepted ? responseType : xhr.responseType; },
              set: function (value) {
                responseType = value || '';
                if (!intercepted) xhr.responseType = value;
              }
            },
            timeout: {
              get: function () { return xhr.timeout; },
              set: function (value) { xhr.timeout = value; }
            },
            withCredentials: {
              get: function () { return xhr.withCredentials; },
              set: function (value) { xhr.withCredentials = value; }
            }
          });

          ['readystatechange', 'load', 'error', 'abort', 'loadend', 'progress', 'timeout'].forEach(function (type) {
            Object.defineProperty(proxy, 'on' + type, {
              get: function () { return eventHandlers[type] || null; },
              set: function (handler) {
                eventHandlers[type] = handler;
                xhr['on' + type] = handler;
              }
            });
          });

          return proxy;
        };
      }

      function installSafeGamepad(name) {
        if (!(name in navigator)) return;
        try {
          if (typeof navigator[name] === 'function') {
            navigator[name]();
          }
        } catch (err) {
          try {
            Object.defineProperty(navigator, name, {
              configurable: true,
              value: function () { return []; }
            });
          } catch (defineErr) {}
        }
      }

      installSafeGamepad('getGamepads');
      installSafeGamepad('webkitGetGamepads');
    })();
  </script>
`;
}

function renderBodyPlatformShim(platform) {
  return `${renderFacebookRuntimeShim(platform)}${renderGoogleRuntimeShim(platform)}${renderAppLovinRuntimeShim(platform)}`;
}

function loadTerser() {
  try {
    return require('terser');
  } catch (err) {
    return null;
  }
}

function minifyJsWithNpx(text, label) {
  const args = ['-y', 'terser', '--compress', '--mangle', '--comments', 'false'];
  const result = spawnSync('npx', args, {
    input: text,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`minify failed (${label}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`minify failed (${label}): ${stderr || 'npx terser error'}`);
  }
  return result.stdout || text;
}

async function minifyJs(text, label) {
  const inputSize = Buffer.byteLength(text, 'utf8');
  if (!MINIFY_JS) {
    log(`跳过压缩 ${label} (${formatBytes(inputSize)})`);
    return text;
  }
  const started = Date.now();
  log(`压缩 ${label} (${formatBytes(inputSize)})`);
  const terser = loadTerser();
  let code;
  if (terser && typeof terser.minify === 'function') {
    const result = await terser.minify(text, {
      compress: true,
      mangle: true,
      format: { comments: false }
    });
    if (!result || !result.code) {
      throw new Error(`minify failed (${label}): empty output`);
    }
    code = result.code;
  } else {
    log(`本地 terser 不存在，使用 npx terser 压缩 ${label}`);
    code = minifyJsWithNpx(text, label);
  }
  log(`压缩完成 ${label}: ${formatBytes(inputSize)} -> ${formatBytes(Buffer.byteLength(code, 'utf8'))} (${formatDuration(Date.now() - started)})`);
  return code;
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out;
}

function mimeFor(ext) {
  switch (ext) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.bin': return 'application/octet-stream';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function createWebpStats() {
  return {
    enabled: OPTIMIZE_WEBP,
    quality: WEBP_QUALITY,
    alphaQuality: WEBP_ALPHA_QUALITY,
    minBytes: WEBP_MIN_BYTES,
    attempted: 0,
    converted: 0,
    skippedSmall: 0,
    failed: 0,
    rawBytes: 0,
    webpBytes: 0
  };
}

let webpEncoderWarningShown = false;

function encodePngToWebp(filePath, inputSize, webpStats) {
  if (!OPTIMIZE_WEBP || inputSize < WEBP_MIN_BYTES) {
    if (OPTIMIZE_WEBP && inputSize < WEBP_MIN_BYTES) {
      webpStats.skippedSmall++;
    }
    return null;
  }

  webpStats.attempted++;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-webp-'));
  const outPath = path.join(tempDir, `${path.basename(filePath)}.webp`);
  try {
    const result = spawnSync(WEBP_ENCODER, [
      '-quiet',
      '-q',
      String(WEBP_QUALITY),
      '-alpha_q',
      String(WEBP_ALPHA_QUALITY),
      filePath,
      '-o',
      outPath
    ], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (result.error) {
      if (!webpEncoderWarningShown) {
        log(`WebP 编码器不可用，跳过图片优化: ${result.error.message}`);
        webpEncoderWarningShown = true;
      }
      webpStats.failed++;
      return null;
    }
    if (result.status !== 0 || !fs.existsSync(outPath)) {
      webpStats.failed++;
      return null;
    }

    const webp = fs.readFileSync(outPath);
    if (webp.length >= inputSize) {
      return null;
    }

    webpStats.converted++;
    webpStats.rawBytes += inputSize;
    webpStats.webpBytes += webp.length;
    return webp;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildInlineAsset(filePath, ext, webpStats) {
  const bin = fs.readFileSync(filePath);
  if (ext === '.png') {
    const webp = encodePngToWebp(filePath, bin.length, webpStats);
    if (webp) {
      return `data:image/webp;base64,${webp.toString('base64')}`;
    }
  }
  return `data:${mimeFor(ext)};base64,${bin.toString('base64')}`;
}

function buildResMap() {
  const assetsRoot = path.join(INPUT_DIR, 'assets');
  const bundleNames = fs.readdirSync(assetsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const files = walkFiles(assetsRoot);
  const resMap = {};
  const webpStats = createWebpStats();
  for (const filePath of files) {
    const rel = path.relative(assetsRoot, filePath).split(path.sep).join('/');
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.js') {
      // bundle index.js 通过 loadCCIndex 内联
      continue;
    }
  if (ext === '.json' || ext === '.atlas' || ext === '.plist') {
    resMap[rel] = readText(filePath);
  } else {
    resMap[rel] = buildInlineAsset(filePath, ext, webpStats);
    if (rel.startsWith('native/')) {
      resMap[rel.replace(/^native\//, 'import/')] = resMap[rel];
    }
  }
  }
  return { resMap, bundleNames, webpStats };
}

function addWasmAlias(wasmMap, key, value) {
  if (key && !wasmMap[key]) {
    wasmMap[key] = value;
  }
}

function buildWasmMap(platform) {
  const wasmRoot = path.join(INPUT_DIR, 'cocos-js', 'assets');
  if (!fs.existsSync(wasmRoot)) return {};
  const files = walkFiles(wasmRoot);
  const wasmMap = {};
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.bin' && ext !== '.wasm') continue;
    const rel = path.relative(wasmRoot, filePath).split(path.sep).join('/');
    const key = `assets/${rel}`;
    const bin = fs.readFileSync(filePath);
    const b64 = bin.toString('base64');
    const value = `data:${mimeFor(ext)};base64,${b64}`;
    wasmMap[key] = value;
    if (platform === 'facebook') {
      const baseName = path.basename(filePath);
      addWasmAlias(wasmMap, rel, value);
      addWasmAlias(wasmMap, baseName, value);
      addWasmAlias(wasmMap, `cocos-js/assets/${rel}`, value);
      if (baseName.startsWith('spine.js.mem')) {
        addWasmAlias(wasmMap, 'spine.js.mem', value);
        addWasmAlias(wasmMap, 'assets/spine.js.mem', value);
        addWasmAlias(wasmMap, 'cocos-js/assets/spine.js.mem', value);
      }
      if (baseName.startsWith('spine.wasm')) {
        addWasmAlias(wasmMap, 'spine.wasm', value);
        addWasmAlias(wasmMap, 'assets/spine.wasm', value);
        addWasmAlias(wasmMap, 'cocos-js/assets/spine.wasm', value);
      }
    }
  }
  return wasmMap;
}

function buildLoadCCIndex() {
  const assetsRoot = path.join(INPUT_DIR, 'assets');
  const files = walkFiles(assetsRoot)
    .filter(p => path.basename(p) === 'index.js')
    .sort();
  const parts = [];
  for (const filePath of files) {
    parts.push(readText(filePath));
  }
  return parts.join('\n');
}

function readJs(relPath) {
  return readText(path.join(INPUT_DIR, relPath));
}

function buildSettings() {
  const settings = JSON.parse(readText(path.join(INPUT_DIR, 'src', 'settings.json')));
  const effectPath = settings.rendering && settings.rendering.effectSettingsPath;
  if (effectPath) {
    const filePath = path.join(INPUT_DIR, effectPath);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const b64 = fs.readFileSync(filePath).toString('base64');
      settings.rendering.effectSettingsPath = `data:${mimeFor(ext)};base64,${b64}`;
    }
  }
  return settings;
}

async function buildPlatform(platform, outputHtml) {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error('Input not found:', INPUT_DIR);
    process.exit(1);
  }

  const totalStarted = Date.now();
  log(`输入目录: ${INPUT_DIR}`);
  log(`输出文件: ${outputHtml}`);
  log(`打包平台: ${platformLabel(platform)}`);
  log(`JS 压缩: ${MINIFY_JS ? '开启' : '关闭'}`);
  log(`极限压缩: ${EXTREME_PACK ? '开启' : '关闭'}`);
  log(`WebP 图片优化: ${OPTIMIZE_WEBP ? `开启，quality=${WEBP_QUALITY}, alpha=${WEBP_ALPHA_QUALITY}, min=${formatBytes(WEBP_MIN_BYTES)}` : '关闭'}`);

  const styleCss = await step('读取 style.css', () => readText(path.join(INPUT_DIR, 'style.css')));
  const polyfills = await step('处理 polyfills.bundle.js', () => minifyJs(readJs(path.join('src', 'polyfills.bundle.js')), 'polyfills.bundle.js'));
  const systemjs = await step('处理 system.bundle.js', () => minifyJs(readJs(path.join('src', 'system.bundle.js')), 'system.bundle.js'));

  const settings = await step('处理 settings.json', () => buildSettings());

  const { resMap, bundleNames, webpStats } = await step('内联 assets 资源', () => buildResMap());
  log(`资源 bundle: ${bundleNames.join(', ') || '无'}, 文件数: ${Object.keys(resMap).length}`);
  if (webpStats.enabled) {
    const savedBytes = webpStats.rawBytes - webpStats.webpBytes;
    log(`WebP 优化: 尝试 ${webpStats.attempted} 张，转换 ${webpStats.converted} 张，小图跳过 ${webpStats.skippedSmall} 张，失败 ${webpStats.failed} 张，节省 ${formatBytes(savedBytes)}`);
  }
  const wasmMap = await step('内联 wasm/bin 资源', () => buildWasmMap(platform));
  log(`wasm/bin 文件数: ${Object.keys(wasmMap).length}`);

  const loadCCIndex = packScript('bundle-index.js', await step('处理 bundle index.js', () => minifyJs(buildLoadCCIndex(), 'loadCCIndex')));

  const indexJs = packScript('index.js', await step('处理 index.js', () => minifyJs(readText(path.join(INPUT_DIR, 'index.js')), 'index.js')));
  const bundleJs = packScript('bundle.js', await step('处理 bundle.js', () => minifyJs(readText(path.join(INPUT_DIR, 'src', 'chunks', 'bundle.js')), 'bundle.js')));
  const ccJs = packScript('cc.js', await step('处理 cc.js', () => minifyJs(readText(path.join(INPUT_DIR, 'cocos-js', 'cc.js')), 'cc.js')));

  const spineFiles = fs.readdirSync(path.join(INPUT_DIR, 'cocos-js'))
    .filter(name => name.startsWith('spine') && name.endsWith('.js'))
    .sort();

  log(`spine loader 文件数: ${spineFiles.length}`);
  log('spine loader 保持同步内联，避免 System.register 并发加载顺序被打乱');
  const spineLoaders = await step('处理 spine loader', () => Promise.all(spineFiles.map(async (name) => {
    const fnName = 'load' + name.replace(/[^a-zA-Z0-9]/g, '');
    let js = readText(path.join(INPUT_DIR, 'cocos-js', name));
    const memMatch = js.match(/assets\/spine\.js\.mem-[^"']+\.bin/);
    if (memMatch) {
      const memPath = memMatch[0];
      js = `System.register([],(function(e){\"use strict\";return{execute:function(){e(\"default\",window.wasmMap[${JSON.stringify(memPath)}])}}}));`;
    }
    js = await minifyJs(js, name);
    return { name, fnName, script: plainScript(name, js) };
  })));
  const packedEntries = [loadCCIndex, indexJs, bundleJs, ccJs].filter(s => s.packed);
  if (packedEntries.length) {
    packedEntries.forEach((entry) => {
      log(`极限压缩 ${entry.name}: ${formatMB(entry.rawSize)} -> ${formatMB(entry.packedSize)}`);
    });
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Playable Ads</title>
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1, minimum-scale=1,maximum-scale=1" />
${renderHeadPlatformScripts(platform)}
  <style>
    #loading-zone {
      position: absolute;
      z-index: 10;
      background-color: #444;
      width: 100%;
      height: 100%;
      color: #ccc;
    }
  </style>
  <style>
${styleCss}
  </style>
</head>
<body>
  <div id="loading-zone" aria-busy="true" style="visibility: hidden;">
    <div style="position: absolute;top: 20%;left: 31%;height: 40%;right: 31%;">
      <p>Loading...</p>
      <div class="card">
        <label>
          <progress indeterminate="" role="progressbar" id="loading-value" value="90" max="100"
            aria-describedby="loading-zone" tabindex="-1"></progress>
        </label>
      </div>
    </div>
  </div>
  <script>
    window.progress = document.getElementById("loading-value");
    window.progress.value = 5;
  </script>
  <div id="GameDiv" cc_exact_fit_screen="true">
    <div id="Cocos3dGameContainer">
      <canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="99"></canvas>
    </div>
  </div>
${renderTikTokSdk(platform)}

  <script>
${escapeScriptContent(polyfills)}
  </script>

  <script>
${escapeScriptContent(systemjs)}
  </script>

  <script type="systemjs-importmap">{"imports": {"cc": "./cocos-js/cc.js"}}</script>

  <script>
    window.progress.value = 5;
  </script>

  <script>
    window.wasmMap = ${safeJson(wasmMap)};
    window.resMap = ${safeJson(resMap)};
    window.bundleNames = ${safeJson(bundleNames)};
    window.isZip = false;
  </script>

  <script>
    function loadCCIndex(){
${renderScriptBody(loadCCIndex)}
    }
  </script>

  <script>
    window._CCSettings = ${safeJson(settings)};
  </script>

  <script>
class HookURL {
    constructor(url, base) {
        this.origin = new URL(url, base);
        if (url.endsWith(".wasm")) {
            if (window.wasmMap.hasOwnProperty(url)) {
                let wasm_str = window.wasmMap[url];
                this.href = wasm_str;
            }
            else {
                let new_url = this.origin.href;
                new_url = new_url.replace("cocos-js/assets", "merge-assets");
                this.href = new_url;
            }
        }
        else
            this.href = this.origin.href;
    }
}
  </script>

  <script>
function dataURItoBlob(dataURI) {
  var byteString = atob(dataURI.split(',')[1]);
  var mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
  var ab = new ArrayBuffer(byteString.length);
  var ia = new Uint8Array(ab);
  for (var i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new Blob([ab], { type: mimeString });
}

function resolveAssetName(url) {
  if (!url) return url;
  var clean = String(url).split('?')[0].split('#')[0];
  if (clean.startsWith('data:')) return clean;
  try {
    if (clean.startsWith('file:') || clean.startsWith('http:') || clean.startsWith('https:')) {
      clean = new URL(clean).pathname || clean;
    }
  } catch (e) {}
  clean = clean.replace(/^\\/+/, '');
  var idx = clean.lastIndexOf('/assets/');
  if (idx >= 0) {
    clean = clean.slice(idx + 8);
  }
  if (clean.startsWith('assets/')) {
    clean = clean.slice(7);
  }
  if (window.resMap && window.resMap[clean] !== undefined) {
    return clean;
  }
  var candidates = [];
  if (window.currentBundle) candidates.push(window.currentBundle);
  if (window.bundleNames && window.bundleNames.length) {
    for (var i = 0; i < window.bundleNames.length; i++) {
      candidates.push(window.bundleNames[i]);
    }
  }
  for (var j = 0; j < candidates.length; j++) {
    var pref = candidates[j] + '/' + clean;
    if (window.resMap && window.resMap[pref] !== undefined) {
      return pref;
    }
  }
  return clean;
}

function downloadFile(url, options, onProgress, onComplete) {
  var assetName = resolveAssetName(url);
  var base64 = window.resMap[assetName];
  if (base64 === undefined) {
    console.error('Missing asset in resMap:', url, '->', assetName);
  }
  if (options.xhrResponseType === 'json') {
    try {
      onComplete(null, JSON.parse(base64));
    } catch (err) {
      onComplete(err);
    }
    return;
  }
  if (options.xhrResponseType === 'text') {
    onComplete(null, base64);
    return;
  }
  var blob = dataURItoBlob(base64);
  if (options.xhrResponseType === 'arraybuffer')
    blob.arrayBuffer().then(result => {
      onComplete(null, result);
    })
  else if (options.xhrResponseType === 'blob')
    onComplete(null, blob);
}

function downloadDomImage(url, options, onComplete) {
  var img = new Image();
  if (window.location.protocol !== 'file:') {
    img.crossOrigin = 'anonymous';
  }
  function loadCallback() {
    img.removeEventListener('load', loadCallback);
    img.removeEventListener('error', errorCallback);
    if (onComplete) {
      onComplete(null, img);
    }
  }
  function errorCallback() {
    img.removeEventListener('load', loadCallback);
    img.removeEventListener('error', errorCallback);
    if (onComplete) {
      onComplete(new Error(getError(4930, url)));
    }
  }
  img.addEventListener('load', loadCallback);
  img.addEventListener('error', errorCallback);
  var assetName = resolveAssetName(url);
  var base64 = window.resMap[assetName];
  if (base64 === undefined) {
    console.error('Missing image in resMap:', url, '->', assetName);
  }
  img.src = base64;
  return img;
}

function downloadBlob(url, options, onComplete) {
  options.xhrResponseType = 'blob';
  downloadFile(url, options, options.onFileProgress, onComplete);
}

function downloadJson(url, options, onComplete) {
  options.xhrResponseType = 'json';
  downloadFile(url, options, options.onFileProgress, onComplete);
}

function downloadText(url, options, onComplete) {
  options.xhrResponseType = 'text';
  downloadFile(url, options, options.onFileProgress, onComplete);
}

function downloadArrayBuffer(url, options, onComplete) {
  options.xhrResponseType = 'arraybuffer';
  downloadFile(url, options, options.onFileProgress, onComplete);
}

var downloaded = {};
function downloadScript(url, options, onComplete) {
  if (downloaded[url]) {
    if (onComplete) {
      onComplete(null);
    }
    return null;
  }
  if (url.indexOf("index.js") > 0) {
    loadCCIndex();
    downloaded[url] = true;
    onComplete(null);
  }
}

function downloadBundle(nameOrUrl, options, onComplete) {
  window.currentBundle = nameOrUrl;
  var config = nameOrUrl + "/config.json";
  var count = 0;
  var out = null;
  var error = null;
  downloadJson(config, options, function (err, response) {
    error = err;
    out = response;
    if (out) {
      out.base = "assets/";
    }
    if (++count === 2) {
      onComplete(error, out);
    }
  });
  var jspath = "/index.js";
  downloadScript(jspath, options, function (err) {
    error = err;
    if (++count === 2) {
      onComplete(err, out);
    }
  });
}

var oldHook;
function downloadAudio(url, options, onComplete) {
  var ext;
  if (url) {
    var path = resolveAssetName(url);
    ext = url.slice(-4);
    url = window.resMap[path];
    if (!url && path && path.indexOf('native/') === 0) {
      var alt = path.replace(/^native\\//, 'import/');
      url = window.resMap[alt];
    }
  }
  if (ext) {
    oldHook[ext](url, options, onComplete);
  }
  else {
    onComplete();
  }
}

function downloadCCONB(url, options, onComplete) {
  downloadArrayBuffer(url, options, function (err, arrayBuffer) {
    if (err) {
      onComplete(err);
      return;
    }
    try {
      var ccon = cc.internal.decodeCCONBinary(new Uint8Array(arrayBuffer));
      onComplete(null, ccon);
    } catch (err) {
      onComplete(err);
    }
  });
}

window.hook = function (cc) {
  cc.assetManager.downloader.register('.bin', downloadArrayBuffer);
  cc.assetManager.downloader.register('.cconb', downloadCCONB);
  cc.assetManager.downloader.register('.png', downloadDomImage);
  cc.assetManager.downloader.register('.webp', downloadDomImage);
  cc.assetManager.downloader.register('.jpg', downloadDomImage);
  cc.assetManager.downloader.register('.gif', downloadDomImage);
  cc.assetManager.downloader.register('.json', downloadJson);
  cc.assetManager.downloader.register('.js', downloadScript);
  cc.assetManager.downloader.register('.plist', downloadText);
  cc.assetManager.downloader.register('bundle', downloadBundle);
  if (!oldHook) {
    oldHook = {
      ".mp3": cc.assetManager.downloader._downloaders[".mp3"],
      ".wav": cc.assetManager.downloader._downloaders[".wav"],
      ".ogg": cc.assetManager.downloader._downloaders[".ogg"],
      ".m4a": cc.assetManager.downloader._downloaders[".m4a"]
    };
  }
  cc.assetManager.downloader.register('.mp3', downloadAudio);
  cc.assetManager.downloader.register('.wav', downloadAudio);
  cc.assetManager.downloader.register('.ogg', downloadAudio);
  cc.assetManager.downloader.register('.m4a', downloadAudio);
}
  </script>

  <script>
function loadMyBundle(){
${renderScriptBody(bundleJs)}
}

function loadApplication(){
  System.register([], function (_export, _context) {
    "use strict";
    var cc, Application;
    function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
    function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
    function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
    function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
    function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }
    function _toPrimitive(input, hint) { if (_typeof(input) !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (_typeof(res) !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }
    return {
      setters: [],
      execute: function () {
        _export("Application", Application = /*#__PURE__*/function () {
          function Application() {
            _classCallCheck(this, Application);
            this.settingsPath = '';
            this.showFPS = false;
          }
          _createClass(Application, [{
            key: "init",
            value: function init(engine) {
              window.progress.value = 40;
              cc = engine;
              cc.game.onPostBaseInitDelegate.add(this.onPostInitBase.bind(this));
              cc.game.onPostSubsystemInitDelegate.add(this.onPostSystemInit.bind(this));
              hook(cc);
            }
          }, {
            key: "onPostInitBase",
            value: function onPostInitBase() {
              // cc.settings.overrideSettings('assets', 'server', '');
              // do custom logic
              cc.settings._settings = window._CCSettings;
            }
          }, {
            key: "onPostSystemInit",
            value: function onPostSystemInit() {
              // do custom logic
            }
          }, {
            key: "start",
            value: function start() {
              return cc.game.init({
                debugMode: false ? cc.DebugMode.INFO : cc.DebugMode.ERROR,
                settingsPath: this.settingsPath,
                overrideSettings: {
                  profiling: {
                    showFPS: this.showFPS
                  }
                }
              }).then(function () {
                var pkgs = window._CCSettings && window._CCSettings.scripting && window._CCSettings.scripting.scriptPackages || [];
                if (pkgs.length > 0) {
                  return Promise.all(pkgs.map(function (p) {
                    return System.import(p);
                  }));
                }
              }).then(function () {
                window.progress.value = 50;
                var launchScene = window._CCSettings.launch.launchScene;
                return cc.director.preloadScene(launchScene, function (count) {
                  if (window.progress) {
                    window.progress.value = 50 + count / 5;
                  }
                }, function () {
                  return cc.game.run(function () {
                    window.progress.value = 100;
                    document.getElementById("loading-zone").style.display = "none";
                  });
                });
              });
            }
          }]);
          return Application;
        }());
      }
    };
  });
}

window.packedScripts = ${safeJson(Object.fromEntries(packedEntries.map(entry => [entry.name, entry.data])))};

function packedDataToCodes(data) {
  var split = data.indexOf(':');
  var header = data.slice(0, split).split(',');
  var bits = Number(header[0]);
  var codeCount = Number(header[1]);
  var binary = atob(data.slice(split + 1));
  var codes = [];
  var bitBuffer = 0;
  var bitCount = 0;
  var pow = Math.pow(2, bits);
  for (var i = 0; i < binary.length; i++) {
    bitBuffer += binary.charCodeAt(i) * Math.pow(2, bitCount);
    bitCount += 8;
    while (bitCount >= bits) {
      codes.push(bitBuffer % pow);
      if (codes.length === codeCount) return codes;
      bitBuffer = Math.floor(bitBuffer / pow);
      bitCount -= bits;
    }
  }
  return codes;
}

function decodePackedScript(data) {
  var codes = packedDataToCodes(data);
  var dict = new Array(256);
  for (var i = 0; i < 256; i++) {
    dict[i] = String.fromCharCode(i);
  }
  var oldPhrase = String.fromCharCode(codes[0]);
  var out = [oldPhrase];
  var nextCode = 256;
  for (var j = 1; j < codes.length; j++) {
    var code = codes[j];
    var phrase = code < dict.length ? dict[code] : oldPhrase + oldPhrase.charAt(0);
    out.push(phrase);
    dict[nextCode++] = oldPhrase + phrase.charAt(0);
    oldPhrase = phrase;
  }
  var binary = out.join('');
  var bytes = new Uint8Array(binary.length);
  for (var k = 0; k < binary.length; k++) {
    bytes[k] = binary.charCodeAt(k);
  }
  return new TextDecoder().decode(bytes);
}

function runPackedScript(name) {
  var code = decodePackedScript(window.packedScripts[name]);
  (0, eval)(code);
  return true;
}

function loadIndex(){
${renderScriptBody(indexJs)}
}

function loadCcJs(){
${renderScriptBody(ccJs)}
}

${spineLoaders.map(s => renderScriptFunction(s.fnName, s.script)).join('\n\n')}

window.jsList = ${safeJson([
    'index.js',
    'application.js',
    'bundle.js',
    'cc.js',
    ...spineFiles
])};

window.loadFunc = [
  loadIndex,
  loadApplication,
  loadMyBundle,
  loadCcJs,
  ${spineLoaders.map(s => s.fnName).join(', ')}
];

function load(name){
  for (var i = 0; i < window.jsList.length; i++){
    if (name === window.jsList[i]){
      window.loadFunc[i]();
      return true;
    }
  }
  return false;
}

var existingHook = System.constructor.prototype.instantiate;
System.constructor.prototype.instantiate = function (url, parentUrl) {
  if (url && url.indexOf("chunks:///_virtual/") === 0) {
    return Promise.resolve(existingHook.call(this, url, parentUrl));
  }
  var loaded = false;
  for (var i = 0;i < window.jsList.length;i++){
    if (url.indexOf(window.jsList[i]) > 0){
      loaded = load(window.jsList[i]);
      break;
    }
  }
  return loaded ? System.getRegister() : existingHook.call(this, url, parentUrl);
};

function start(){
  System.import('./index.js').catch(function (err) { console.error(err); })
}
  </script>

  <script>
    window.progress.value = 35;
  </script>
${renderBodyPlatformShim(platform)}

  <script>
    window.addEventListener("DOMContentLoaded", start);
    window['gameClose'] = () => { console.log("游戏关闭"); };
    window['gameStart'] = () => { console.log("游戏关闭"); };
  </script>
</body>
</html>
`;

  fs.mkdirSync(path.dirname(outputHtml), { recursive: true });
  fs.writeFileSync(outputHtml, '\uFEFF' + html, 'utf8');
  const outputSize = fs.statSync(outputHtml).size;
  log(`写入 ${outputHtml}`);
  log(`产物大小: ${formatMB(outputSize)}`);
  log(`全部完成 (${formatDuration(Date.now() - totalStarted)})`);
}

async function main() {
  const selectedPlatform = await selectPlatform();

  if (selectedPlatform === 'all') {
    log('打包模式: 一键全打包');
    const totalStarted = Date.now();
    for (const platform of PACK_PLATFORMS) {
      const outputHtml = path.join(OUTPUT_DIR, platformOutputName(platform), 'index.html');
      await buildPlatform(platform, outputHtml);
    }
    log(`一键全打包完成 (${formatDuration(Date.now() - totalStarted)})`);
    return;
  }

  log('打包模式: 单平台');
  await buildPlatform(selectedPlatform, OUTPUT_HTML);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
