import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// ─── Types ─────────────────────────────────────────────

interface LocalModelInfo {
    name: string;
    /** Absolute filesystem path to the .model3.json / .model.json file */
    modelFilePath: string;
    thumbnailFilePath?: string;
}

interface ModelEntry {
    name: string;
    /** The patched JSON object — passed directly to Live2DModel.from() */
    modelObj?: Record<string, unknown>;
    thumbnail?: string;
    /** "local" | "remote" */
    source: "local" | "remote";
    /** For remote models: original raw URL (used as display/fallback info) */
    remoteUrl?: string;
}

interface PomodoroState {
    running: boolean;
    timeLeft: number;
    mode: "work" | "break";
    workMinutes: number;
    breakMinutes: number;
}

// ─── Pomodoro Timer ────────────────────────────────────

class PomodoroTimer {
    private interval: NodeJS.Timeout | null = null;
    private state: PomodoroState;
    private webviews: Set<vscode.Webview> = new Set();

    constructor(workMinutes: number, breakMinutes: number) {
        this.state = {
            running: false,
            timeLeft: workMinutes * 60,
            mode: "work",
            workMinutes,
            breakMinutes,
        };
    }

    addWebview(w: vscode.Webview) {
        this.webviews.add(w);
        this.notify();
    }

    removeWebview(w: vscode.Webview) {
        this.webviews.delete(w);
    }

    configure(work: number, breakM: number) {
        this.state.workMinutes = work;
        this.state.breakMinutes = breakM;
        if (!this.state.running) {
            this.state.timeLeft = (this.state.mode === "work" ? work : breakM) * 60;
            this.notify();
        }
    }

    start() {
        if (this.state.running) return;
        this.state.running = true;
        this.interval = setInterval(() => this.tick(), 1000);
        this.notify();
    }

    stop() {
        this.state.running = false;
        if (this.interval) { clearInterval(this.interval); this.interval = null; }
        this.notify();
    }

    reset() {
        this.stop();
        this.state.mode = "work";
        this.state.timeLeft = this.state.workMinutes * 60;
        this.notify();
    }

    private tick() {
        this.state.timeLeft--;
        if (this.state.timeLeft <= 0) {
            this.state.mode = this.state.mode === "work" ? "break" : "work";
            this.state.timeLeft = (this.state.mode === "work"
                ? this.state.workMinutes : this.state.breakMinutes) * 60;
            const msg = this.state.mode === "work"
                ? "Break over! Time to work." : "Work session done! Take a break.";
            vscode.window.showInformationMessage(`🍅 Pomodoro: ${msg}`);
        }
        this.notify();
    }

    public notify() {
        for (const w of this.webviews) {
            try { w.postMessage({ type: "pomodoro", data: this.state }); } catch {}
        }
    }

    getState(): PomodoroState { return { ...this.state }; }
}

// ─── Model Scanner ─────────────────────────────────────

async function scanModelsInDir(rootDir: string, results: LocalModelInfo[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    } catch { return; }

    const files = entries.filter(e => e.isFile()).map(e => e.name);
    const modelFile = files.find(f => f.endsWith(".model3.json") || f.endsWith(".model.json"));

    if (modelFile) {
        const thumbnailFile =
            files.find(f =>
                (f.toLowerCase().includes("thumbnail") || f.toLowerCase().includes("preview") || f.toLowerCase().includes("icon")) &&
                (f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg"))
            ) ||
            files.find(f => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.toLowerCase().includes("texture"));

        results.push({
            name: path.basename(rootDir),
            modelFilePath: path.join(rootDir, modelFile),
            thumbnailFilePath: thumbnailFile ? path.join(rootDir, thumbnailFile) : undefined,
        });
    }

    for (const e of entries) {
        if (e.isDirectory()) await scanModelsInDir(path.join(rootDir, e.name), results);
    }
}

async function scanLocalModels(extensionPath: string): Promise<LocalModelInfo[]> {
    const results: LocalModelInfo[] = [];
    const builtinDir = path.join(extensionPath, "anime-overlay", "public", "models");
    await scanModelsInDir(builtinDir, results);

    const extraDir = vscode.workspace.getConfiguration("animeAssistant").get<string>("extraModelsDir", "").trim();
    if (extraDir && fs.existsSync(extraDir)) await scanModelsInDir(extraDir, results);

    const seen = new Set<string>();
    return results.filter(m => {
        const k = m.modelFilePath.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
    });
}

// ─── JSON Patcher ──────────────────────────────────────

function toWebviewUri(webview: vscode.Webview, modelDir: string, rel: string): string {
    const abs = path.join(modelDir, ...rel.replace(/\//g, path.sep).split(path.sep));
    return webview.asWebviewUri(vscode.Uri.file(abs)).toString();
}

function patchValue(webview: vscode.Webview, modelDir: string, val: unknown): unknown {
    if (typeof val === "string" && val && !val.startsWith("http") && !val.startsWith("vscode-") && !val.startsWith("data:")) {
        return toWebviewUri(webview, modelDir, val);
    }
    if (Array.isArray(val)) return val.map(v => patchValue(webview, modelDir, v));
    if (val && typeof val === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            if (["Moc", "Physics", "DisplayInfo", "UserData", "Pose", "File", "Sound"].includes(k)) {
                out[k] = typeof v === "string" ? patchValue(webview, modelDir, v) : v;
            } else if (k === "Textures" || k === "Expressions" || k === "Motions") {
                out[k] = patchValue(webview, modelDir, v);
            } else {
                out[k] = (v && typeof v === "object") ? patchValue(webview, modelDir, v) : v;
            }
        }
        return out;
    }
    return val;
}

async function buildModelEntry(
    info: LocalModelInfo,
    webview: vscode.Webview
): Promise<ModelEntry> {
    const raw = await fs.promises.readFile(info.modelFilePath, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;
    const modelDir = path.dirname(info.modelFilePath);
    const patched = patchValue(webview, modelDir, json) as Record<string, unknown>;

    patched.url = webview.asWebviewUri(vscode.Uri.file(info.modelFilePath)).toString();

    const thumbnail = info.thumbnailFilePath
        ? webview.asWebviewUri(vscode.Uri.file(info.thumbnailFilePath)).toString()
        : undefined;

    return { name: info.name, modelObj: patched, thumbnail, source: "local" };
}

// ─── Webview Provider ──────────────────────────────────

class AnimeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "animeView";
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _timer: PomodoroTimer;
    private _voiceEnabled: boolean;
    private _selectedModel: string | null;
    private _activeWebviews: Set<vscode.Webview> = new Set();

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext, timer: PomodoroTimer) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._timer = timer;
        const config = vscode.workspace.getConfiguration("animeAssistant");
        this._voiceEnabled = config.get("voiceEnabled", true);
        this._selectedModel = context.globalState.get("anime.selectedModel", null);
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        console.log("🎬 resolveWebviewView CALLED");
        try {
            this._view = webviewView;
            this.attachWebview(webviewView.webview, "main");
        } catch (err) {
            console.error("AnimeViewProvider error:", err);
            vscode.window.showErrorMessage("Anime Assistant failed to load: " + String(err));
        }
    }

    setupPanel(panel: vscode.WebviewPanel) {
        this.attachWebview(panel.webview, "main");
        panel.onDidDispose(() => {
            this._activeWebviews.delete(panel.webview);
            this._timer.removeWebview(panel.webview);
        });
    }

    setupCleanPanel(panel: vscode.WebviewPanel) {
        this.attachWebview(panel.webview, "clean");
        panel.onDidDispose(() => {
            this._activeWebviews.delete(panel.webview);
            this._timer.removeWebview(panel.webview);
        });
    }

    setupCleanView(webviewView: vscode.WebviewView) {
        this.attachWebview(webviewView.webview, "clean");
    }

    private attachWebview(webview: vscode.Webview, mode: "main" | "clean") {
        this._activeWebviews.add(webview);
        this._timer.addWebview(webview);

        const extraDir = vscode.workspace.getConfiguration("animeAssistant").get<string>("extraModelsDir", "").trim();
        const localRoots: vscode.Uri[] = [this._extensionUri];
        if (extraDir && fs.existsSync(extraDir)) localRoots.push(vscode.Uri.file(extraDir));

        webview.options = {
            enableScripts: true,
            localResourceRoots: localRoots,
        };

        const vendorBase = path.join(this._extensionUri.fsPath, "anime-overlay", "public", "vendor");
        const uri = (p: string) => webview.asWebviewUri(vscode.Uri.file(p)).toString();

        const pixiUri       = uri(path.join(vendorBase, "pixi.min.js"));
        const live2dUri     = uri(path.join(vendorBase, "live2d.min.js"));
        const cubism2Uri    = uri(path.join(vendorBase, "cubism2.min.js"));
        const cubismCoreUri = uri(path.join(vendorBase, "live2dcubismcore.min.js"));
        const cubism4Uri    = uri(path.join(vendorBase, "cubism4.min.js"));
        const pixiLive2dUri = uri(path.join(vendorBase, "pixi-live2d-display.min.js"));

        const nonce = generateNonce();
        const cspSource = webview.cspSource;
        const vendors = { pixiUri, live2dUri, cubism2Uri, cubismCoreUri, cubism4Uri, pixiLive2dUri };

        webview.html = mode === "clean"
            ? this._getCleanHtml(webview, nonce, cspSource, vendors)
            : this._getHtml(webview, nonce, cspSource, vendors);

        webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.type) {
                    case "toggleVoice":
                        this._voiceEnabled = !this._voiceEnabled;
                        await vscode.workspace.getConfiguration("animeAssistant").update("voiceEnabled", this._voiceEnabled, true);
                        this._updateState(); break;
                    case "selectModel":
                        this._selectedModel = msg.name ?? null;
                        await this._context.globalState.update("anime.selectedModel", this._selectedModel);
                        this._updateState(); break;
                    case "openTab":
                        vscode.commands.executeCommand("anime.openTab"); break;
                    case "openCleanTab":
                        vscode.commands.executeCommand("anime.openCleanTab"); break;
                    case "startPomodoro": this._timer.start(); break;
                    case "stopPomodoro": this._timer.stop(); break;
                    case "resetPomodoro": this._timer.reset(); break;
                    case "setWorkMinutes": {
                        const cfg = vscode.workspace.getConfiguration("animeAssistant");
                        this._timer.configure(msg.minutes, cfg.get("pomodoroBreakMinutes", 5));
                        await cfg.update("pomodoroWorkMinutes", msg.minutes, true); break;
                    }
                    case "setBreakMinutes": {
                        const cfg = vscode.workspace.getConfiguration("animeAssistant");
                        this._timer.configure(cfg.get("pomodoroWorkMinutes", 25), msg.minutes);
                        await cfg.update("pomodoroBreakMinutes", msg.minutes, true); break;
                    }
                    case "openSettings":
                        vscode.commands.executeCommand("workbench.action.openSettings", "animeAssistant"); break;
                    case "ready":
                        await this._sendModels(webview);
                        this._updateState();
                        this._timer.notify(); break;
                    case "log":
                        console.log("[Webview]", msg.text); break;
                }
            } catch (err) { console.error("Error handling webview message:", err); }
        });
    }

    private async _sendModels(webview: vscode.Webview) {
        try {
            const locals = await scanLocalModels(this._extensionUri.fsPath);
            const entries: ModelEntry[] = await Promise.all(
                locals.map(m => buildModelEntry(m, webview).catch(err => {
                    console.error(`Failed to build entry for ${m.name}:`, err);
                    return null as unknown as ModelEntry;
                }))
            );
            const valid = entries.filter(Boolean);
            webview.postMessage({ type: "models", data: valid });
        } catch (err) { console.error("Failed to send models:", err); }
    }

    private _updateState() {
        for (const w of this._activeWebviews) {
            try {
                w.postMessage({
                    type: "state",
                    data: { voiceEnabled: this._voiceEnabled, selectedModel: this._selectedModel },
                });
            } catch {}
        }
    }

    // ── Clean Model View HTML (No UI Controls) ───────────────
    private _getCleanHtml(
        webview: vscode.Webview,
        nonce: string,
        cspSource: string,
        vendors: { pixiUri: string; live2dUri: string; cubism2Uri: string; cubismCoreUri: string; cubism4Uri: string; pixiLive2dUri: string; }
    ): string {
        const csp = [
            `default-src 'none'`,
            `script-src 'nonce-${nonce}' 'unsafe-eval' ${cspSource}`,
            `style-src 'unsafe-inline'`,
            `img-src ${cspSource} data: blob: https:`,
            `media-src ${cspSource} blob: https:`,
            `connect-src ${cspSource} data: blob: https:`,
            `worker-src blob:`,
            `font-src ${cspSource} https:`,
        ].join("; ");

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Anime Model View</title>
    <script nonce="${nonce}">
    // Fix XHRLoader URL encoding: file/%2B -> file+  and  %3A -> :
    (function() {
        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string') {
                url = url.replace(/file\/%2B/g, 'file+');
                url = url.replace(/%3A/gi, ':');
            }
            return _open.apply(this, arguments);
        };
    })();
    </script>
    <script nonce="${nonce}" src="${vendors.pixiUri}"></script>
    <script nonce="${nonce}" src="${vendors.live2dUri}"></script>
    <script nonce="${nonce}" src="${vendors.cubism2Uri}"></script>
    <script nonce="${nonce}" src="${vendors.cubismCoreUri}"></script>
    <script nonce="${nonce}" src="${vendors.cubism4Uri}"></script>
    <script nonce="${nonce}" src="${vendors.pixiLive2dUri}"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            width: 100%;
            height: 100%;
            background: transparent;
            overflow: hidden;
        }
        #canvas-area {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            background: transparent;
        }
        #canvas-area canvas {
            display: block;
            width: 100% !important;
            height: 100% !important;
        }
        #model-status {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
            gap: 8px;
            pointer-events: none;
            text-align: center;
        }
        .status-emoji { font-size: 42px; }

        /* ── Context Menu Styles ── */
        .context-menu {
            position: fixed;
            z-index: 9999;
            background: var(--vscode-menu-background, #252526);
            color: var(--vscode-menu-foreground, #cccccc);
            border: 1px solid var(--vscode-menu-border, #454545);
            border-radius: 5px;
            padding: 4px 0;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            font-size: 11px;
            min-width: 140px;
            display: none;
            user-select: none;
        }
        .context-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.1s;
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground, #04395e);
            color: var(--vscode-menu-selectionForeground, #ffffff);
        }
        .context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground, #454545);
            margin: 3px 0;
        }
    </style>
</head>
<body>

<div id="canvas-area">
    <div id="model-status">
        <span class="status-emoji">🎭</span>
        <span id="status-text">Loading model…</span>
    </div>
</div>

<div id="contextMenu" class="context-menu">
    <div class="context-menu-item" id="cmZoomIn">🔍 Увеличить (+10%)</div>
    <div class="context-menu-item" id="cmZoomOut">🔍 Уменьшить (-10%)</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="cmResetScale">↺ Сбросить масштаб</div>
</div>

<script nonce="${nonce}">
(function() {
    'use strict';
    const vscode = acquireVsCodeApi();

    var savedState = vscode.getState() || {};
    var selectedModelName = savedState.selectedModelName || null;

    const GH_OWNER = 'test157t';
    const GH_REPO  = 'Live2dModels-ST-';
    const GH_REF   = 'main';
    const GH_RAW   = 'https://raw.githubusercontent.com/' + GH_OWNER + '/' + GH_REPO + '/' + GH_REF + '/';
    const GH_CDN   = 'https://cdn.jsdelivr.net/gh/' + GH_OWNER + '/' + GH_REPO + '@' + GH_REF + '/';

    let localModels = [];
    let onlineModels = [];
    let pixiApp = null;
    let live2dModel = null;
    let currentScale = 1.0;

    const canvasArea   = document.getElementById('canvas-area');
    const statusEl     = document.getElementById('model-status');
    const statusText   = document.getElementById('status-text');
    const contextMenu  = document.getElementById('contextMenu');
    const cmZoomIn     = document.getElementById('cmZoomIn');
    const cmZoomOut    = document.getElementById('cmZoomOut');
    const cmResetScale = document.getElementById('cmResetScale');

    function hideContextMenu() {
        if (contextMenu) contextMenu.style.display = 'none';
    }

    canvasArea.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (!contextMenu) return;
        const x = Math.min(e.clientX, window.innerWidth - 150);
        const y = Math.min(e.clientY, window.innerHeight - 100);
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.style.display = 'block';
    });

    document.addEventListener('click', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') hideContextMenu();
    });

    cmZoomIn.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = Math.min(5.0, currentScale + 0.1);
        fitModel();
    });

    cmZoomOut.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = Math.max(0.1, currentScale - 0.1);
        fitModel();
    });

    cmResetScale.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = 1.0;
        fitModel();
    });

    canvasArea.addEventListener('wheel', function(e) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        currentScale = Math.max(0.1, Math.min(5.0, currentScale + delta));
        fitModel();
    }, { passive: false });

    function initPixi() {
        if (pixiApp && pixiApp.stage) return true;
        try {
            const w = canvasArea.offsetWidth || window.innerWidth || 300;
            const h = canvasArea.offsetHeight || window.innerHeight || 400;
            vscode.postMessage({ type: 'log', text: 'Clean view initPixi: width=' + w + ' height=' + h });
            pixiApp = new PIXI.Application({
                transparent: true,
                width: w,
                height: h,
                antialias: true,
                autoDensity: true,
                resolution: window.devicePixelRatio || 1,
            });
            if (pixiApp && pixiApp.view && pixiApp.stage) {
                canvasArea.appendChild(pixiApp.view);
                return true;
            }
        } catch(e) {
            console.error('PixiJS init failed:', e);
            statusText.textContent = 'Graphics engine error: ' + (e && e.message ? e.message : String(e));
            vscode.postMessage({ type: 'log', text: 'Clean view PixiJS init error: ' + (e && e.stack ? e.stack : String(e)) });
        }
        return false;
    }

    // Pre-fetch each binary asset as a blob: URL so XHR never sees the raw vscode-resource URL.
    async function buildBlobModelObj(obj) {
        if (!obj) return obj;
        obj = JSON.parse(JSON.stringify(obj));
        async function toBlob(url, mime) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;
            try {
                var r = await fetch(url);
                if (!r.ok) { vscode.postMessage({ type: 'log', text: 'Blob fetch HTTP ' + r.status + ' ' + url }); return url; }
                return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: mime || 'application/octet-stream' }));
            } catch(e) { vscode.postMessage({ type: 'log', text: 'Blob fetch error ' + url + ': ' + e }); return url; }
        }
        if (obj.FileReferences) {
            if (obj.FileReferences.Moc) obj.FileReferences.Moc = await toBlob(obj.FileReferences.Moc, 'application/octet-stream');
            if (obj.FileReferences.Physics) obj.FileReferences.Physics = await toBlob(obj.FileReferences.Physics, 'application/json');
            if (Array.isArray(obj.FileReferences.Textures))
                obj.FileReferences.Textures = await Promise.all(obj.FileReferences.Textures.map(function(t) { return toBlob(t, 'image/png'); }));
        }
        if (obj.model) obj.model = await toBlob(obj.model, 'application/octet-stream');
        if (obj.physics) obj.physics = await toBlob(obj.physics, 'application/json');
        if (Array.isArray(obj.textures)) obj.textures = await Promise.all(obj.textures.map(function(t) { return toBlob(t, 'image/png'); }));
        return obj;
    }

    async function loadModel(modelData) {
        if (!initPixi() || !pixiApp || !pixiApp.stage) return;
        if (!modelData) return;

        vscode.postMessage({ type: 'log', text: 'Clean view: loadModel called for: ' + modelData.name });

        selectedModelName = modelData.name;
        vscode.setState({ selectedModelName: modelData.name, selectedModelData: modelData });

        statusText.textContent = 'Loading ' + modelData.name + '…';
        statusEl.style.display = 'flex';

        if (live2dModel) {
            try {
                if (pixiApp && pixiApp.stage) pixiApp.stage.removeChild(live2dModel);
                live2dModel.destroy();
            } catch(e) {}
            live2dModel = null;
        }

        let modelObj = modelData.modelObj;
        if (modelData.source === 'remote' && modelData.remoteUrl && !modelObj) {
            try {
                modelObj = await fetchAndPatchRemoteModel(modelData.remoteUrl);
                modelData.modelObj = modelObj;
            } catch(e) {
                statusText.textContent = 'Failed to fetch remote model: ' + (e.message || e);
                vscode.postMessage({ type: 'log', text: 'Clean view remote fetch error: ' + e });
                return;
            }
        }

        if (!modelObj) {
            statusText.textContent = 'No model settings available.';
            return;
        }

        try {
            const Live2DModel = PIXI.live2d.Live2DModel;
            vscode.postMessage({ type: 'log', text: 'Clean view: calling Live2DModel.from' });
            var safeModelObj = await buildBlobModelObj(modelObj);
            live2dModel = await Live2DModel.from(safeModelObj, { autoInteract: true });
            fitModel();
            if (pixiApp && pixiApp.stage) pixiApp.stage.addChild(live2dModel);
            statusEl.style.display = 'none';
            vscode.postMessage({ type: 'log', text: 'Clean view: model loaded successfully: ' + modelData.name });
        } catch(e) {
            console.error('Model load error:', e);
            statusText.textContent = 'Failed to load model: ' + (e && e.message ? e.message : String(e));
            vscode.postMessage({ type: 'log', text: 'Clean view model load error: ' + (e && e.stack ? e.stack : String(e)) });
        }
    }

    async function fetchAndPatchRemoteModel(modelJsonUrl) {
        const r = await fetch(modelJsonUrl);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + modelJsonUrl);
        const json = await r.json();
        const base = modelJsonUrl.replace(/\\/[^\\/]*$/, '/');

        function absUrl(rel) {
            if (!rel || rel.startsWith('http')) return rel;
            return new URL(rel, base).href;
        }

        if (json.FileReferences) {
            if (json.FileReferences.Moc) json.FileReferences.Moc = absUrl(json.FileReferences.Moc);
            if (Array.isArray(json.FileReferences.Textures))
                json.FileReferences.Textures = json.FileReferences.Textures.map(absUrl);
            if (json.FileReferences.Physics) json.FileReferences.Physics = absUrl(json.FileReferences.Physics);
            if (json.FileReferences.Expressions)
                json.FileReferences.Expressions = json.FileReferences.Expressions.map(function(e) {
                    if (e.File) e.File = absUrl(e.File); return e;
                });
            if (json.FileReferences.Motions) {
                for (const g of Object.keys(json.FileReferences.Motions)) {
                    (json.FileReferences.Motions[g] || []).forEach(function(m) {
                        if (m.File) m.File = absUrl(m.File);
                        if (m.Sound) m.Sound = absUrl(m.Sound);
                    });
                }
            }
        }
        if (json.model)    json.model    = absUrl(json.model);
        if (json.physics)  json.physics  = absUrl(json.physics);
        if (Array.isArray(json.textures)) json.textures = json.textures.map(absUrl);
        if (json.motions) {
            for (const g of Object.keys(json.motions)) {
                const arr = json.motions[g] || [];
                for (let i = 0; i < arr.length; i++) {
                    const m = arr[i];
                    if (typeof m === 'string') arr[i] = absUrl(m);
                    else { if (m.file) m.file = absUrl(m.file); if (m.File) m.File = absUrl(m.File); }
                }
            }
        }

        json.url = modelJsonUrl;
        return json;
    }

    function fitModel() {
        if (!live2dModel || !pixiApp || !pixiApp.renderer || !pixiApp.stage) return;
        const cw = canvasArea.offsetWidth || window.innerWidth || 300;
        const ch = canvasArea.offsetHeight || window.innerHeight || 400;
        try {
            pixiApp.renderer.resize(cw, ch);
            const scaleToFit = Math.min(
                cw / Math.max(1, (live2dModel.width || 300) / (live2dModel.scale.x || 1)),
                ch / Math.max(1, (live2dModel.height || 400) / (live2dModel.scale.y || 1))
            ) * 0.95 * currentScale;
            if (isFinite(scaleToFit) && scaleToFit > 0) {
                live2dModel.scale.set(scaleToFit);
            }
            live2dModel.x = (cw - (live2dModel.width || 0)) / 2;
            live2dModel.y = (ch - (live2dModel.height || 0)) / 2;
        } catch(e) {}
    }

    new ResizeObserver(() => fitModel()).observe(canvasArea);
    window.addEventListener('resize', fitModel);

    function tryRestoreSelectedModel() {
        if (!selectedModelName) {
            vscode.postMessage({ type: 'log', text: 'Clean view tryRestore: no selectedModelName' });
            return false;
        }
        var foundLocal = localModels.find(function(m) { return m.name === selectedModelName; });
        if (foundLocal) {
            vscode.postMessage({ type: 'log', text: 'Clean view tryRestore: loading local model ' + foundLocal.name });
            loadModel(foundLocal);
            return true;
        }
        var foundOnline = onlineModels.find(function(m) { return m.name === selectedModelName; });
        if (foundOnline) {
            vscode.postMessage({ type: 'log', text: 'Clean view tryRestore: loading online model ' + foundOnline.name });
            loadModel(foundOnline);
            return true;
        }
        if (savedState.selectedModelData && savedState.selectedModelData.name === selectedModelName) {
            vscode.postMessage({ type: 'log', text: 'Clean view tryRestore: loading savedState model ' + savedState.selectedModelData.name });
            loadModel(savedState.selectedModelData);
            return true;
        }
        vscode.postMessage({ type: 'log', text: 'Clean view tryRestore: model not found: ' + selectedModelName + ', localCount=' + localModels.length + ', onlineCount=' + onlineModels.length });
        return false;
    }

    async function loadOnlineCatalog() {
        try {
            let indexData = null;
            for (const url of [INDEX_URL_RAW, INDEX_URL_CDN]) {
                try {
                    const r = await fetch(url);
                    if (r.ok) { indexData = await r.json(); break; }
                } catch {}
            }
            if (!indexData) {
                try {
                    const apiUrl = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/git/trees/' + GH_REF + '?recursive=1';
                    const r = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
                    if (r.ok) {
                        const tree = await r.json();
                        indexData = (tree.tree || []).map(function(item) { return item.path; });
                    }
                } catch {}
            }
            if (!indexData) return;

            const modelPaths = [];
            function collectPaths(node, prefix) {
                if (typeof node === 'string') {
                    var lower = node.toLowerCase();
                    if (lower.endsWith('.model3.json') || lower.endsWith('.model.json')) modelPaths.push(node);
                    return;
                }
                if (Array.isArray(node)) { node.forEach(function(n) { collectPaths(n, prefix); }); return; }
                if (node && typeof node === 'object') {
                    const p = prefix ? prefix + '/' + (node.name || '') : (node.name || '');
                    (node.files || []).forEach(function(f) {
                        var fLower = f.toLowerCase();
                        if (fLower.endsWith('.model3.json') || fLower.endsWith('.model.json')) modelPaths.push(p + '/' + f);
                    });
                    (node.children || []).forEach(function(c) { collectPaths(c, p); });
                }
            }
            collectPaths(indexData, '');

            onlineModels = modelPaths.map(function(p) {
                const name = p.split('/').slice(-2, -1)[0] || p;
                const dir = p.substring(0, p.lastIndexOf('/')) || '';
                const rawUrl = GH_RAW + p;
                const thumbName = (dir.split('/').pop() || '') + '_thumbnail.png';
                const thumbnail = GH_CDN + dir + '/' + thumbName;
                return { name: name, modelObj: undefined, thumbnail: thumbnail, source: 'remote', remoteUrl: rawUrl };
            });

            tryRestoreSelectedModel();
        } catch(e) {}
    }

    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (msg.type === 'models') {
            localModels = msg.data || [];
            vscode.postMessage({ type: 'log', text: 'Clean view received models, count=' + localModels.length });
            if (!tryRestoreSelectedModel() && localModels.length > 0) {
                selectedModelName = localModels[0].name;
                loadModel(localModels[0]);
            }
        }
        if (msg.type === 'state') {
            vscode.postMessage({ type: 'log', text: 'Clean view received state: ' + JSON.stringify(msg.data) });
            if (msg.data.selectedModel && msg.data.selectedModel !== selectedModelName) {
                selectedModelName = msg.data.selectedModel;
                tryRestoreSelectedModel();
            }
        }
    });

    initPixi();
    loadOnlineCatalog();
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }

    // ── Main Webview Panel HTML (With UI Controls) ───────────────
    private _getHtml(
        webview: vscode.Webview,
        nonce: string,
        cspSource: string,
        vendors: { pixiUri: string; live2dUri: string; cubism2Uri: string; cubismCoreUri: string; cubism4Uri: string; pixiLive2dUri: string; }
    ): string {
        const csp = [
            `default-src 'none'`,
            `script-src 'nonce-${nonce}' 'unsafe-eval' ${cspSource}`,
            `style-src 'unsafe-inline'`,
            `img-src ${cspSource} data: blob: https:`,
            `media-src ${cspSource} blob: https:`,
            `connect-src ${cspSource} data: blob: https:`,
            `worker-src blob:`,
            `font-src ${cspSource} https:`,
        ].join("; ");

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Anime Assistant</title>
    <script nonce="${nonce}">
    // Fix XHRLoader URL encoding: file/%2B -> file+  and  %3A -> :
    (function() {
        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string') {
                url = url.replace(/file\/%2B/g, 'file+');
                url = url.replace(/%3A/gi, ':');
            }
            return _open.apply(this, arguments);
        };
    })();
    </script>
    <script nonce="${nonce}" src="${vendors.pixiUri}"></script>
    <script nonce="${nonce}" src="${vendors.live2dUri}"></script>
    <script nonce="${nonce}" src="${vendors.cubism2Uri}"></script>
    <script nonce="${nonce}" src="${vendors.cubismCoreUri}"></script>
    <script nonce="${nonce}" src="${vendors.cubism4Uri}"></script>
    <script nonce="${nonce}" src="${vendors.pixiLive2dUri}"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow-y: auto;
            overflow-x: hidden;
        }

        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
        }

        #canvas-area {
            position: relative;
            width: 100%;
            height: 300px;
            min-height: 180px;
            flex: 0 0 auto;
            background: transparent;
            overflow: hidden;
        }
        #canvas-area canvas {
            display: block;
            width: 100% !important;
            height: 100% !important;
        }
        #model-status {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            gap: 8px;
            pointer-events: none;
            padding: 12px;
            text-align: center;
        }
        .status-emoji { font-size: 36px; }

        /* ── Context Menu Styles ── */
        .context-menu {
            position: fixed;
            z-index: 9999;
            background: var(--vscode-menu-background, #252526);
            color: var(--vscode-menu-foreground, #cccccc);
            border: 1px solid var(--vscode-menu-border, #454545);
            border-radius: 5px;
            padding: 4px 0;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            font-size: 11px;
            min-width: 140px;
            display: none;
            user-select: none;
        }
        .context-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.1s;
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground, #04395e);
            color: var(--vscode-menu-selectionForeground, #ffffff);
        }
        .context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground, #454545);
            margin: 3px 0;
        }

        #controls-area {
            flex: 1 0 auto;
            padding: 8px;
            background: var(--vscode-sideBar-background);
        }
        .section {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 10px;
            margin-bottom: 8px;
        }
        .section-title {
            font-weight: 600;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 3px;
            transition: opacity 0.15s;
        }
        .btn:hover { opacity: 0.85; }
        .btn.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .toggle-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
        }
        .toggle {
            width: 32px; height: 18px;
            background: var(--vscode-checkbox-border);
            border-radius: 9px;
            position: relative;
            cursor: pointer;
            transition: background 0.2s;
            flex-shrink: 0;
        }
        .toggle.active { background: var(--vscode-button-background); }
        .toggle::after {
            content: '';
            position: absolute;
            width: 14px; height: 14px;
            background: white;
            border-radius: 50%;
            top: 2px; left: 2px;
            transition: transform 0.2s;
        }
        .toggle.active::after { transform: translateX(14px); }
        .model-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
            gap: 8px;
            max-height: 340px;
            overflow-y: auto;
            padding-right: 2px;
        }
        .model-card {
            background: var(--vscode-input-background);
            border: 2px solid transparent;
            border-radius: 5px;
            padding: 6px;
            cursor: pointer;
            text-align: center;
            transition: all 0.15s;
            position: relative;
        }
        .model-card:hover { border-color: var(--vscode-focusBorder); }
        .model-card.selected {
            border-color: var(--vscode-button-background);
            box-shadow: 0 0 6px rgba(0,122,204,0.35);
        }
        .model-card.selected::after {
            content: '✓';
            position: absolute; top: 3px; right: 3px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            width: 14px; height: 14px; border-radius: 50%;
            font-size: 9px; display: flex; align-items: center; justify-content: center;
        }
        .model-card img {
            width: 100%; height: 55px;
            object-fit: cover; border-radius: 3px;
            margin-bottom: 3px; display: block;
        }
        .model-card .thumb-ph {
            width: 100%; height: 55px;
            background: var(--vscode-dropdown-background);
            border-radius: 3px; margin-bottom: 3px;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px;
        }
        .model-card .name {
            font-size: 10px; font-weight: 500;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .model-empty {
            grid-column: 1/-1; padding: 14px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px; text-align: center;
        }
        .timer-display {
            font-size: 28px; font-weight: 300;
            text-align: center; font-variant-numeric: tabular-nums;
            margin: 4px 0 8px;
        }
        .timer-display.break { color: #4ec994; }
        .timer-controls { display: flex; gap: 5px; justify-content: center; margin-bottom: 8px; }
        .input-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
        .input-row label { font-size: 10px; color: var(--vscode-descriptionForeground); min-width: 46px; }
        .input-row input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #555);
            padding: 3px 6px; border-radius: 3px; font-size: 11px;
        }
        #scale-row { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
        #scale-row label { font-size: 10px; color: var(--vscode-descriptionForeground); min-width: 38px; }
        #scale-row input[type=range] { flex: 1; }
        #online-search {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #555);
            padding: 4px 8px; border-radius: 4px; font-size: 11px;
            margin-bottom: 6px;
        }
        .spinner {
            display: inline-block;
            width: 12px; height: 12px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>

<div id="canvas-area">
    <div id="model-status">
        <span class="status-emoji">🎭</span>
        <span id="status-text">Select a model below</span>
    </div>
</div>

<div id="contextMenu" class="context-menu">
    <div class="context-menu-item" id="cmZoomIn">🔍 Увеличить (+10%)</div>
    <div class="context-menu-item" id="cmZoomOut">🔍 Уменьшить (-10%)</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="cmResetScale">↺ Сбросить масштаб</div>
</div>

<div id="controls-area">

    <div class="section">
        <div id="scale-row">
            <label>Scale</label>
            <input type="range" id="scaleSlider" min="0.2" max="3" step="0.05" value="1">
            <span id="scaleVal" style="font-size:10px;min-width:28px;text-align:right">1.0×</span>
        </div>
    </div>

    <!-- Local Models -->
    <div class="section">
        <div class="section-title">
            🗂️ Local Models
            <span id="localCount" style="opacity:0.6;font-weight:normal">(0)</span>
        </div>
        <div id="localList" class="model-grid">
            <div class="model-empty">Loading…</div>
        </div>
    </div>

    <!-- Online Models from GitHub -->
    <div class="section">
        <div class="section-title">
            🌐 Online Models
            <span id="onlineCount" style="opacity:0.6;font-weight:normal">(0)</span>
            <span id="onlineSpinner" class="spinner" style="margin-left:4px"></span>
        </div>
        <input id="online-search" type="text" placeholder="Search models…" autocomplete="off">
        <div id="onlineList" class="model-grid">
            <div class="model-empty">Loading catalog…</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">🔊 Voice</div>
        <div class="toggle-row">
            <span>Voice Reactions</span>
            <div id="voiceToggle" class="toggle active"></div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">⏱️ Pomodoro</div>
        <div id="timerDisplay" class="timer-display">25:00</div>
        <div class="timer-controls">
            <button id="btnStart" class="btn">▶ Start</button>
            <button id="btnStop" class="btn secondary">⏹ Stop</button>
            <button id="btnReset" class="btn secondary">↺ Reset</button>
        </div>
        <div class="input-row">
            <label>Work</label>
            <input id="workInput" type="number" min="1" max="120" value="25">
        </div>
        <div class="input-row">
            <label>Break</label>
            <input id="breakInput" type="number" min="1" max="60" value="5">
        </div>
    </div>

    <div class="section">
        <div class="section-title">⚙️ Actions</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button id="btnOpenCleanTab" class="btn secondary" style="flex:1; min-width:110px;">🎭 Pure Model View</button>
            <button id="btnOpenTab" class="btn secondary" style="flex:1; min-width:110px;">↗️ Full Panel Tab</button>
            <button id="btnSettings" class="btn secondary" style="flex:1; min-width:110px;">Open Settings</button>
        </div>
    </div>

</div>

<script nonce="${nonce}">
(function() {
    'use strict';
    const vscode = acquireVsCodeApi();

    // ── Persistent Webview State ─────────────────────────
    var savedState = vscode.getState() || {};
    var selectedModelName = savedState.selectedModelName || null;

    function saveState(modelData) {
        if (!modelData) return;
        selectedModelName = modelData.name;
        vscode.setState({
            selectedModelName: modelData.name,
            selectedModelData: modelData
        });
        vscode.postMessage({ type: 'selectModel', name: modelData.name });
    }

    // ── GitHub catalog config ────────────────────────────
    const GH_OWNER = 'test157t';
    const GH_REPO  = 'Live2dModels-ST-';
    const GH_REF   = 'main';
    const GH_RAW   = 'https://raw.githubusercontent.com/' + GH_OWNER + '/' + GH_REPO + '/' + GH_REF + '/';
    const GH_CDN   = 'https://cdn.jsdelivr.net/gh/' + GH_OWNER + '/' + GH_REPO + '@' + GH_REF + '/';
    const INDEX_URL_RAW = GH_RAW + 'index.json';
    const INDEX_URL_CDN = GH_CDN + 'index.json';

    // ── State ────────────────────────────────────────────
    let localModels = [];
    let onlineModels = [];
    let voiceEnabled = true;
    let pomodoro = { running: false, timeLeft: 1500, mode: 'work', workMinutes: 25, breakMinutes: 5 };
    let pixiApp = null;
    let live2dModel = null;
    let currentScale = 1.0;

    // ── DOM refs ─────────────────────────────────────────
    const canvasArea      = document.getElementById('canvas-area');
    const statusEl        = document.getElementById('model-status');
    const statusText      = document.getElementById('status-text');
    const localList       = document.getElementById('localList');
    const localCount      = document.getElementById('localCount');
    const onlineList      = document.getElementById('onlineList');
    const onlineCount     = document.getElementById('onlineCount');
    const onlineSpinner   = document.getElementById('onlineSpinner');
    const onlineSearch    = document.getElementById('online-search');
    const voiceToggle     = document.getElementById('voiceToggle');
    const timerDisplay    = document.getElementById('timerDisplay');
    const btnStart        = document.getElementById('btnStart');
    const btnStop         = document.getElementById('btnStop');
    const btnReset        = document.getElementById('btnReset');
    const workInput       = document.getElementById('workInput');
    const breakInput      = document.getElementById('breakInput');
    const btnOpenCleanTab = document.getElementById('btnOpenCleanTab');
    const btnOpenTab      = document.getElementById('btnOpenTab');
    const btnSettings     = document.getElementById('btnSettings');
    const scaleSlider     = document.getElementById('scaleSlider');
    const scaleVal        = document.getElementById('scaleVal');
    const contextMenu     = document.getElementById('contextMenu');
    const cmZoomIn        = document.getElementById('cmZoomIn');
    const cmZoomOut       = document.getElementById('cmZoomOut');
    const cmResetScale    = document.getElementById('cmResetScale');

    // ── Context Menu & Zooming ───────────────────────────
    function hideContextMenu() {
        if (contextMenu) contextMenu.style.display = 'none';
    }

    canvasArea.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (!contextMenu) return;
        const x = Math.min(e.clientX, window.innerWidth - 150);
        const y = Math.min(e.clientY, window.innerHeight - 100);
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.style.display = 'block';
    });

    document.addEventListener('click', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') hideContextMenu();
    });

    function updateScaleUI() {
        if (scaleSlider) scaleSlider.value = currentScale;
        if (scaleVal) scaleVal.textContent = currentScale.toFixed(1) + '×';
        fitModel();
    }

    cmZoomIn.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = Math.min(5.0, currentScale + 0.1);
        updateScaleUI();
    });

    cmZoomOut.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = Math.max(0.1, currentScale - 0.1);
        updateScaleUI();
    });

    cmResetScale.addEventListener('click', function(e) {
        e.stopPropagation();
        hideContextMenu();
        currentScale = 1.0;
        updateScaleUI();
    });

    canvasArea.addEventListener('wheel', function(e) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.05 : -0.05;
        currentScale = Math.max(0.1, Math.min(5.0, currentScale + delta));
        updateScaleUI();
    }, { passive: false });

    // ── Pixi init ────────────────────────────────────────
    function initPixi() {
        if (pixiApp && pixiApp.stage) return true;
        try {
            const w = canvasArea.offsetWidth || 360;
            const h = canvasArea.offsetHeight || 300;
            pixiApp = new PIXI.Application({
                transparent: true,
                width: w,
                height: h,
                antialias: true,
                autoDensity: true,
                resolution: window.devicePixelRatio || 1,
            });
            if (pixiApp && pixiApp.view && pixiApp.stage) {
                canvasArea.appendChild(pixiApp.view);
                vscode.postMessage({ type: 'log', text: 'PixiJS initialised successfully' });
                return true;
            }
        } catch(e) {
            console.error('PixiJS init failed:', e);
            statusText.textContent = 'Graphics engine error: ' + (e && e.message ? e.message : String(e));
            vscode.postMessage({ type: 'log', text: 'PixiJS init error: ' + (e && e.stack ? e.stack : String(e)) });
        }
        return false;
    }

    // Pre-fetch each binary asset and wrap in a blob: URL so XHR never sees the raw vscode-resource URL.
    async function buildBlobModelObj(obj) {
        if (!obj) return obj;
        obj = JSON.parse(JSON.stringify(obj));
        async function toBlob(url, mime) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;
            try {
                var r = await fetch(url);
                if (!r.ok) { vscode.postMessage({ type: 'log', text: 'Main blob fetch HTTP ' + r.status + ' for ' + url }); return url; }
                return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: mime || 'application/octet-stream' }));
            } catch(e) {
                vscode.postMessage({ type: 'log', text: 'Main blob fetch error for ' + url + ': ' + e });
                return url;
            }
        }
        if (obj.FileReferences) {
            if (obj.FileReferences.Moc)
                obj.FileReferences.Moc = await toBlob(obj.FileReferences.Moc, 'application/octet-stream');
            if (obj.FileReferences.Physics)
                obj.FileReferences.Physics = await toBlob(obj.FileReferences.Physics, 'application/json');
            if (Array.isArray(obj.FileReferences.Textures))
                obj.FileReferences.Textures = await Promise.all(obj.FileReferences.Textures.map(function(t) { return toBlob(t, 'image/png'); }));
        }
        if (obj.model) obj.model = await toBlob(obj.model, 'application/octet-stream');
        if (obj.physics) obj.physics = await toBlob(obj.physics, 'application/json');
        if (Array.isArray(obj.textures)) obj.textures = await Promise.all(obj.textures.map(function(t) { return toBlob(t, 'image/png'); }));
        return obj;
    }

    // ── Load model ──────────────────────────────────────
    async function loadModel(modelData, updateSavedState) {
        if (!initPixi() || !pixiApp || !pixiApp.stage) {
            statusText.textContent = 'Graphics engine failed to initialize.';
            return;
        }
        if (!modelData) return;

        if (updateSavedState !== false) {
            saveState(modelData);
        }

        statusText.textContent = 'Loading ' + modelData.name + '…';
        statusEl.style.display = 'flex';

        if (live2dModel) {
            try {
                if (pixiApp && pixiApp.stage) {
                    pixiApp.stage.removeChild(live2dModel);
                }
                live2dModel.destroy();
            } catch(e) {}
            live2dModel = null;
        }

        let modelObj = modelData.modelObj;

        // Remote model: fetch + patch paths if not cached yet
        if (modelData.source === 'remote' && modelData.remoteUrl && !modelObj) {
            try {
                modelObj = await fetchAndPatchRemoteModel(modelData.remoteUrl);
                modelData.modelObj = modelObj;
            } catch(e) {
                statusText.textContent = 'Failed to fetch remote model: ' + (e.message || e);
                vscode.postMessage({ type: 'log', text: 'Remote model error: ' + e });
                return;
            }
        }

        if (!modelObj) {
            statusText.textContent = 'No model settings available.';
            return;
        }

        try {
            const Live2DModel = PIXI.live2d.Live2DModel;
            var safeModelObj = await buildBlobModelObj(modelObj);
            live2dModel = await Live2DModel.from(safeModelObj, { autoInteract: true });
            fitModel();
            if (pixiApp && pixiApp.stage) {
                pixiApp.stage.addChild(live2dModel);
            }
            statusEl.style.display = 'none';
            vscode.postMessage({ type: 'log', text: 'Model loaded: ' + modelData.name });
        } catch(e) {
            console.error('Model load error:', e);
            statusText.textContent = 'Failed to load model: ' + (e && e.message ? e.message : String(e));
            vscode.postMessage({ type: 'log', text: 'Model load error: ' + (e && e.stack ? e.stack : String(e)) });
        }
    }

    async function fetchAndPatchRemoteModel(modelJsonUrl) {
        const r = await fetch(modelJsonUrl);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + modelJsonUrl);
        const json = await r.json();
        const base = modelJsonUrl.replace(/\\/[^\\/]*$/, '/');

        function absUrl(rel) {
            if (!rel || rel.startsWith('http')) return rel;
            return new URL(rel, base).href;
        }

        if (json.FileReferences) {
            if (json.FileReferences.Moc) json.FileReferences.Moc = absUrl(json.FileReferences.Moc);
            if (Array.isArray(json.FileReferences.Textures))
                json.FileReferences.Textures = json.FileReferences.Textures.map(absUrl);
            if (json.FileReferences.Physics) json.FileReferences.Physics = absUrl(json.FileReferences.Physics);
            if (json.FileReferences.Expressions)
                json.FileReferences.Expressions = json.FileReferences.Expressions.map(function(e) {
                    if (e.File) e.File = absUrl(e.File); return e;
                });
            if (json.FileReferences.Motions) {
                for (const g of Object.keys(json.FileReferences.Motions)) {
                    (json.FileReferences.Motions[g] || []).forEach(function(m) {
                        if (m.File) m.File = absUrl(m.File);
                        if (m.Sound) m.Sound = absUrl(m.Sound);
                    });
                }
            }
        }
        if (json.model)    json.model    = absUrl(json.model);
        if (json.physics)  json.physics  = absUrl(json.physics);
        if (Array.isArray(json.textures)) json.textures = json.textures.map(absUrl);
        if (json.motions) {
            for (const g of Object.keys(json.motions)) {
                const arr = json.motions[g] || [];
                for (let i = 0; i < arr.length; i++) {
                    const m = arr[i];
                    if (typeof m === 'string') arr[i] = absUrl(m);
                    else { if (m.file) m.file = absUrl(m.file); if (m.File) m.File = absUrl(m.File); }
                }
            }
        }

        json.url = modelJsonUrl;
        return json;
    }

    function fitModel() {
        if (!live2dModel || !pixiApp || !pixiApp.renderer || !pixiApp.stage) return;
        const cw = canvasArea.offsetWidth || 300;
        const ch = canvasArea.offsetHeight || 300;
        try {
            pixiApp.renderer.resize(cw, ch);
            const scaleToFit = Math.min(
                cw / Math.max(1, (live2dModel.width || 300) / (live2dModel.scale.x || 1)),
                ch / Math.max(1, (live2dModel.height || 400) / (live2dModel.scale.y || 1))
            ) * 0.9 * currentScale;
            if (isFinite(scaleToFit) && scaleToFit > 0) {
                live2dModel.scale.set(scaleToFit);
            }
            live2dModel.x = (cw - (live2dModel.width || 0)) / 2;
            live2dModel.y = (ch - (live2dModel.height || 0)) / 2;
        } catch(e) {
            console.warn('fitModel error:', e);
        }
    }

    new ResizeObserver(() => fitModel()).observe(canvasArea);

    scaleSlider.addEventListener('input', function() {
        currentScale = parseFloat(scaleSlider.value);
        scaleVal.textContent = currentScale.toFixed(1) + '×';
        fitModel();
    });

    // ── Restore state helper ──────────────────────────────
    function tryRestoreSelectedModel() {
        if (!selectedModelName) return false;
        var foundLocal = localModels.find(function(m) { return m.name === selectedModelName; });
        if (foundLocal) {
            loadModel(foundLocal, false);
            renderLocalGrid();
            return true;
        }
        var foundOnline = onlineModels.find(function(m) { return m.name === selectedModelName; });
        if (foundOnline) {
            loadModel(foundOnline, false);
            renderOnlineGrid(onlineSearch.value || '');
            return true;
        }
        if (savedState.selectedModelData && savedState.selectedModelData.name === selectedModelName) {
            loadModel(savedState.selectedModelData, false);
            return true;
        }
        return false;
    }

    // ── Render model card ────────────────────────────────
    function makeCard(m, idx, listEl, allArr) {
        const card = document.createElement('div');
        card.className = 'model-card' + (selectedModelName === m.name ? ' selected' : '');
        card.dataset.index = String(idx);

        const thumb = document.createElement('div');
        if (m.thumbnail) {
            const img = document.createElement('img');
            img.src = m.thumbnail;
            img.alt = '';
            img.onerror = function() { thumb.className = 'thumb-ph'; thumb.textContent = '🎭'; img.remove(); };
            thumb.appendChild(img);
        } else {
            thumb.className = 'thumb-ph';
            thumb.textContent = '🎭';
        }
        card.appendChild(thumb);

        const namEl = document.createElement('div');
        namEl.className = 'name';
        namEl.textContent = m.name;
        card.appendChild(namEl);

        card.addEventListener('click', function() {
            selectedModelName = m.name;
            loadModel(m);
            renderLocalGrid();
            renderOnlineGrid(onlineSearch.value);
        });
        return card;
    }

    function renderLocalGrid() {
        if (localCount) localCount.textContent = '(' + localModels.length + ')';
        localList.innerHTML = '';
        if (!localModels.length) {
            localList.innerHTML = '<div class="model-empty">No local models found.<br>Add to anime-overlay/public/models/</div>';
            return;
        }
        localModels.forEach(function(m, i) {
            localList.appendChild(makeCard(m, i, localList, localModels));
        });
    }

    function renderOnlineGrid(filter) {
        const q = (filter || '').toLowerCase().trim();
        const filtered = q ? onlineModels.filter(function(m) { return m.name.toLowerCase().includes(q); }) : onlineModels;
        if (onlineCount) onlineCount.textContent = '(' + filtered.length + ')';
        onlineList.innerHTML = '';
        if (!filtered.length) {
            onlineList.innerHTML = '<div class="model-empty">' + (q ? 'No results.' : 'No online models found.') + '</div>';
            return;
        }
        filtered.forEach(function(m, i) {
            onlineList.appendChild(makeCard(m, i, onlineList, filtered));
        });
    }

    // ── GitHub catalog ───────────────────────────────────
    async function loadOnlineCatalog() {
        onlineSpinner.style.display = 'inline-block';
        try {
            let indexData = null;
            for (const url of [INDEX_URL_RAW, INDEX_URL_CDN]) {
                try {
                    const r = await fetch(url);
                    if (r.ok) { indexData = await r.json(); break; }
                } catch {}
            }

            if (!indexData) {
                try {
                    const apiUrl = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/git/trees/' + GH_REF + '?recursive=1';
                    const r = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
                    if (r.ok) {
                        const tree = await r.json();
                        indexData = (tree.tree || []).map(function(item) { return item.path; });
                    }
                } catch {}
            }

            if (!indexData) {
                onlineList.innerHTML = '<div class="model-empty">Could not load online catalog (offline?).</div>';
                return;
            }

            const modelPaths = [];
            function collectPaths(node, prefix) {
                if (typeof node === 'string') {
                    if (/\\.(model3|model)\\.json$/i.test(node)) modelPaths.push(node);
                    return;
                }
                if (Array.isArray(node)) { node.forEach(function(n) { collectPaths(n, prefix); }); return; }
                if (node && typeof node === 'object') {
                    const p = prefix ? prefix + '/' + (node.name || '') : (node.name || '');
                    const files = node.files || [];
                    files.forEach(function(f) {
                        if (/\\.(model3|model)\\.json$/i.test(f)) modelPaths.push(p + '/' + f);
                    });
                    (node.children || []).forEach(function(c) { collectPaths(c, p); });
                }
            }
            collectPaths(indexData, '');

            onlineModels = modelPaths.map(function(p) {
                const name = p.split('/').slice(-2, -1)[0] || p;
                const dir = p.replace(/\\/[^\\/]*$/, '');
                const rawUrl = GH_RAW + p;
                const thumbName = dir.split('/').pop() + '_thumbnail.png';
                const thumbnail = GH_CDN + dir + '/' + thumbName;
                return {
                    name: name,
                    modelObj: undefined,
                    thumbnail: thumbnail,
                    source: 'remote',
                    remoteUrl: rawUrl,
                };
            });

            renderOnlineGrid(onlineSearch.value || '');
            tryRestoreSelectedModel();
        } catch(e) {
            onlineList.innerHTML = '<div class="model-empty">Error loading catalog: ' + e + '</div>';
            vscode.postMessage({ type: 'log', text: 'Online catalog error: ' + e });
        } finally {
            onlineSpinner.style.display = 'none';
        }
    }

    onlineSearch.addEventListener('input', function() {
        renderOnlineGrid(onlineSearch.value);
    });

    // ── Pomodoro ─────────────────────────────────────────
    function updateTimer() {
        var m = Math.floor(pomodoro.timeLeft / 60).toString().padStart(2, '0');
        var s = (pomodoro.timeLeft % 60).toString().padStart(2, '0');
        timerDisplay.textContent = m + ':' + s;
        timerDisplay.className = 'timer-display' + (pomodoro.mode === 'break' ? ' break' : '');
        workInput.value = pomodoro.workMinutes;
        breakInput.value = pomodoro.breakMinutes;
    }

    // ── Events ───────────────────────────────────────────
    voiceToggle.addEventListener('click', function() { vscode.postMessage({ type: 'toggleVoice' }); });
    btnStart.addEventListener('click', function() { vscode.postMessage({ type: 'startPomodoro' }); });
    btnStop.addEventListener('click', function() { vscode.postMessage({ type: 'stopPomodoro' }); });
    btnReset.addEventListener('click', function() { vscode.postMessage({ type: 'resetPomodoro' }); });
    workInput.addEventListener('change', function() { vscode.postMessage({ type: 'setWorkMinutes', minutes: parseInt(workInput.value) || 25 }); });
    breakInput.addEventListener('change', function() { vscode.postMessage({ type: 'setBreakMinutes', minutes: parseInt(breakInput.value) || 5 }); });
    btnOpenCleanTab.addEventListener('click', function() { vscode.postMessage({ type: 'openCleanTab' }); });
    btnOpenTab.addEventListener('click', function() { vscode.postMessage({ type: 'openTab' }); });
    btnSettings.addEventListener('click', function() { vscode.postMessage({ type: 'openSettings' }); });

    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (msg.type === 'models') {
            localModels = msg.data || [];
            renderLocalGrid();
            if (!tryRestoreSelectedModel() && localModels.length > 0) {
                selectedModelName = localModels[0].name;
                loadModel(localModels[0]);
                renderLocalGrid();
            }
        }
        if (msg.type === 'state') {
            if (msg.data.voiceEnabled !== undefined) {
                voiceEnabled = msg.data.voiceEnabled;
                voiceEnabled ? voiceToggle.classList.add('active') : voiceToggle.classList.remove('active');
            }
            if (msg.data.selectedModel && msg.data.selectedModel !== selectedModelName) {
                selectedModelName = msg.data.selectedModel;
                tryRestoreSelectedModel();
            }
        }
        if (msg.type === 'pomodoro') { pomodoro = msg.data; updateTimer(); }
    });

    // ── Init ─────────────────────────────────────────────
    initPixi();
    updateTimer();
    loadOnlineCatalog();
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

class AnimeCleanViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "animeCleanView";
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _timer: PomodoroTimer;
    private _mainProvider: AnimeViewProvider;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext, timer: PomodoroTimer, mainProvider: AnimeViewProvider) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._timer = timer;
        this._mainProvider = mainProvider;
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._mainProvider.setupCleanView(webviewView);
    }
}

// ─── Helpers ───────────────────────────────────────────

function generateNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let n = "";
    for (let i = 0; i < 32; i++) n += chars[Math.floor(Math.random() * chars.length)];
    return n;
}

// ─── Activation ────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log("🎬 ANIME ASSISTANT: activate started");
    try {
        const config = vscode.workspace.getConfiguration("animeAssistant");
        const timer = new PomodoroTimer(config.get("pomodoroWorkMinutes", 25), config.get("pomodoroBreakMinutes", 5));
        const provider = new AnimeViewProvider(context.extensionUri, context, timer);
        const cleanProvider = new AnimeCleanViewProvider(context.extensionUri, context, timer, provider);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(AnimeViewProvider.viewType, provider,
                { webviewOptions: { retainContextWhenHidden: true } })
        );

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(AnimeCleanViewProvider.viewType, cleanProvider,
                { webviewOptions: { retainContextWhenHidden: true } })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand("anime.show", () => vscode.commands.executeCommand("animeView.focus"))
        );

        context.subscriptions.push(
            vscode.commands.registerCommand("anime.openTab", () => {
                const extraDir = vscode.workspace.getConfiguration("animeAssistant").get<string>("extraModelsDir", "").trim();
                const localRoots = [
                    context.extensionUri,
                    vscode.Uri.file(path.join(context.extensionUri.fsPath, "anime-overlay", "public")),
                ];
                if (extraDir && fs.existsSync(extraDir)) localRoots.push(vscode.Uri.file(extraDir));

                const panel = vscode.window.createWebviewPanel(
                    "animeAssistantTab",
                    "Anime Assistant",
                    vscode.ViewColumn.Active,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: localRoots,
                    }
                );
                provider.setupPanel(panel);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand("anime.openCleanTab", () => {
                const extraDir = vscode.workspace.getConfiguration("animeAssistant").get<string>("extraModelsDir", "").trim();
                const localRoots = [
                    context.extensionUri,
                    vscode.Uri.file(path.join(context.extensionUri.fsPath, "anime-overlay", "public")),
                ];
                if (extraDir && fs.existsSync(extraDir)) localRoots.push(vscode.Uri.file(extraDir));

                const panel = vscode.window.createWebviewPanel(
                    "animeAssistantCleanTab",
                    "Anime Model View",
                    vscode.ViewColumn.Active,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: localRoots,
                    }
                );
                provider.setupCleanPanel(panel);
            })
        );

        const modifiedSinceSave = new Set<string>();
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
            try { modifiedSinceSave.add(e.document.uri.fsPath); } catch {}
        }));
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
            modifiedSinceSave.delete(doc.uri.fsPath);
        }));

        console.log("🎬 ANIME ASSISTANT: provider registered");
    } catch (err) {
        console.error("🎬 ANIME ASSISTANT: activate FAILED:", err);
    }
}

export function deactivate() {}