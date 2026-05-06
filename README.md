# Simpl Add-on Installer

CLI tool for installing Simpl framework add-ons with `npx`.

## What it does

- Downloads the selected Simpl add-on for your project version
- Copies new files into the current project directory
- Merges existing files using add-on markers
- Keeps existing content when no merge markers are present

## Usage

Run the installer from the root of a Simpl project. The project must contain a `.simpl` file with a `version` field so the installer can match the add-on version to your Simpl framework version.

Run the installer with no arguments to be prompted for the add-on:

```bash
npx @ijuantm/simpl-addon
```

Or provide the add-on name up front:

```bash
npx @ijuantm/simpl-addon auth
```

You can also pass explicit options:

```bash
npx @ijuantm/simpl-addon --addon=auth
```

The first non-flag argument is treated as the add-on name. If you do not pass `--addon`, the installer will ask for it interactively.

### Available options

| Option                        | Description                                         |
|-------------------------------|-----------------------------------------------------|
| `--addon=<name>`, `-a=<name>` | Add-on to install.                                  |
| `--list`, `-l`                | List all available add-ons for the current version. |
| `--help`, `-h`                | Show the help message.                              |

### Helpful commands

List available add-ons:

```bash
npx @ijuantm/simpl-addon --list
```

Show help:

```bash
npx @ijuantm/simpl-addon --help
```

## How it works

The installer reads special markers in add-on files to safely merge content. Content for a marker is read from the marker line until `@addon-end`:

```php
// @addon-insert:after('existing line')
new AuthController();
// @addon-end
```

Supported markers:

- `@addon-insert:after('text')` - Insert content after a matching line
- `@addon-insert:before('text')` - Insert content before a matching line
- `@addon-insert:replace('text')` - Replace a matching line with content
- `@addon-insert:prepend` - Add content at the beginning of the file
- `@addon-insert:append` - Add content at the end of the file

The installer also:

- Creates new files that do not exist
- Skips files without markers instead of overwriting them
- Avoids adding the same content twice

## Requirements

- **Node.js**: >= 22
- **Simpl Framework**: A Simpl project with a valid `.simpl` file in the project root
