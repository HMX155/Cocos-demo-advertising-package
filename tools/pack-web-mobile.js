// UTF-8 BOM
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'web-mobile');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_HTML = path.join(OUTPUT_DIR, 'index.html');
const MINIFY_JS = process.env.MINIFY_JS !== '0';
const EXTREME_PACK = process.env.EXTREME_PACK !== '0';
const EXTREME_PACK_MIN_BYTES = 1024;

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

function buildResMap() {
  const assetsRoot = path.join(INPUT_DIR, 'assets');
  const bundleNames = fs.readdirSync(assetsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const files = walkFiles(assetsRoot);
  const resMap = {};
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
    const bin = fs.readFileSync(filePath);
    const b64 = bin.toString('base64');
    resMap[rel] = `data:${mimeFor(ext)};base64,${b64}`;
    if (rel.startsWith('native/')) {
      resMap[rel.replace(/^native\//, 'import/')] = resMap[rel];
    }
  }
  }
  return { resMap, bundleNames };
}

function buildWasmMap() {
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
    wasmMap[key] = `data:${mimeFor(ext)};base64,${b64}`;
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

async function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error('Input not found:', INPUT_DIR);
    process.exit(1);
  }

  const totalStarted = Date.now();
  log(`输入目录: ${INPUT_DIR}`);
  log(`输出文件: ${OUTPUT_HTML}`);
  log(`JS 压缩: ${MINIFY_JS ? '开启' : '关闭'}`);
  log(`极限压缩: ${EXTREME_PACK ? '开启' : '关闭'}`);

  const styleCss = await step('读取 style.css', () => readText(path.join(INPUT_DIR, 'style.css')));
  const polyfills = await step('处理 polyfills.bundle.js', () => minifyJs(readJs(path.join('src', 'polyfills.bundle.js')), 'polyfills.bundle.js'));
  const systemjs = await step('处理 system.bundle.js', () => minifyJs(readJs(path.join('src', 'system.bundle.js')), 'system.bundle.js'));

  const settings = await step('处理 settings.json', () => buildSettings());

  const { resMap, bundleNames } = await step('内联 assets 资源', () => buildResMap());
  log(`资源 bundle: ${bundleNames.join(', ') || '无'}, 文件数: ${Object.keys(resMap).length}`);
  const wasmMap = await step('内联 wasm/bin 资源', () => buildWasmMap());
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
  <canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="0"></canvas>

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

  <script>
    window.addEventListener("DOMContentLoaded", start);
    window['gameClose'] = () => { console.log("游戏关闭"); };
    window['gameStart'] = () => { console.log("游戏关闭"); };
  </script>
</body>
</html>
`;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_HTML, '\uFEFF' + html, 'utf8');
  const outputSize = fs.statSync(OUTPUT_HTML).size;
  log(`写入 ${OUTPUT_HTML}`);
  log(`产物大小: ${formatMB(outputSize)}`);
  log(`全部完成 (${formatDuration(Date.now() - totalStarted)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
