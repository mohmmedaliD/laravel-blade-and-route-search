const vscode = require('vscode');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

class RouteSearchProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = null;
        this._routes = null;
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Register the message listener BEFORE setting the HTML: the webview
        // script posts 'loadRoutes' as soon as it runs, and if the listener
        // isn't registered yet that message is lost and the view stays loading.
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'loadRoutes') {
                await this._loadRoutes();
                this._sendRoutes(this._routes);
            }
            else if (message.type === 'search') {
                // ⬅️ Spinner while searching
                this._view.webview.postMessage({ type: 'loading', message: 'Searching...' });
                const autoOpen = message.autoOpen;
                setTimeout(() => {
                    const filtered = this._filterRoutes(message.value);
                    this._sendRoutes(filtered, autoOpen);
                }, 50);
            }
            else if (message.type === 'open') {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) return;
                const route = message.route;
                const actionStr = route.action || '';
                const isClosure = !actionStr || actionStr === 'Closure' || !actionStr.includes('@');
                
                if (actionStr.includes('ApiPlatform')) {
                    await openApiPlatformRoute(route, workspaceFolder.uri.fsPath);
                } else if (actionStr.includes('Filament')) {
                    await openFilamentRoute(route, workspaceFolder.uri.fsPath);
                } else if (isClosure) {
                    vscode.window.showInformationMessage('⚠️ This route uses a Closure');
                } else {
                    openRouteController(route, workspaceFolder.uri.fsPath);
                }
            }
            else if (message.type === 'refresh') {
                await this._refreshRoutes();
            }
            else if (message.type === 'reset') {
                if (!this._routes) await this._loadRoutes();
                this._sendRoutes(this._routes || []);
            }
        });

        webviewView.webview.html = this._getHtml();
        if (this._routes) this._sendRoutes(this._routes);
    }

    _sendRoutes(routes, autoOpen) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'routes', routes: routes || [], autoOpen: !!autoOpen });
        }
    }

    async _loadRoutes() {
        if (this._routes) return;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { this._routes = []; return; }
        
        this._view.webview.postMessage({ type: 'loading', message: 'Loading routes...' });
        
        return new Promise((resolve) => {
            exec('php artisan route:list --json', {
                cwd: workspaceFolder.uri.fsPath,
                maxBuffer: 1024 * 1024 * 5,
                timeout: 30000
            }, (error, stdout, stderr) => {
                if (error) {
                    this._routes = [];
                    this._view.webview.postMessage({
                        type: 'error',
                        message: 'Failed to run "php artisan route:list": ' + ((stderr || '').trim() || error.message)
                    });
                    resolve(); return;
                }
                try {
                    this._routes = JSON.parse(stdout);
                    if (!Array.isArray(this._routes)) this._routes = [];
                } catch (e) {
                    this._routes = [];
                    this._view.webview.postMessage({
                        type: 'error',
                        message: 'Failed to parse route:list output (invalid JSON)'
                    });
                }
                resolve();
            });
        });
    }

    async _refreshRoutes() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        this._view.webview.postMessage({ type: 'loading', message: 'Clearing routes...' });

        await new Promise((resolve) => {
            exec('php artisan route:clear', {
                cwd: workspaceFolder.uri.fsPath,
                timeout: 30000
            }, () => resolve());
        });

        this._view.webview.postMessage({ type: 'loading', message: 'Reloading routes...' });

        this._routes = null;
        await this._loadRoutes();
        this._sendRoutes(this._routes);
    }

    _filterRoutes(searchValue) {
        if (!this._routes) return [];
        if (!searchValue.trim()) return this._routes;

        let normalized = normalizeUrlToPath(searchValue);

        const searchParts = normalized.split('/').filter(p => p);
        if (searchParts.length === 0) return this._routes;
        
        return this._routes.map(route => {
            const routeParts = (route.uri || '').split('/').filter(p => p);
            const score = calculateSegmentScore(searchParts, routeParts);
            return { score: score, route: route };
        }).filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(x => x.route);
    }

    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        * { box-sizing: border-box; }
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 10px; margin: 0; }
        
        .toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
        .toolbar button {
            flex: 0 0 auto;
            width: 28px;
            height: 28px;
            padding: 5px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: opacity 0.15s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .toolbar button svg { width: 100%; height: 100%; }
        .toolbar button:hover { opacity: 0.85; }
        .btn-refresh { background: var(--vscode-button-background); }
        .btn-reset   { background: var(--vscode-button-secondaryBackground, #6c757d); }
        
        #search { width: 100%; padding: 8px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font-size: 13px; outline: none; }
        #search:focus { border-color: var(--vscode-focusBorder); }
        #count { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 8px 0; text-align: left; }
        
        .route-item { padding: 10px; margin-bottom: 6px; border-radius: 6px; cursor: pointer; border: 1px solid var(--vscode-panel-border); transition: background 0.15s; overflow-wrap: anywhere; word-break: break-word; }
        .route-item:hover { background: var(--vscode-list-hoverBackground); }
        .route-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .uri { font-size: 14px; font-weight: bold; flex: 1; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
        .action { font-size: 12px; font-weight: bold; color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground)); margin-top: 6px; direction: ltr; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
        .method { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; white-space: normal; flex-shrink: 0; overflow-wrap: anywhere; word-break: break-word; }
        .method-get     { background: #28a745; color: #fff; }
        .method-head    { background: #17a2b8; color: #fff; }
        .method-post    { background: #007bff; color: #fff; }
        .method-put     { background: #fd7e14; color: #fff; }
        .method-patch   { background: #ffc107; color: #000; }
        .method-delete  { background: #dc3545; color: #fff; }
        .method-options { background: #6f42c1; color: #fff; }
        .method-default { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .action { font-size: 12px; font-weight: bold; color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground)); margin-top: 6px; direction: ltr; text-align: left; }
        .empty { text-align: center; padding: 30px 10px; color: var(--vscode-descriptionForeground); }
        
        .loading-container { text-align: center; padding: 40px 10px; color: var(--vscode-descriptionForeground); }
        .spinner {
            width: 24px; height: 24px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 12px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="toolbar">
        <div style="flex: 2;">
            Laravel Route Search
        </div>
        <button class="btn-refresh" id="btnRefresh" title="Update">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
        </button>
        <button class="btn-reset" id="btnReset" title="Reset">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/></svg>
        </button>
    </div>
    <input type="text" id="search" placeholder="Type URI to search..." autocomplete="off" />
    <div id="count"></div>
    <div id="results">
        <div class="loading-container">
            <div class="spinner"></div>
            <div>Loading routes...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('search');
        const resultsDiv = document.getElementById('results');
        const countDiv = document.getElementById('count');
        let selectedIndex = -1;
        let routesLoaded = false;
        
        vscode.postMessage({ type: 'loadRoutes' });
        
        // If the initial 'loadRoutes' message was lost, retry once.
        setTimeout(() => {
            if (!routesLoaded) vscode.postMessage({ type: 'loadRoutes' });
        }, 2000);
        
        document.getElementById('btnRefresh').addEventListener('click', () => {
            searchInput.value = '';
            selectedIndex = -1;
            vscode.postMessage({ type: 'refresh' });
        });
        
        document.getElementById('btnReset').addEventListener('click', () => {
            searchInput.value = '';
            selectedIndex = -1;
            vscode.postMessage({ type: 'reset' });
        });
        
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'routes') {
                routesLoaded = true;
                renderResults(msg.routes);
                if (msg.autoOpen && msg.routes.length > 0) {
                    const first = resultsDiv.querySelector('.route-item');
                    if (first) first.click();
                }
            }
            else if (msg.type === 'setSearch') {
                searchInput.value = msg.value;
                selectedIndex = -1;
                if (!msg.value.trim()) {
                    vscode.postMessage({ type: 'reset' });
                } else if (msg.autoOpen) {
                    waitForRoutesThenSearch(msg.value);
                } else {
                    vscode.postMessage({ type: 'search', value: msg.value });
                }
            }
            else if (msg.type === 'loading') {
                resultsDiv.innerHTML = '<div class="loading-container"><div class="spinner"></div><div>' + escapeHtml(msg.message) + '</div></div>';
                countDiv.textContent = '';
            }
            else if (msg.type === 'error') {
                routesLoaded = true;
                resultsDiv.innerHTML = '<div class="empty">❌ ' + escapeHtml(msg.message) + '</div>';
                countDiv.textContent = '';
            }
        });
        
        searchInput.addEventListener('input', (e) => {
            selectedIndex = -1;
            let value = extractPath(e.target.value);
            if (value !== e.target.value) {
                searchInput.value = value;
            }
            if (!value.trim()) {
                vscode.postMessage({ type: 'reset' });
                return;
            }
            vscode.postMessage({ type: 'search', value: value });
        });

        function waitForRoutesThenSearch(value) {
            if (routesLoaded) {
                vscode.postMessage({ type: 'search', value: value, autoOpen: true });
                return;
            }
            setTimeout(() => waitForRoutesThenSearch(value), 100);
        }
        
        function extractPath(value) {
            let v = value.trim();
            if (/^https?:\\/\\//i.test(v)) {
                v = v.replace(/^https?:\\/\\/[^\\/\\s]+/i, '');
            } else if (/^[a-z0-9.-]+:\\d+[\\/\\s]?/i.test(v)) {
                v = v.replace(/^[a-z0-9.-]+:\\d+/i, '');
            } else if (/^[a-z0-9-]+(\\.[a-z0-9-]+)+(\\/|$)/i.test(v)) {
                v = v.replace(/^[a-z0-9-]+(\\.[a-z0-9-]+)+/i, '');
            }
            return v.replace(/^\\//, '');
        }
        
        searchInput.addEventListener('keydown', (e) => {
            const items = resultsDiv.querySelectorAll('.route-item');
            if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, items.length - 1); updateSelection(items); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, -1); updateSelection(items); }
            else if (e.key === 'Enter' && selectedIndex >= 0 && items[selectedIndex]) { e.preventDefault(); items[selectedIndex].click(); }
        });
        
        function updateSelection(items) {
            items.forEach((item, i) => { item.classList.toggle('selected', i === selectedIndex); });
            if (items[selectedIndex]) items[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
        
        function getMethodClass(method) {
            const m = (method || 'GET').toUpperCase();
            if (m.includes('GET'))     return 'method-get';
            if (m.includes('HEAD'))    return 'method-head';
            if (m.includes('POST'))    return 'method-post';
            if (m.includes('PUT'))     return 'method-put';
            if (m.includes('PATCH'))   return 'method-patch';
            if (m.includes('DELETE'))  return 'method-delete';
            if (m.includes('OPTIONS')) return 'method-options';
            return 'method-default';
        }
        
        function renderResults(routes) {
            resultsDiv.innerHTML = '';
            countDiv.textContent = routes.length + ' results';
            if (routes.length === 0) { resultsDiv.innerHTML = '<div class="empty">No matching results</div>'; return; }
            
            routes.forEach((route, index) => {
                const div = document.createElement('div');
                div.className = 'route-item';
                div.dataset.index = index;
                const actionText = route.action || 'Closure';
                const methodClass = getMethodClass(route.method);
                div.innerHTML = '<div class="top-row"><span class="method ' + methodClass + '">' + escapeHtml(route.method || 'GET') + '</span><span class="uri">' + escapeHtml(route.uri || '') + '</span></div><div class="action">' + escapeHtml(actionText) + '</div>';
                div.addEventListener('click', () => { vscode.postMessage({ type: 'open', route: route }); });
                resultsDiv.appendChild(div);
            });
        }
        
        function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    </script>
</body>
</html>`;
    }
}

function activate(context) {
    const provider = new RouteSearchProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('laravelBlade.routeSearchView', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    let bladeDisposable = vscode.commands.registerCommand('laravelBlade.searchView', async function () {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a Blade file first'); return; }
        const filePath = editor.document.fileName;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!workspaceFolder) { vscode.window.showWarningMessage('File is not in a workspace'); return; }
        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const viewsMatch = relativePath.match(/^resources[\\\/]views[\\\/](.+)\.blade\.php$/i);
        if (!viewsMatch) { vscode.window.showWarningMessage('Not a Blade file inside resources/views'); return; }
        let viewPath = viewsMatch[1].replace(/[\\\/]/g, '.');
        await vscode.commands.executeCommand('workbench.action.findInFiles', {
            query: viewPath, filesToInclude: 'app/**/*.php', filesToExclude: '',
            triggerSearch: true, matchWholeWord: false, isRegex: false
        });
        vscode.window.showInformationMessage('🔍 Searched for: "' + viewPath + '" in app/**/*.php');
    });

    let lrsearchDisposable = vscode.commands.registerCommand('laravelBlade.lrsearch', async function () {
        await vscode.commands.executeCommand('laravelBlade.routeSearchView.focus');
    });

    let lrsearchUrlDisposable = vscode.commands.registerCommand('laravelBlade.lrsearchUrl', async function (url, autoOpen) {
        if (typeof url !== 'string' || !url.trim()) {
            url = await vscode.window.showInputBox({
                prompt: 'Paste the full URL (e.g. http://localhost:8000/admin/users)',
                placeHolder: 'http://localhost:8000/admin/users',
                ignoreFocusOut: true
            });
        }
        if (!url || !url.trim()) return;

        const pathValue = normalizeUrlToPath(url);

        await vscode.commands.executeCommand('laravelBlade.routeSearchView.focus');
        for (let i = 0; i < 50 && !provider._view; i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (provider._view) {
            provider._view.webview.postMessage({ type: 'setSearch', value: pathValue, autoOpen: !!autoOpen });
        }
    });

    let uriDisposable = vscode.window.registerUriHandler({
        handleUri(uri) {
            if (uri.path === '/searchByUrl') {
                const url = new URLSearchParams(uri.query).get('url');
                if (url) vscode.commands.executeCommand('laravelBlade.lrsearchUrl', url, true);
            }
        }
    });

    context.subscriptions.push(bladeDisposable, lrsearchDisposable, lrsearchUrlDisposable, uriDisposable);
}

function normalizeUrlToPath(value) {
    let v = (value || '').trim();
    if (/^https?:\/\//i.test(v)) {
        v = v.replace(/^https?:\/\/[^\/\s]+/i, '');
    } else if (/^[a-z0-9.-]+:\d+[\/\s]?/i.test(v)) {
        v = v.replace(/^[a-z0-9.-]+:\d+/i, '');
    } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(v)) {
        v = v.replace(/^[a-z0-9-]+(\.[a-z0-9-]+)+/i, '');
    }
    return v.replace(/^\//, '');
}

function calculateSegmentScore(searchParts, routeParts) {
    if (searchParts.length === 0 || routeParts.length === 0) return 0;
    
    if (routeParts.length < searchParts.length) {
        var searchIdx = 0;
        var matchCount = 0;
        for (var i = 0; i < routeParts.length && searchIdx < searchParts.length; i++) {
            if (routePartMatches(routeParts[i], searchParts[searchIdx])) {
                searchIdx++;
                matchCount++;
            }
        }
        if (matchCount === routeParts.length) {
            return 100;
        }
        return 0;
    }

    var prefixMatches = 0;
    for (var i = 0; i < searchParts.length; i++) {
        if (routePartMatches(routeParts[i], searchParts[i])) {
            prefixMatches++;
        } else {
            break;
        }
    }

    if (prefixMatches === searchParts.length) {
        var bonus = (routeParts.length === searchParts.length) ? 50 : 0;
        return 1000 + prefixMatches + bonus;
    }

    var searchIdx = 0;
    var matchCount = 0;
    for (var i = 0; i < routeParts.length && searchIdx < searchParts.length; i++) {
        if (routePartMatches(routeParts[i], searchParts[searchIdx])) {
            searchIdx++;
            matchCount++;
        }
    }

    if (matchCount === searchParts.length) {
        return 200 + matchCount * 5;
    }

    return 0;
}

function routePartMatches(routePart, searchPart) {
    var rp = routePart.toLowerCase();
    if (rp.startsWith('{')) return true;
    return rp === searchPart.toLowerCase();
}

async function openRouteController(route, projectPath) {
    var action = route.action;
    if (!action || typeof action !== 'string' || !action.includes('@')) {
        vscode.window.showWarningMessage('No controller for this route'); return;
    }
    var atIndex = action.lastIndexOf('@');
    var controllerFull = action.substring(0, atIndex);
    var method = action.substring(atIndex + 1);
    var cleanController = controllerFull;
    if (cleanController.startsWith('\\')) cleanController = cleanController.substring(1);
    var relativeClassPath = cleanController.replace(/\\/g, '/') + '.php';
    var possiblePaths = [
        path.join(projectPath, relativeClassPath),
        path.join(projectPath, 'app', relativeClassPath),
        path.join(projectPath, 'app', 'Http', 'Controllers', relativeClassPath),
    ];
    if (cleanController.startsWith('App\\') || cleanController.startsWith('App/')) {
        var withoutApp = cleanController.substring(4).replace(/\\/g, '/') + '.php';
        possiblePaths.push(path.join(projectPath, 'app', withoutApp));
    }
    var controllerPath = null;
    for (var i = 0; i < possiblePaths.length; i++) {
        if (fs.existsSync(possiblePaths[i])) { controllerPath = possiblePaths[i]; break; }
    }
    if (!controllerPath) {
        vscode.window.showWarningMessage('❌ Controller not found: ' + controllerFull); return;
    }
    try {
        var doc = await vscode.workspace.openTextDocument(controllerPath);
        var editor = await vscode.window.showTextDocument(doc);
        var text = doc.getText();
        var lines = text.split('\n');
        var methodPattern = new RegExp('(?:public\\s+|protected\\s+|private\\s+)?function\\s+' + method + '\\s*\\(');
        var lineIndex = -1;
        for (var i = 0; i < lines.length; i++) {
            if (methodPattern.test(lines[i])) { lineIndex = i; break; }
        }
        if (lineIndex !== -1) {
            var position = new vscode.Position(lineIndex, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    } catch (err) {
        vscode.window.showErrorMessage('Error opening controller: ' + err.message);
    }
}

async function openFilamentRoute(route, projectPath) {
    var action = route.action;
    if (!action || typeof action !== 'string') {
        vscode.window.showWarningMessage('No action for this route'); return;
    }

    var atIndex = action.lastIndexOf('@');
    var controllerFull = atIndex !== -1 ? action.substring(0, atIndex) : action;
    var method = atIndex !== -1 ? action.substring(atIndex + 1) : null;
    var cleanController = controllerFull;
    if (cleanController.startsWith('\\')) cleanController = cleanController.substring(1);
    var relativeClassPath = cleanController.replace(/\\/g, '/') + '.php';

    var possiblePaths = [
        path.join(projectPath, relativeClassPath),
        path.join(projectPath, 'app', relativeClassPath),
    ];
    if (cleanController.startsWith('App\\') || cleanController.startsWith('App/')) {
        var withoutApp = cleanController.substring(4).replace(/\\/g, '/') + '.php';
        possiblePaths.push(path.join(projectPath, 'app', withoutApp));
    }
    if (cleanController.startsWith('Filament\\') || cleanController.startsWith('Filament/')) {
        var withoutFilament = cleanController.substring(9).replace(/\\/g, '/') + '.php';
        possiblePaths.push(path.join(projectPath, 'vendor', 'filament', 'filament', 'src', withoutFilament));
        possiblePaths.push(path.join(projectPath, 'vendor', 'filament', 'support', 'src', withoutFilament));
    }

    var targetPath = null;
    for (var i = 0; i < possiblePaths.length; i++) {
        if (fs.existsSync(possiblePaths[i])) { targetPath = possiblePaths[i]; break; }
    }
    if (!targetPath) {
        vscode.window.showWarningMessage('❌ Filament file not found: ' + controllerFull); return;
    }

    try {
        var doc = await vscode.workspace.openTextDocument(targetPath);
        var editor = await vscode.window.showTextDocument(doc);
        if (method) {
            var text = doc.getText();
            var lines = text.split('\n');
            var methodPattern = new RegExp('(?:public\\s+|protected\\s+|private\\s+)?function\\s+' + method + '\\s*\\(');
            var lineIndex = -1;
            for (var l = 0; l < lines.length; l++) {
                if (methodPattern.test(lines[l])) { lineIndex = l; break; }
            }
            if (lineIndex !== -1) {
                var position = new vscode.Position(lineIndex, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }
        }
    } catch (err) {
        vscode.window.showErrorMessage('Error opening Filament file: ' + err.message);
    }
}

async function openApiPlatformRoute(route, projectPath) {
    var uri = route.uri || '';
    var method = (route.method || 'GET').toUpperCase();
    
    var className = 'Post';
    if (method.includes('GET'))      className = 'Get';
    else if (method.includes('POST'))    className = 'Post';
    else if (method.includes('PUT'))     className = 'Put';
    else if (method.includes('PATCH'))   className = 'Patch';
    else if (method.includes('DELETE'))  className = 'Delete';
    
    var searchUri = uri.replace(/^api\//, '');
    
    var files = [];
    function collectPhpFiles(dir) {
        var items;
        try { items = fs.readdirSync(dir); } catch (e) { return; }
        for (var i = 0; i < items.length; i++) {
            var fullPath = path.join(dir, items[i]);
            var stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                collectPhpFiles(fullPath);
            } else if (fullPath.endsWith('.php')) {
                files.push(fullPath);
            }
        }
    }
    collectPhpFiles(path.join(projectPath, 'app'));
    
    var foundFile = null;
    var foundLine = -1;
    
    for (var i = 0; i < files.length; i++) {
        var content = fs.readFileSync(files[i], 'utf8');
        var lines = content.split('\n');
        
        var patterns = [
            "uriTemplate: '/" + searchUri + "'",
            'uriTemplate: "/' + searchUri + '"',
            "uriTemplate: '" + searchUri + "'",
            'uriTemplate: "' + searchUri + '"',
        ];
        
        var uriLine = -1;
        for (var l = 0; l < lines.length; l++) {
            for (var p = 0; p < patterns.length; p++) {
                if (lines[l].includes(patterns[p])) {
                    uriLine = l;
                    break;
                }
            }
            if (uriLine !== -1) break;
        }
        
        if (uriLine !== -1) {
            var newPattern = 'new ' + className + '(';
            for (var l = uriLine; l >= 0; l--) {
                if (lines[l].includes(newPattern)) {
                    foundFile = files[i];
                    foundLine = l;
                    break;
                }
            }
            if (foundFile) break;
            
            var attrPattern = '#[' + className + '(';
            for (var l = uriLine; l >= 0; l--) {
                if (lines[l].includes(attrPattern)) {
                    foundFile = files[i];
                    foundLine = l;
                    break;
                }
            }
            if (foundFile) break;
        }
    }
    
    if (!foundFile) {
        vscode.window.showWarningMessage('❌ ApiPlatform route not found: ' + uri);
        return;
    }
    
    try {
        var doc = await vscode.workspace.openTextDocument(foundFile);
        var editor = await vscode.window.showTextDocument(doc);
        var position = new vscode.Position(foundLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    } catch (err) {
        vscode.window.showErrorMessage('Error opening file: ' + err.message);
    }
}

function deactivate() {}
module.exports = { activate: activate, deactivate: deactivate };