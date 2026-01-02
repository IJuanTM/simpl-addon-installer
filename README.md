# Simpl Add-on Installer

CLI tool for installing Simpl framework add-ons automatically using npx.

## Usage

### List Available Add-ons

```bash
npx @ijuantm/simpl-addon --list
```

### Install an Add-on

Navigate to your Simpl project directory and run the following command. For example, to install the "auth" add-on:

```bash
npx @ijuantm/simpl-addon auth
```

The installer will:

1. Download the add-on
2. Copy new files to your project
3. Merge existing files using markers

### Get Help

```bash
npx @ijuantm/simpl-addon --help
```

## How It Works

The installer uses special markers in add-on files to safely merge content:

```php
// @addon-insert:after('existing line')
new AuthController();
// @addon-end
```

**Supported Markers:**

- `@addon-insert:after('text')` - Insert content after matching line
- `@addon-insert:before('text')` - Insert content before matching line
- `@addon-insert:prepend` - Add content at the beginning of the file
- `@addon-insert:append` - Add content at the end of the file

The installer:

- Creates new files that don't exist
- Merges files with markers automatically
- Skips files without markers (no overwriting)
- Detects duplicate content (won't add twice)

## Requirements

- **Node.js**: >= 20.x.x
- **Simpl Framework**: A (preferably clean) installation of Simpl, if not clean, some manual merging may be required, or the installer may skip files or break things (you have been warned).
