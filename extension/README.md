# Laravel Blade & Route Search

A VS Code extension for Laravel developers that makes it easier to search route URIs and locate the matching Blade view or controller.

## What it does

- Converts a Blade view path to dot notation
- Searches for that view in Laravel application PHP files
- Shows Laravel routes in a sidebar panel
- Opens the controller method or resource class used by a route

## Commands

- `Laravel: Search Blade View in Controllers`
- `lrsearch: Open Laravel Route Search`

## Usage

1. Open a Blade file inside `resources/views`.
2. Run the command `Laravel: Search Blade View in Controllers`.
3. The extension searches for the corresponding view path in the app code.
4. Use the sidebar route search to filter and open matching routes.

## Development

```bash
cd extension
npm install
```

Then press `F5` in VS Code to launch the extension in an Extension Development Host.

## Packaging

```bash
cd extension
vsce package
```

## Publish

```bash
cd extension
vsce publish
```

## Support

This extension is intended for Laravel projects using standard MVC conventions and route lists.
