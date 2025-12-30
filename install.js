#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const {promisify} = require('util');
const {exec} = require('child_process');

const execAsync = promisify(exec);

const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m'
};

const CDN_BASE = 'https://cdn.simpl.iwanvanderwal.nl/framework';

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

const showHelp = () => {
  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Simpl Add-on Installer${COLORS.reset}${' '.repeat(38)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log(`  ${COLORS.bold}Usage:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon <addon-name> [version]${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon --list [version]${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon --help${COLORS.reset}`);
  console.log();
  log(`  ${COLORS.bold}Arguments:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}addon-name${COLORS.reset}    Name of the add-on to install`);
  log(`    ${COLORS.dim}version${COLORS.reset}       Framework version (default: latest)`);
  console.log();
  log(`  ${COLORS.bold}Commands:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}--list, -l${COLORS.reset}    List all available add-ons`);
  log(`    ${COLORS.dim}--help, -h${COLORS.reset}    Show this help message`);
  console.log();
  log(`  ${COLORS.bold}Examples:${COLORS.reset}`, 'blue');
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon auth${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon auth 1.5.0${COLORS.reset}`);
  log(`    ${COLORS.dim}npx @ijuantm/simpl-addon --list${COLORS.reset}`);
  console.log();
};

const listAddons = async (version) => {
  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Available Add-ons${COLORS.reset} ${COLORS.dim}(${version})${COLORS.reset}${' '.repeat(40 - version.length)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log('  📦 Fetching available add-ons...', 'bold');

  try {
    const response = await fetchUrl(`${CDN_BASE}/${version}/add-ons/list.json`);
    const addons = JSON.parse(response)['add-ons'];

    console.log();

    if (addons.length === 0) log(`  ${COLORS.yellow}⚠${COLORS.reset} No add-ons available`);
    else addons.forEach(name => log(`  ${COLORS.cyan}•${COLORS.reset} ${name}`));
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} Failed to fetch add-ons: ${error.message}`, 'red');
    console.log();

    process.exit(1);
  }

  console.log();
};

const extractMarkers = (content) => {
  const markers = [];

  content.split('\n').forEach((line, i) => {
    const afterMatch = line.match(/@addon-insert:after\s*\(\s*["'](.+?)["']\s*\)/);
    const beforeMatch = line.match(/@addon-insert:before\s*\(\s*["'](.+?)["']\s*\)/);

    if (afterMatch) markers.push({type: 'after', lineIndex: i, searchText: afterMatch[1]});
    else if (beforeMatch) markers.push({type: 'before', lineIndex: i, searchText: beforeMatch[1]});
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
        operations.push({success: false, type: marker.type, lines: content.length, searchText: marker.searchText});
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
      else if (op.type === 'after') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}after${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`);
      else if (op.type === 'before') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}before${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`);
    } else if (op.type === 'notfound') log(`${indent}${COLORS.yellow}⚠${COLORS.reset} ${COLORS.yellow}Could not find target:${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`);
    else log(`${indent}${COLORS.gray}○${COLORS.reset} ${COLORS.dim}Content already exists (${op.type})${COLORS.reset}`);
  });

  return hasChanges;
};

const extractZip = async zipPath => {
  const tempExtract = path.join(process.cwd(), '__temp_extract_addon__');

  if (process.platform === 'win32') {
    await execAsync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtract}' -Force"`);
  } else {
    await execAsync(`unzip -q "${zipPath}" -d "${tempExtract}"`);
  }

  const entries = fs.readdirSync(tempExtract, {withFileTypes: true});
  const sourceDir = entries.length === 1 && entries[0].isDirectory() ? path.join(tempExtract, entries[0].name) : tempExtract;

  return {sourceDir, tempExtract};
};

const processAddonFiles = (addonDir, targetDir) => {
  const copied = [], skipped = [], toMerge = [];

  const processDirectory = (dir, basePath = '') => fs.readdirSync(dir, {withFileTypes: true}).forEach(entry => {
    if (entry.name === 'README.md') return;

    const srcPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    const destPath = path.join(targetDir, relativePath);

    if (entry.isDirectory()) processDirectory(srcPath, relativePath);
    else {
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
  const zipUrl = `${CDN_BASE}/${version}/add-ons/${addonName}.zip`;
  const tempZip = path.join(process.cwd(), `temp-addon-${addonName}.zip`);

  try {
    await downloadFile(zipUrl, tempZip);

    const {sourceDir, tempExtract} = await extractZip(tempZip);
    const result = processAddonFiles(sourceDir, targetDir);

    fs.unlinkSync(tempZip);
    fs.rmSync(tempExtract, {recursive: true, force: true});

    return result;
  } catch (error) {
    if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
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

  if (!firstArg || firstArg === '--help' || firstArg === '-h') {
    showHelp();

    process.exit(0);
  }

  if (firstArg === '--list' || firstArg === '-l') {
    const version = args[1] || 'latest';
    await listAddons(version);

    process.exit(0);
  }

  const addonName = firstArg;
  const version = args[1] || 'latest';

  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Installing Add-on: ${COLORS.cyan}${addonName}${COLORS.reset} ${COLORS.dim}(${version})${COLORS.reset}${' '.repeat(38 - addonName.length - version.length)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log('  📦 Downloading add-on...', 'bold');

  let copied, skipped, toMerge;

  try {
    ({copied, skipped, toMerge} = await downloadAddon(addonName, version, process.cwd()));
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} ${error.message}`, 'red');
    log(`  ${COLORS.dim}Run ${COLORS.dim}npx @ijuantm/simpl-addon --list${COLORS.reset} to see available add-ons`);
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

main().catch(err => {
  log(`\n  ${COLORS.red}✗${COLORS.reset} Fatal error: ${err.message}\n`, 'red');

  process.exit(1);
});
