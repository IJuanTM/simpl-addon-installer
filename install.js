#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');
const {promisify} = require('util');
const {exec} = require('child_process');

const execAsync = promisify(exec);

const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m'
};

const CDN_BASE = 'https://cdn.simpl.iwanvanderwal.nl/framework';
const LOCAL_RELEASES_DIR = process.env.SIMPL_LOCAL_RELEASES || path.join(process.cwd(), 'local-releases');

const log = (message, color = 'reset') => console.log(`${COLORS[color]}${message}${COLORS.reset}`);

const fetchUrl = (url) => new Promise((resolve, reject) => {
  https.get(url, res => {
    if (res.statusCode === 302 || res.statusCode === 301) return fetchUrl(res.headers.location).then(resolve).catch(reject);
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));

    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(data));
  }).on('error', reject);
});

const downloadFile = (url, dest) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(dest);

  https.get(url, res => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      fs.unlinkSync(dest);
      return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
    }
    if (res.statusCode !== 200) {
      fs.unlinkSync(dest);
      return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));
    }

    res.pipe(file);
    file.on('finish', () => {
      file.close();
      resolve();
    });
  }).on('error', err => {
    fs.unlinkSync(dest);
    reject(err);
  });

  file.on('error', err => {
    fs.unlinkSync(dest);
    reject(err);
  });
});

const promptUser = (question, defaultValue = '') => new Promise(resolve => {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  const prompt = defaultValue ? `${question} ${COLORS.dim}(${defaultValue})${COLORS.reset}: ` : `${question}: `;

  rl.question(prompt, answer => {
    rl.close();
    resolve(answer.trim() || defaultValue);
  });
});

const getSimplVersion = () => {
  const simplFile = path.join(process.cwd(), '.simpl');

  if (!fs.existsSync(simplFile)) throw new Error('Not a Simpl project. Missing .simpl file in current directory.');

  const config = JSON.parse(fs.readFileSync(simplFile, 'utf8'));

  if (!config.version) throw new Error('Invalid .simpl file: missing version field');

  return config.version;
};

const showHelp = () => {
  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Simpl Add-on Installer${COLORS.reset}${' '.repeat(38)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log(`  ${COLORS.bold}Usage:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon <add-on>${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon --help${COLORS.reset}`);
  console.log();
  log(`  ${COLORS.bold}Commands:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}--help, -h${COLORS.reset}    Show this help message`);
  console.log();
  log(`  ${COLORS.bold}Note:${COLORS.reset}`, 'blue');
  log(`    Run this command from the root of your Simpl project.`);
  log(`    The add-on version will match your Simpl framework version.`);
  console.log();
};

const checkServerAvailability = () => new Promise(resolve => {
  const req = https.get(`${CDN_BASE}/versions.json`, {timeout: 5000}, res => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => {
    req.destroy();
    resolve(false);
  });
});

const getVersionsData = async () => {
  if (!await checkServerAvailability()) throw new Error('CDN server is currently unreachable');
  return JSON.parse(await fetchUrl(`${CDN_BASE}/versions.json`));
};

const getAvailableAddons = async (version) => {
  const localAddonsDir = path.join(LOCAL_RELEASES_DIR, version, 'add-ons');

  if (fs.existsSync(localAddonsDir)) return fs.readdirSync(localAddonsDir, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.zip'))
    .map(entry => entry.name.replace('.zip', ''))
    .sort();

  const versionMeta = (await getVersionsData()).versions[version];
  return (versionMeta?.['add-ons'] || []).sort();
};

const extractMarkers = (content) => {
  const markers = [];

  content.split('\n').forEach((line, i) => {
    const afterMatch = line.match(/@addon-insert:after\s*\(\s*(["'])(.+?)\1\s*\)/);
    const beforeMatch = line.match(/@addon-insert:before\s*\(\s*(["'])(.+?)\1\s*\)/);
    const replaceMatch = line.match(/@addon-insert:replace\s*\(\s*(["'])(.+?)\1\s*\)/);

    if (afterMatch) markers.push({type: 'after', lineIndex: i, searchText: afterMatch[2]});
    else if (beforeMatch) markers.push({type: 'before', lineIndex: i, searchText: beforeMatch[2]});
    else if (replaceMatch) markers.push({type: 'replace', lineIndex: i, markerName: replaceMatch[2]});
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

const normalizeContent = (lines) => lines.map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*')).join('|');

const processEnvContent = (content, targetContent) => {
  const envVarsToAdd = [], comments = [];

  content.forEach(line => {
    const trimmed = line.trim();

    if (trimmed.startsWith('#') || !trimmed) {
      comments.push(line);
      return;
    }

    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match && !new RegExp(`^${match[1]}=`, 'm').test(targetContent)) envVarsToAdd.push(line);
  });

  return {content: [...comments, ...envVarsToAdd], count: envVarsToAdd.length};
};

const findInsertIndex = (lines, searchText, type) => {
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(searchText)) return type === 'before' ? i : i + 1;
  return -1;
};

const findMarkerLine = (lines, markerName) => {
  const markerPattern = new RegExp(`@addon-marker\\s*\\(\\s*["']${markerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*\\)`);
  for (let i = 0; i < lines.length; i++) if (markerPattern.test(lines[i])) return i;
  return -1;
};

const mergeFile = (targetPath, addonContent, markers, isEnv = false) => {
  const targetContent = fs.readFileSync(targetPath, 'utf8');
  const addonLines = addonContent.split('\n');
  const operations = [];
  let newContent = targetContent;

  markers.forEach(marker => {
    let content = collectContentBetweenMarkers(addonLines, marker.lineIndex);
    if (content.length === 0) return;

    let lineCount = content.length;

    if (isEnv) {
      const processed = processEnvContent(content, newContent);
      content = processed.content;
      lineCount = processed.count;

      if (content.length === 0) {
        operations.push({success: false, type: marker.type, lines: 0, searchText: marker.searchText});
        return;
      }
    } else {
      const signature = normalizeContent(content);
      const targetSignature = normalizeContent(newContent.split('\n'));

      if (signature && targetSignature.includes(signature)) {
        operations.push({success: false, type: marker.type, lines: content.length, searchText: marker.searchText || marker.markerName});
        return;
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
      const markerLine = findMarkerLine(targetLines, marker.markerName);

      if (markerLine === -1) {
        operations.push({success: false, type: 'notfound', markerName: marker.markerName});
        return;
      }

      targetLines.splice(markerLine, 1, ...content);
      newContent = targetLines.join('\n');
      operations.push({success: true, type: 'replace', lines: lineCount, markerName: marker.markerName});
    } else if ((marker.type === 'after' || marker.type === 'before') && marker.searchText) {
      const targetLines = newContent.split('\n');
      const insertIndex = findInsertIndex(targetLines, marker.searchText, marker.type);

      if (insertIndex === -1) {
        operations.push({success: false, type: 'notfound', searchText: marker.searchText});
        return;
      }

      targetLines.splice(insertIndex, 0, ...content);
      newContent = targetLines.join('\n');
      operations.push({success: true, type: marker.type, lines: lineCount, searchText: marker.searchText});
    }
  });

  if (newContent !== targetContent) fs.writeFileSync(targetPath, newContent, 'utf8');

  return {modified: newContent !== targetContent, operations};
};

const printMergeResults = (relativePath, isEnv, result) => {
  const indent = '    ';
  const varText = isEnv ? 'environment variable' : 'line';
  let hasChanges = false;

  result.operations.forEach(op => {
    if (op.success) {
      hasChanges = true;
      if (op.type === 'prepend') log(`${indent}${COLORS.green}✓${COLORS.reset} Prepended ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} to file start`);
      else if (op.type === 'append') log(`${indent}${COLORS.green}✓${COLORS.reset} Appended ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} to file end`);
      else if (op.type === 'replace') log(`${indent}${COLORS.green}✓${COLORS.reset} Replaced marker ${COLORS.cyan}${op.markerName}${COLORS.reset} with ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''}`);
      else if (op.type === 'after') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}after${COLORS.reset} ${COLORS.dim}${op.searchText}${COLORS.reset}`);
      else if (op.type === 'before') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}before${COLORS.reset} ${COLORS.dim}${op.searchText}${COLORS.reset}`);
    } else if (op.type === 'notfound') {
      const target = op.markerName ? `marker ${COLORS.dim}${op.markerName}${COLORS.reset}` : `${COLORS.dim}${op.searchText}${COLORS.reset}`;
      log(`${indent}${COLORS.yellow}⚠${COLORS.reset} ${COLORS.yellow}Could not find target:${COLORS.reset} ${target}`);
    } else log(`${indent}${COLORS.gray}○${COLORS.reset} ${COLORS.dim}Content already exists (${op.type})${COLORS.reset}`);
  });

  return hasChanges;
};

const extractZip = async (zipPath, destDir) => {
  fs.mkdirSync(destDir, {recursive: true});

  if (process.platform === 'win32') await execAsync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`);
  else await execAsync(`unzip -q "${zipPath}" -d "${destDir}"`);

  const entries = fs.readdirSync(destDir, {withFileTypes: true});

  if (entries.length === 1 && entries[0].isDirectory()) {
    const nestedDir = path.join(destDir, entries[0].name);
    fs.readdirSync(nestedDir).forEach(item => fs.renameSync(path.join(nestedDir, item), path.join(destDir, item)));
    fs.rmdirSync(nestedDir);
  }

  return destDir;
};

const processAddonFiles = (addonDir, targetDir) => {
  const copied = [], skipped = [], toMerge = [];

  const processDirectory = (dir, basePath = '') => fs.readdirSync(dir, {withFileTypes: true}).forEach(entry => {
    if (entry.name === 'README.md') return;

    const srcPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    const destPath = path.join(targetDir, relativePath);

    if (entry.isDirectory()) {
      processDirectory(srcPath, relativePath);
    } else {
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
  });

  processDirectory(addonDir);

  return {copied, skipped, toMerge};
};

const downloadAddon = async (addonName, version, targetDir) => {
  const localZipPath = path.join(LOCAL_RELEASES_DIR, version, 'add-ons', `${addonName}.zip`);
  const tempExtract = path.join(process.cwd(), '__temp_extract_addon__');

  try {
    if (fs.existsSync(localZipPath)) {
      console.log();
      log(`  💻 Using local add-on files`, 'bold');
      const sourceDir = await extractZip(localZipPath, tempExtract);
      const result = processAddonFiles(sourceDir, targetDir);
      fs.rmSync(tempExtract, {recursive: true, force: true});
      return result;
    }

    if (!await checkServerAvailability()) throw new Error('CDN server is currently unreachable');

    const tempZip = path.join(process.cwd(), `temp-addon-${addonName}.zip`);
    await downloadFile(`${CDN_BASE}/${version}/add-ons/${addonName}.zip`, tempZip);
    const sourceDir = await extractZip(tempZip, tempExtract);
    const result = processAddonFiles(sourceDir, targetDir);
    fs.unlinkSync(tempZip);
    fs.rmSync(tempExtract, {recursive: true, force: true});
    return result;
  } catch (error) {
    if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, {recursive: true, force: true});
    throw error;
  }
};

const mergeFiles = (toMerge) => {
  if (toMerge.length === 0) return {merged: [], failed: [], unchanged: []};

  const merged = [], failed = [], unchanged = [];

  toMerge.forEach(({content, destPath, relativePath, markers}) => {
    const isEnv = path.basename(destPath) === '.env';
    log(`\n  ${COLORS.cyan}•${COLORS.reset} ${COLORS.dim}${relativePath}${COLORS.reset}`);

    try {
      const result = mergeFile(destPath, content, markers, isEnv);
      if (printMergeResults(relativePath, isEnv, result)) merged.push(relativePath);
      else unchanged.push(relativePath);
    } catch (error) {
      log(`    ${COLORS.red}✗ Error:${COLORS.reset} ${error.message}`, 'red');
      failed.push(relativePath);
    }
  });

  return {merged, failed, unchanged};
};

const main = async () => {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (firstArg === '--help' || firstArg === '-h') {
    showHelp();
    process.exit(0);
  }

  const directName = firstArg && !firstArg.startsWith('-') ? firstArg : null;

  let version;

  try {
    version = getSimplVersion();
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} ${error.message}`, 'red');
    console.log();
    process.exit(1);
  }

  if (!directName) {
    console.log();
    log(`  ╭${'─'.repeat(62)}╮`);
    log(`  │  ${COLORS.bold}Simpl Add-on Installer${COLORS.reset} ${COLORS.dim}(v${version})${COLORS.reset}${' '.repeat(34 - version.length)}│`);
    log(`  ╰${'─'.repeat(62)}╯`);
    console.log();
  }

  let versionsData;

  try {
    versionsData = await getVersionsData();
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Failed to fetch version data`, 'red');
    if (error.message === 'CDN server is currently unreachable') log(`  ${COLORS.dim}The CDN server is currently unavailable. Please try again later.${COLORS.reset}`);
    console.log();
    process.exit(1);
  }

  const versionMeta = versionsData.versions[version];
  if (!versionMeta) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Version ${COLORS.bold}${version}${COLORS.reset} not found`, 'red');
    console.log();
    process.exit(1);
  }

  if (versionMeta['script-compatible'] === false) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Version ${COLORS.bold}${version}${COLORS.reset} is not compatible with this installer`, 'red');
    console.log();
    log(`  ${COLORS.bold}Manual download:${COLORS.reset}`, 'blue');
    log(`    ${COLORS.cyan}${CDN_BASE}/${version}/add-ons/`, 'cyan');
    console.log();
    log(`  ${COLORS.bold}Available add-ons for this version:${COLORS.reset}`, 'blue');

    const addons = versionMeta['add-ons'] || [];
    if (addons.length === 0) {
      log(`    ${COLORS.dim}No add-ons available${COLORS.reset}`);
    } else {
      addons.forEach(name => {
        log(`    ${COLORS.cyan}•${COLORS.reset} ${name}: ${COLORS.dim}${CDN_BASE}/${version}/add-ons/${name}.zip${COLORS.reset}`);
      });
    }

    console.log();
    process.exit(1);
  }

  if (!directName) log('  🧰 Fetching available add-ons...', 'bold');

  let addons;

  try {
    addons = await getAvailableAddons(version);
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Failed to fetch add-ons`, 'red');
    if (error.message === 'CDN server is currently unreachable') log(`  ${COLORS.dim}The CDN server is currently unavailable. Please try again later.${COLORS.reset}`);
    console.log();
    process.exit(1);
  }

  if (addons.length === 0) {
    console.log();
    log(`  ${COLORS.yellow}⚠${COLORS.reset} No add-ons available for this version`);
    console.log();
    process.exit(0);
  }

  let addonName;

  if (directName) {
    if (!addons.includes(directName)) {
      console.log();
      log(`  ${COLORS.red}✗${COLORS.reset} Add-on ${COLORS.bold}${directName}${COLORS.reset} not found`, 'red');
      console.log();
      log(`  ${COLORS.bold}Available add-ons:${COLORS.reset}`, 'blue');
      addons.forEach((name, index) => log(`    ${COLORS.cyan}${index + 1}.${COLORS.reset} ${name}`));
      console.log();
      process.exit(1);
    }
    addonName = directName;
  } else {
    console.log();
    log(`  ${COLORS.bold}Available add-ons:${COLORS.reset}`, 'blue');
    addons.forEach((name, index) => log(`    ${COLORS.cyan}${index + 1}.${COLORS.reset} ${name}`));
    console.log();

    while (true) {
      const input = await promptUser(`  Add-on to install ${COLORS.dim}(name or number)${COLORS.reset}`);

      if (!input) {
        log(`  ${COLORS.red}✗${COLORS.reset} Selection cannot be empty`, 'red');
        console.log();
        continue;
      }

      const numInput = parseInt(input, 10);
      if (!isNaN(numInput) && numInput >= 1 && numInput <= addons.length) {
        addonName = addons[numInput - 1];
        break;
      }

      if (addons.includes(input)) {
        addonName = input;
        break;
      }

      log(`  ${COLORS.red}✗${COLORS.reset} Invalid selection "${input}"`, 'red');
      console.log();
    }
  }

  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Installing: ${COLORS.cyan}${addonName}${COLORS.reset} ${COLORS.dim}(v${version})${COLORS.reset}${' '.repeat(44 - addonName.length - version.length)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log(`  📦 Downloading ${COLORS.cyan}${addonName}${COLORS.reset} add-on...`, 'bold');

  let copied, skipped, toMerge;

  try {
    ({copied, skipped, toMerge} = await downloadAddon(addonName, version, process.cwd()));
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Installation failed`, 'red');
    if (error.message === 'CDN server is currently unreachable') log(`  ${COLORS.dim}The CDN server is currently unavailable. Please try again later.${COLORS.reset}`);
    else log(`  ${COLORS.dim}Please verify the add-on exists and try again${COLORS.reset}`);
    console.log();
    process.exit(1);
  }

  if (copied.length > 0) {
    console.log();
    log(`  ${COLORS.green}✓${COLORS.reset} Copied ${COLORS.bold}${copied.length}${COLORS.reset} new file${copied.length !== 1 ? 's' : ''}`);
  }

  if (skipped.length > 0) {
    console.log();
    log(`  ${COLORS.gray}○${COLORS.reset} ${COLORS.dim}Skipped ${skipped.length} file${skipped.length !== 1 ? 's' : ''} (no merge markers):${COLORS.reset}`);
    skipped.forEach(file => log(`    ${COLORS.dim}• ${file}${COLORS.reset}`));
  }

  if (toMerge.length > 0) {
    console.log();
    log('  🔀 Merging existing files...', 'bold');
    const {merged, failed, unchanged} = mergeFiles(toMerge);

    console.log();
    log('  ' + '─'.repeat(16), 'gray');
    console.log();

    if (merged.length > 0) log(`  ${COLORS.green}✓${COLORS.reset} Successfully merged ${COLORS.bold}${merged.length}${COLORS.reset} file${merged.length !== 1 ? 's' : ''}`);
    if (unchanged.length > 0) log(`  ${COLORS.gray}○${COLORS.reset} ${COLORS.dim}${unchanged.length} file${unchanged.length !== 1 ? 's' : ''} unchanged (content already exists)${COLORS.reset}`);

    if (failed.length > 0) {
      console.log();
      log(`  ${COLORS.yellow}⚠${COLORS.reset} ${COLORS.yellow}${failed.length} file${failed.length !== 1 ? 's' : ''} failed to merge${COLORS.reset}`);
      log(`  ${COLORS.yellow}Please review manually:${COLORS.reset}`);
      failed.forEach(file => log(`    ${COLORS.cyan}• ${file}${COLORS.reset}`));
    }
  }

  console.log();
  log(`  ${COLORS.green}✓${COLORS.reset} ${COLORS.bold}${COLORS.green}Installation complete!${COLORS.reset}`, 'green');
  console.log();
};

main().catch(() => {
  log(`\n  ${COLORS.red}✗${COLORS.reset} Fatal error occurred\n`, 'red');
  process.exit(1);
});
