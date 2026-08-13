// ===== 本地 OCR =====
// 两个引擎二选一（设置里 config.ocr.engine 选择）：
//  - 'win'        : Windows 自带 OCR（Windows.Media.Ocr），对中文印刷体最佳、离线、零依赖
//  - 'tesseract'  : Tesseract.js（全精度模型），跨平台
// Windows OCR 失败/无结果时自动回退 Tesseract，保证始终有结果。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { createWorker } = require('tesseract.js');

const LANGS = 'chi_sim+eng';
// 使用 jsDelivr CDN（国内可访问）托管的 tesseract.js 语言包（.gz）
// 4.0.0 = 全精度（float）模型，识别精度显著高于 4.0.0_best_int（int 量化）
const DATA_VERSION = '2';
const DATA_URLS = {
  'chi_sim.traineddata.gz': 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz',
  'eng.traineddata.gz': 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'
};

let dataDir = '';
let worker = null;
let tessChain = Promise.resolve();
let winChain = Promise.resolve();

function setDataDir(dir) { dataDir = dir; }

// 确保语言包就绪（缺失则自动下载到本地缓存目录）
async function ensureData() {
  if (!dataDir) throw new Error('OCR 数据目录未初始化');
  fs.mkdirSync(dataDir, { recursive: true });
  // 版本标记：模型切换时清理旧语言包，避免沿用旧缓存
  const verFile = path.join(dataDir, 'ocr-version.txt');
  let needRefresh = false;
  try {
    if (fs.readFileSync(verFile, 'utf8').trim() !== DATA_VERSION) needRefresh = true;
  } catch (e) { needRefresh = true; }
  if (needRefresh) {
    for (const name of Object.keys(DATA_URLS)) {
      try { fs.unlinkSync(path.join(dataDir, name)); } catch (e) { /* 忽略 */ }
    }
    fs.writeFileSync(verFile, DATA_VERSION, 'utf8');
  }
  const tasks = Object.keys(DATA_URLS).map(async (name) => {
    const fp = path.join(dataDir, name);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 1000) return;
    const res = await fetch(DATA_URLS[name]);
    if (!res.ok) throw new Error('下载 OCR 语言包失败（HTTP ' + res.status + '）：' + name + '，请检查网络后重试');
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(fp, buf);
  });
  await Promise.all(tasks);
}

async function getWorker() {
  if (worker) return worker;
  // Windows 反斜杠路径在 tesseract 内部可能被转义破坏，统一用正斜杠
  const langPath = dataDir.replace(/\\/g, '/');
  worker = await createWorker(LANGS, 1, { langPath, gzip: true });
  return worker;
}

// ---- 方案二：Tesseract.js ----
async function tesseractOcr(buffer) {
  await ensureData();
  const w = await getWorker();
  const { data } = await w.recognize(buffer);
  return ((data && data.text) || '').trim();
}

// ---- 方案一：Windows 自带 OCR（Windows.Media.Ocr）----
const POWERSHELL = (process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe');

function winOcr(buffer) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png');
    try { fs.writeFileSync(tmp, buffer); } catch (e) { return reject(e); }
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null',
      "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
      'function Await($WinRtTask, $ResultType) {',
      '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
      '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
      '  $netTask.Wait(-1) | Out-Null',
      '  return $netTask.Result',
      '}',
      "$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('" + tmp + "')) ([Windows.Storage.StorageFile])",
      "$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
      '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
      '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
      "$lang = New-Object Windows.Globalization.Language('zh-Hans-CN')",
      '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)',
      'if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
      'if ($null -eq $engine) { throw \'no-ocr-engine\' }',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
      'Write-Output $result.Text'
    ].join('\n');
    execFile(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
      if (err) return reject(new Error('Windows OCR 失败'));
      resolve((stdout || '').trim());
    });
  });
}

// ---- 统一入口：按设置选择引擎，串行执行 ----
function ocrImage(buffer, engine) {
  const useWin = engine !== 'tesseract'; // 默认 'win'
  const run = (useWin ? winChain : tessChain).then(async () => {
    if (!useWin) return tesseractOcr(buffer);
    const t = await winOcr(buffer).catch(() => '');
    if (t && t.trim()) return t.trim();
    return tesseractOcr(buffer); // Windows OCR 不可用/无结果时回退
  });
  if (useWin) winChain = run.catch(() => {}); else tessChain = run.catch(() => {});
  return run;
}

module.exports = { setDataDir, ocrImage, winOcr, tesseractOcr };
