#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const readline = require('readline');
const {promisify} = require('util');
const {exec} = require('child_process');

const execAsync = promisify(exec);

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m',
};

const CDN_BASE = 'https://cdn.simpl.iwanvanderwal.nl/framework';
const LOCAL_RELEASES_DIR = process.env.SIMPL_LOCAL_RELEASES || path.join(process.cwd(), 'local-releases');
const BOX_WIDTH = 62;
const PAD = '  ';
const TEMP_DIR_PREFIX = 'simpl-addon-';

const styled = (msg, ...styles) => styles.join('') + msg + C.reset;
const line = (msg = '') => console.log(msg);
const out = (msg, color = C.reset) => console.log(color + msg + C.reset);
const prefixed = (symbol, color, msg, bold = false, dim = false) => out(PAD + color + symbol + C.reset + ' ' + (bold ? styled(msg, C.bold) : dim ? styled(msg, C.dim) : msg));

const success = (msg, bold = false) => prefixed('✓', C.green, msg, bold);
const error = (msg, bold = false) => prefixed('✕', C.red, msg, bold);
const warn = (msg, bold = false) => prefixed('⚠', C.yellow, msg, bold);
const info = (msg) => prefixed('◌', C.cyan, msg, false, true);
const task = (msg) => out(PAD + msg);
const item = (msg, dim = false) => out(PAD + C.cyan + '•' + C.reset + ' ' + (dim ? styled(msg, C.dim) : msg));

const box = (title) => {
  const plain = title.replace(/\x1b\[[0-9;]*m/g, '');
  const truncated = plain.length > BOX_WIDTH - 2 ? plain.slice(0, BOX_WIDTH - 5) + '...' : plain;
  const displayTitle = title.replace(plain, truncated);
  const spaces = ' '.repeat(BOX_WIDTH - 2 - truncated.length);
  line();
  out(PAD + '╭' + '─'.repeat(BOX_WIDTH) + '╮');
  out(PAD + '│ ' + styled(displayTitle, C.bold) + spaces + ' │');
  out(PAD + '╰' + '─'.repeat(BOX_WIDTH) + '╯');
};

const divider = () => {
  line();
  out(PAD + '─'.repeat(16), C.dim);
  line();
};

const printAnswer = (question, value) => out(`${question}: ${C.cyan}${value}${C.reset}`);

const cleanupPath = (targetPath) => {
  try {
    fs.rmSync(targetPath, {recursive: true, force: true});
  } catch {
  }
};

const resolveRedirectUrl = (baseUrl, location) => new URL(location, baseUrl).toString();

const isRedirect = (statusCode) => [301, 302].includes(statusCode);
const checkStatus = (statusCode, statusMessage, location, url) => {
  if (isRedirect(statusCode)) {
    if (!location) throw new Error(`HTTP ${statusCode}: Redirect missing location`);
    return resolveRedirectUrl(url, location);
  }
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}: ${statusMessage || 'Request failed'}`);
  return null;
};

const fetchUrl = (url) => new Promise((resolve, reject) => {
  https.get(url, res => {
    try {
      const redirect = checkStatus(res.statusCode, res.statusMessage, res.headers.location, url);
      if (redirect) return fetchUrl(redirect).then(resolve).catch(reject);
    } catch (err) {
      return reject(err);
    }
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(data));
  }).on('error', reject).setTimeout(10000, () => reject(new Error('Request timed out')));
});

const downloadFile = (url, dest) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(dest);
  let settled = false;
  const fail = (err) => {
    if (settled) return;
    settled = true;
    cleanupPath(dest);
    reject(err);
  };

  https.get(url, res => {
    try {
      const redirect = checkStatus(res.statusCode, res.statusMessage, res.headers.location, url);
      if (redirect) return downloadFile(redirect, dest).then(resolve).catch(reject);
    } catch (err) {
      return fail(err);
    }
    res.pipe(file);
    file.on('finish', () => file.close(err => err ? fail(err) : resolve()));
  }).on('error', fail);
  file.on('error', fail);
});

const promptUser = (question, defaultValue = '') => new Promise(resolve => {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  rl.question(`${question}: `, answer => {
    rl.close();
    resolve(answer.trim() || defaultValue);
  });
});

const parseArgs = (args) => {
  const result = {addon: null, unknownFlags: [], help: false, list: false};
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--list' || arg === '-l') result.list = true;
    else if (arg.startsWith('--addon=')) result.addon = arg.slice(8).trim() || null;
    else if (arg.startsWith('-a=')) result.addon = arg.slice(3).trim() || null;
    else if (arg.startsWith('-') && !arg.startsWith('--addon') && !arg.startsWith('-a')) result.unknownFlags.push(arg);
    else if (!arg.startsWith('-') && !result.addon) result.addon = arg;
  }
  return result;
};

const KNOWN_FLAGS = ['--addon', '-a', '--help', '-h', '--list', '-l'];

const levenshtein = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, (_, i) => Array.from({length: n + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
};

const closestMatch = (input, options) => {
  let best = null, bestDist = Infinity;
  for (const opt of options) {
    const dist = levenshtein(input.toLowerCase(), opt.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = opt;
    }
  }
  return bestDist <= Math.max(3, Math.floor(input.length / 2)) ? best : null;
};

const listAddons = (addons) => addons.forEach((name, i) => out(PAD + C.cyan + `${i + 1}.` + C.reset + ' ' + name));

const confirmSuggestion = async (suggestion) => {
  line();
  while (true) {
    const a = (await promptUser(PAD + `${C.cyan}◌${C.reset} ${C.dim}Did you mean${C.reset} ${C.cyan}${suggestion}${C.reset}${C.dim}?${C.reset} [y/N]`, 'no')).toLowerCase();
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
    warn('Please answer [Y] Yes or [N] No)');
    line();
  }
};

const promptAddon = async (addons, firstInput = null) => {
  const askSuggestion = async (input) => {
    line();
    error(`Add-on ${styled(input, C.bold)} not found`);
    const suggestion = closestMatch(input, addons);
    if (suggestion && await confirmSuggestion(suggestion)) return suggestion;
    line();
    out(PAD + styled('Available add-ons:', C.bold), C.blue);
    listAddons(addons);
    line();
    return null;
  };

  let pending = firstInput;
  while (true) {
    const input = pending || await promptUser(PAD + `Add-on to install ${C.dim}(name or number)${C.reset}`);
    pending = null;
    if (!input) {
      warn('Selection cannot be empty');
      line();
      continue;
    }
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= addons.length) return addons[num - 1];
    if (addons.includes(input)) return input;
    const resolved = await askSuggestion(input);
    if (resolved) return resolved;
  }
};

const showHelp = () => {
  box('Simpl Add-on Installer');
  line();
  out(PAD + styled('Usage:', C.bold), C.blue);
  out(PAD + styled('npx @ijuantm/simpl-addon', C.dim));
  out(PAD + styled('npx @ijuantm/simpl-addon --addon=<name>', C.dim));
  out(PAD + styled('npx @ijuantm/simpl-addon --help', C.dim));
  line();
  out(PAD + styled('Options:', C.bold), C.blue);
  out(PAD + styled('--addon=<name>, -a=<name>', C.dim) + ' Add-on to install');
  out(PAD + styled('--list, -l', C.dim) + '              List available add-ons');
  out(PAD + styled('--help, -h', C.dim) + '              Show this help message');
  line();
  out(PAD + styled('Note:', C.bold), C.blue);
  item('Run this command from the root of your Simpl project.');
  item('The add-on version will match your Simpl framework version.');
  line();
};

const checkServerAvailability = () => new Promise(resolve => {
  https.get(`${CDN_BASE}/versions.json`, {timeout: 5000}, res => {
    res.resume();
    resolve(res.statusCode === 200);
  }).on('error', () => resolve(false)).on('timeout', () => resolve(false));
});

const getVersionsData = async () => {
  try {
    return JSON.parse(await fetchUrl(`${CDN_BASE}/versions.json`));
  } catch {
    return {versions: {}};
  }
};

const getSimplVersion = () => {
  const simplFile = path.join(process.cwd(), '.simpl');
  if (!fs.existsSync(simplFile)) throw new Error('Not a Simpl project. Missing .simpl file in current directory.');
  const config = JSON.parse(fs.readFileSync(simplFile, 'utf8'));
  if (!config.version) throw new Error('Invalid .simpl file: missing version field');
  return config.version;
};

const getAvailableAddons = async (version) => {
  const localAddonsDir = path.join(LOCAL_RELEASES_DIR, version, 'add-ons');
  if (fs.existsSync(localAddonsDir)) return fs.readdirSync(localAddonsDir, {withFileTypes: true})
    .filter(e => e.isFile() && e.name.endsWith('.zip'))
    .map(e => e.name.slice(0, -4))
    .sort();
  return ((await getVersionsData()).versions[version]?.['add-ons'] || []).sort();
};

const extractMarkers = (content) => {
  const markers = [];
  content.split('\n').forEach((line, i) => {
    const after = line.match(/@addon-insert:after\s*\(\s*(["'])(.*?)\1\s*\)/);
    const before = line.match(/@addon-insert:before\s*\(\s*(["'])(.*?)\1\s*\)/);
    const replace = line.match(/@addon-insert:replace\s*\(\s*(["'])(.*?)\1\s*\)/);
    if (after) markers.push({type: 'after', lineIndex: i, searchText: after[2]});
    else if (before) markers.push({type: 'before', lineIndex: i, searchText: before[2]});
    else if (replace) markers.push({type: 'replace', lineIndex: i, markerName: replace[2]});
    else if (line.includes('@addon-insert:prepend')) markers.push({type: 'prepend', lineIndex: i});
    else if (line.includes('@addon-insert:append')) markers.push({type: 'append', lineIndex: i});
  });
  return markers;
};

const collectContentBetweenMarkers = (lines, startIndex) => {
  const content = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().includes('@addon-end')) break;
    content.push(lines[i]);
  }
  return content;
};

const normalizeContent = (lines) => lines.map(l => l.trim())
  .filter(l => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*'))
  .join('|');

const processEnvContent = (content, targetContent) => {
  const envVarsToAdd = [], comments = [];
  for (const line of content) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) {
      comments.push(line);
      continue;
    }
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match && !new RegExp(`^${match[1]}=`, 'm').test(targetContent)) envVarsToAdd.push(line);
  }
  return {content: [...comments, ...envVarsToAdd], count: envVarsToAdd.length};
};

const findInsertIndex = (lines, searchText, type) => {
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(searchText)) return type === 'before' ? i : i + 1;
  return -1;
};

const mergeFile = (targetPath, addonContent, markers, isEnv = false) => {
  const targetContent = fs.readFileSync(targetPath, 'utf8');
  const addonLines = addonContent.split('\n');
  const operations = [];
  let newContent = targetContent;

  for (const marker of markers) {
    let content = collectContentBetweenMarkers(addonLines, marker.lineIndex);
    if (!content.length) continue;
    let lineCount = content.length;

    if (isEnv) {
      const processed = processEnvContent(content, newContent);
      content = processed.content;
      lineCount = processed.count;
      if (!content.length) {
        operations.push({success: false, type: marker.type, lines: 0, searchText: marker.searchText});
        continue;
      }
    } else {
      const signature = normalizeContent(content);
      if (signature && normalizeContent(newContent.split('\n')).includes(signature)) {
        operations.push({success: false, type: marker.type, lines: content.length, searchText: marker.searchText || marker.markerName});
        continue;
      }
    }

    if (marker.type === 'prepend') {
      newContent = content.join('\n') + '\n' + newContent;
      operations.push({success: true, type: 'prepend', lines: lineCount});
    } else if (marker.type === 'append') {
      if (!newContent.endsWith('\n')) newContent += '\n';
      newContent += '\n' + content.join('\n') + '\n';
      operations.push({success: true, type: 'append', lines: lineCount});
    } else if (marker.type === 'replace' && marker.markerName) {
      const targetLines = newContent.split('\n');
      const replaceIndex = findInsertIndex(targetLines, marker.markerName, 'before');
      if (replaceIndex === -1) {
        operations.push({success: false, type: 'notfound', searchText: marker.markerName});
        continue;
      }
      targetLines.splice(replaceIndex, 1, ...content);
      newContent = targetLines.join('\n');
      operations.push({success: true, type: 'replace', lines: lineCount, markerName: marker.markerName});
    } else if ((marker.type === 'after' || marker.type === 'before') && marker.searchText) {
      const targetLines = newContent.split('\n');
      const insertIndex = findInsertIndex(targetLines, marker.searchText, marker.type);
      if (insertIndex === -1) {
        operations.push({success: false, type: 'notfound', searchText: marker.searchText});
        continue;
      }
      targetLines.splice(insertIndex, 0, ...content);
      newContent = targetLines.join('\n');
      operations.push({success: true, type: marker.type, lines: lineCount, searchText: marker.searchText});
    }
  }

  if (newContent !== targetContent) fs.writeFileSync(targetPath, newContent, 'utf8');
  return {modified: newContent !== targetContent, operations};
};

const printMergeResults = (relativePath, isEnv, result) => {
  const varText = isEnv ? 'environment variable' : 'line';
  let hasChanges = false;

  for (const op of result.operations) {
    if (op.success) {
      hasChanges = true;
      const count = `${styled(String(op.lines), C.bold)} ${varText}${op.lines !== 1 ? 's' : ''}`;
      if (op.type === 'prepend') success(`Prepended ${count} to file start`);
      else if (op.type === 'append') success(`Appended ${count} to file end`);
      else if (op.type === 'replace') success(`Replaced marker ${C.cyan}${op.markerName}${C.reset} with ${count}`);
      else if (op.type === 'after') success(`Inserted ${count} ${C.cyan}after${C.reset} ${styled(op.searchText, C.dim)}`);
      else if (op.type === 'before') success(`Inserted ${count} ${C.cyan}before${C.reset} ${styled(op.searchText, C.dim)}`);
    } else if (op.type === 'notfound') {
      warn(`Could not find target: ${op.markerName ? `marker ${styled(op.markerName, C.dim)}` : styled(op.searchText, C.dim)}`);
    } else {
      info(`Content already exists (${op.type})`);
    }
  }

  return hasChanges;
};

const extractZip = async (zipPath, destDir) => {
  fs.mkdirSync(destDir, {recursive: true});
  const cmd = process.platform === 'win32'
    ? `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`
    : `unzip -q "${zipPath}" -d "${destDir}"`;
  await execAsync(cmd);
  const entries = fs.readdirSync(destDir, {withFileTypes: true});
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nestedDir = path.join(destDir, entries[0].name);
    for (const item of fs.readdirSync(nestedDir, {withFileTypes: true}))
      fs.cpSync(path.join(nestedDir, item.name), path.join(destDir, item.name), {recursive: true});
    fs.rmSync(nestedDir, {recursive: true, force: true});
  }
};

const processAddonFiles = (addonDir, targetDir) => {
  const copied = [], skipped = [], toMerge = [];

  const processDirectory = (dir, basePath = '') => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'README.md') continue;
      const srcPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
      const destPath = path.join(targetDir, relativePath);

      if (entry.isDirectory()) {
        processDirectory(srcPath, relativePath);
        continue;
      }

      const content = fs.readFileSync(srcPath, 'utf8');
      if (fs.existsSync(destPath)) {
        const markers = extractMarkers(content);
        if (markers.length > 0 || entry.name === '.env') toMerge.push({content, destPath, relativePath, markers});
        else skipped.push(relativePath);
      } else {
        fs.mkdirSync(path.dirname(destPath), {recursive: true});
        fs.copyFileSync(srcPath, destPath);
        copied.push(relativePath);
      }
    }
  };

  processDirectory(addonDir);
  return {copied, skipped, toMerge};
};

const downloadAddon = async (addonName, version, targetDir) => {
  const localZipPath = path.join(LOCAL_RELEASES_DIR, version, 'add-ons', `${addonName}.zip`);

  if (fs.existsSync(localZipPath)) {
    line();
    task('💻 Using local add-on files');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    try {
      await extractZip(localZipPath, tempDir);
      return processAddonFiles(tempDir, targetDir);
    } finally {
      cleanupPath(tempDir);
    }
  }

  if (!await checkServerAvailability()) throw new Error('CDN server is currently unreachable');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const tempZip = path.join(tempDir, `${addonName}.zip`);
  try {
    await downloadFile(`${CDN_BASE}/${version}/add-ons/${addonName}.zip`, tempZip);
    await extractZip(tempZip, tempDir);
    return processAddonFiles(tempDir, targetDir);
  } finally {
    cleanupPath(tempDir);
  }
};

const mergeFiles = (toMerge) => {
  if (!toMerge.length) return {merged: [], failed: [], unchanged: []};
  const merged = [], failed = [], unchanged = [];

  for (const {content, destPath, relativePath, markers} of toMerge) {
    const isEnv = path.basename(destPath) === '.env';
    line();
    info(styled(relativePath, C.dim));
    try {
      if (printMergeResults(relativePath, isEnv, mergeFile(destPath, content, markers, isEnv))) merged.push(relativePath);
      else unchanged.push(relativePath);
    } catch (err) {
      error(`Error: ${err.message}`);
      failed.push(relativePath);
    }
  }

  return {merged, failed, unchanged};
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    showHelp();
    process.exit(0);
  }

  if (parsed.unknownFlags.length) {
    for (const flag of parsed.unknownFlags) {
      const flagName = flag.includes('=') ? flag.slice(0, flag.indexOf('=')) : flag;
      line();
      warn(`Unknown option: ${styled(flag, C.bold)}`);
      line();
      const suggestion = closestMatch(flagName, KNOWN_FLAGS);
      if (suggestion) info(`Did you mean ${C.cyan}${suggestion}${C.reset}${C.dim}?${C.reset}`);
    }
    info('Run with --help to see all available options.');
    line();
    process.exit(1);
  }

  let version;
  try {
    version = getSimplVersion();
  } catch (err) {
    line();
    error(err.message);
    line();
    process.exit(1);
  }

  box(`Simpl Add-on Installer ${C.dim}(v${version})${C.reset}`);

  const {versions} = await getVersionsData();

  const versionMeta = versions[version];
  if (!versionMeta) {
    line();
    error(`Version ${styled(version, C.bold)} not found`);
    line();
    process.exit(1);
  }

  if (versionMeta['script-compatible'] === false) {
    line();
    error(`Version ${styled(version, C.bold)} is not compatible with this installer`);
    line();
    out(PAD + styled('Manual download:', C.bold), C.blue);
    item(`${C.cyan}${CDN_BASE}/${version}/add-ons/`);
    line();
    out(PAD + styled('Available add-ons for this version:', C.bold), C.blue);
    const addons = versionMeta['add-ons'] || [];
    if (!addons.length) info('No add-ons available');
    else for (const name of addons) item(`${name}: ${styled(`${CDN_BASE}/${version}/add-ons/${name}.zip`, C.dim)}`);
    line();
    process.exit(1);
  }

  if (!parsed.addon) {
    line();
    task('🗄️ Fetching available add-ons...');
  }

  let addons;
  try {
    addons = await getAvailableAddons(version);
  } catch {
    line();
    error('Failed to fetch add-ons');
    info('The CDN server is currently unavailable. Please try again later.');
    line();
    process.exit(1);
  }

  if (!addons.length) {
    line();
    warn('No add-ons available for this version');
    line();
    process.exit(0);
  }

  if (parsed.list) {
    line();
    out(PAD + styled('Available add-ons:', C.bold), C.blue);
    listAddons(addons);
    line();
    process.exit(0);
  }

  let addonName;
  if (parsed.addon) {
    addonName = await promptAddon(addons, parsed.addon);
    printAnswer(PAD + 'Add-on to install', addonName);
  } else {
    line();
    out(PAD + styled('Available add-ons:', C.bold), C.blue);
    listAddons(addons);
    line();
    addonName = await promptAddon(addons);
  }

  box(`Installing: ${C.cyan}${addonName}${C.reset} ${C.dim}(v${version})${C.reset}`);
  line();
  task(`📦 Downloading ${C.cyan}${addonName}${C.reset} add-on...`);

  let copied, skipped, toMerge;
  try {
    ({copied, skipped, toMerge} = await downloadAddon(addonName, version, process.cwd()));
  } catch (err) {
    line();
    error('Installation failed');
    if (err.message === 'CDN server is currently unreachable') info('The CDN server is currently unavailable. Please try again later.');
    else info('Please verify the add-on exists and try again');
    line();
    process.exit(1);
  }

  if (copied.length) {
    line();
    success(`Copied ${styled(String(copied.length), C.bold)} new file${copied.length !== 1 ? 's' : ''}`);
  }

  if (skipped.length) {
    line();
    info(`Skipped ${skipped.length} file${skipped.length !== 1 ? 's' : ''} (no merge markers):`);
    for (const file of skipped) item(file, true);
  }

  if (toMerge.length) {
    line();
    task('🔀 Merging existing files...');
    const {merged, failed, unchanged} = mergeFiles(toMerge);
    divider();
    if (merged.length) success(`Successfully merged ${styled(String(merged.length), C.bold)} file${merged.length !== 1 ? 's' : ''}`);
    if (unchanged.length) info(`${unchanged.length} file${unchanged.length !== 1 ? 's' : ''} unchanged (content already exists)`);
    if (failed.length) {
      line();
      warn(`${failed.length} file${failed.length !== 1 ? 's' : ''} failed to merge`);
      warn('Please review manually:');
      for (const file of failed) item(file);
    }
  }

  line();
  success(styled('Installation complete!', C.bold, C.green), true);
  line();
};

main().catch(() => {
  line();
  error('Fatal error occurred');
  line();
  process.exit(1);
});
