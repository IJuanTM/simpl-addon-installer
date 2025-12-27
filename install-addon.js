#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m', bold: '\x1b[1m', dim: '\x1b[2m'
};

const BRANCH = 'update/1.5.0';
const REPO_BASE = 'https://api.github.com/repos/IJuanTM/simpl/contents/add-ons';
const RAW_BASE = `https://raw.githubusercontent.com/IJuanTM/simpl/${BRANCH}/add-ons`;

const log = (message, color = 'reset') => console.log(`${COLORS[color]}${message}${COLORS.reset}`);

const fetchUrl = (url) => new Promise((resolve, reject) => {
  const headers = {'User-Agent': 'simpl-installer'};
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

  https.get(url, {headers}, res => {
    if (res.statusCode === 302 || res.statusCode === 301) return fetchUrl(res.headers.location).then(resolve).catch(reject);
    if (res.statusCode === 403) {
      const resetTime = res.headers['x-ratelimit-reset'];
      const resetDate = resetTime ? new Date(resetTime * 1000).toLocaleTimeString() : 'unknown';
      return reject(new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}. ${process.env.GITHUB_TOKEN ? 'Token is set but may be invalid.' : 'Set GITHUB_TOKEN environment variable to increase limit.'}`));
    }
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`));

    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(data));
  }).on('error', reject);
});

const showHelp = () => {
  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Simpl Add-on Installer${COLORS.reset}${' '.repeat(38)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log('  Usage:', 'cyan');
  log('    npx @ijuantm/simpl-addon <addon-name>');
  log('    npx @ijuantm/simpl-addon --list');
  log('    npx @ijuantm/simpl-addon --help');
  console.log();
  log('  Commands:', 'cyan');
  log('    <addon-name>    Install the specified add-on');
  log('    --list, -l      List all available add-ons');
  log('    --help, -h      Show this help message');
  console.log();
  log('  Examples:', 'cyan');
  log('    npx @ijuantm/simpl-addon auth');
  log('    npx @ijuantm/simpl-addon --list');
  console.log();
};

const listAddons = async () => {
  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Available Add-ons${COLORS.reset}${' '.repeat(43)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log('  📦 Fetching add-ons from GitHub...', 'bold');

  try {
    const response = await fetchUrl(`${REPO_BASE}?ref=${BRANCH}`);
    const addons = JSON.parse(response).filter(item => item.type === 'dir').map(item => item.name);

    console.log();

    if (addons.length === 0) {
      log(`  ${COLORS.yellow}⚠${COLORS.reset} No add-ons available`);
    } else {
      addons.forEach(name => log(`  ${COLORS.cyan}•${COLORS.reset} ${name}`));
    }
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

    if (afterMatch) markers.push({type: 'after', lineIndex: i, searchText: afterMatch[1]}); else if (beforeMatch) markers.push({type: 'before', lineIndex: i, searchText: beforeMatch[1]}); else if (line.includes('@addon-insert:prepend')) markers.push({type: 'prepend', lineIndex: i}); else if (line.includes('@addon-insert:append')) markers.push({type: 'append', lineIndex: i});
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
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchText)) return type === 'before' ? i : i + 1;
  }

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

      if (op.type === 'prepend') log(`${indent}${COLORS.green}✓${COLORS.reset} Prepended ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} to file start`); else if (op.type === 'append') log(`${indent}${COLORS.green}✓${COLORS.reset} Appended ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} to file end`); else if (op.type === 'after') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}after${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`); else if (op.type === 'before') log(`${indent}${COLORS.green}✓${COLORS.reset} Inserted ${COLORS.bold}${op.lines}${COLORS.reset} ${varText}${op.lines !== 1 ? 's' : ''} ${COLORS.cyan}before${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`);
    } else if (op.type === 'notfound') log(`${indent}${COLORS.yellow}⚠${COLORS.reset} ${COLORS.yellow}Could not find target:${COLORS.reset} "${COLORS.dim}${op.searchText}${COLORS.reset}"`); else log(`${indent}${COLORS.gray}○${COLORS.reset} ${COLORS.dim}Content already exists (${op.type})${COLORS.reset}`);
  });

  return hasChanges;
};

const downloadAddonFiles = async (addonName, targetDir) => {
  const addonUrl = `${REPO_BASE}/${addonName}?ref=${BRANCH}`;
  let files;

  try {
    files = JSON.parse(await fetchUrl(addonUrl));
  } catch (error) {
    throw new Error(`Add-on "${addonName}" not found`);
  }

  const copied = [], skipped = [], toMerge = [];

  const processFiles = async (fileList, basePath = '') => {
    for (const file of fileList) {
      if (file.name === 'README.md') continue;

      const relativePath = path.join(basePath, file.name).replace(/\\/g, '/');
      const destPath = path.join(targetDir, relativePath);

      if (file.type === 'dir') {
        const subUrl = file.url.includes('?') ? `${file.url}&ref=${BRANCH}` : `${file.url}?ref=${BRANCH}`;
        const subFiles = JSON.parse(await fetchUrl(subUrl));
        await processFiles(subFiles, relativePath);
      } else {
        const content = await fetchUrl(`${RAW_BASE}/${addonName}/${relativePath}`);

        if (fs.existsSync(destPath)) {
          const markers = extractMarkers(content);

          if (markers.length > 0 || file.name === '.env') toMerge.push({content, destPath, relativePath, markers}); else skipped.push(relativePath);
        } else {
          fs.mkdirSync(path.dirname(destPath), {recursive: true});
          fs.writeFileSync(destPath, content, 'utf8');
          copied.push(relativePath);
        }
      }
    }
  };

  await processFiles(files);
  return {copied, skipped, toMerge};
};

const mergeFiles = (toMerge) => {
  if (toMerge.length === 0) return {merged: [], failed: [], unchanged: []};

  const merged = [], failed = [], unchanged = [];

  toMerge.forEach(({content, destPath, relativePath, markers}) => {
    const isEnv = path.basename(destPath) === '.env';
    log(`\n  ${COLORS.cyan}•${COLORS.reset} ${COLORS.bold}${relativePath}${COLORS.reset}`);

    try {
      const result = mergeFile(destPath, content, markers, isEnv);
      if (printMergeResults(relativePath, isEnv, result)) merged.push(relativePath); else unchanged.push(relativePath);
    } catch (error) {
      log(`    ${COLORS.red}✗ Error:${COLORS.reset} ${error.message}`, 'red');
      failed.push(relativePath);
    }
  });

  return {merged, failed, unchanged};
};

const main = async () => {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }

  if (command === '--list' || command === '-l') {
    await listAddons();
    process.exit(0);
  }

  console.log();
  log(`  ╭${'─'.repeat(62)}╮`);
  log(`  │  ${COLORS.bold}Installing add-on: ${COLORS.cyan}${command}${COLORS.reset}${' '.repeat(41 - command.length)}│`);
  log(`  ╰${'─'.repeat(62)}╯`);
  console.log();
  log('  📦 Downloading add-on from GitHub...', 'bold');

  let copied, skipped, toMerge;

  try {
    ({copied, skipped, toMerge} = await downloadAddonFiles(command, process.cwd()));
  } catch (error) {
    console.log();
    log(`  ${COLORS.red}✗${COLORS.reset} ${error.message}`, 'red');
    log(`  ${COLORS.dim}Run ${COLORS.cyan}npx @ijuantm/simpl-addon --list${COLORS.reset}${COLORS.dim} to see available add-ons${COLORS.reset}`);
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
