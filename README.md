# Laravel Blade & Route Search

This project is a Visual Studio Code extension for Laravel developers. It helps you:

- find the controller behind a Blade view
- search Laravel routes by URI
- open route definitions and controller methods quickly from the sidebar

## Features

- Search Blade view names inside `resources/views`
- Locate matching controller methods in `app/**/*.php`
- Search routes directly from a sidebar webview
- Open route controllers or ApiPlatform resource definitions with one click

## Installation

1. Open the extension folder.
2. Run:

```bash
npm install
```

3. Press `F5` in VS Code to run the extension in the Extension Development Host.

## Build

```bash
bash build.sh
```

## Publish to VS Code Marketplace

1. Update the version in `extension/package.json`.
2. Build the extension package:

```bash
cd extension
vsce package
```

3. Publish via the VS Code Marketplace publisher account:

```bash
vsce publish
```

## GitHub

Create a repository and push the project:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

## Project structure

```text
.
├── build.sh
├── README.md
├── LICENSE
├── extension/
│   ├── extension.js
│   ├── icon.svg
│   ├── package.json
│   └── README.md
└── .vscodeignore
```

## License

This project is licensed under the MIT License.
