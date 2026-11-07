'use strict';

// 本地操作页面（GUI）。启动一个只监听 127.0.0.1 的小型 HTTP 服务，
// 用 Edge/Chrome 的 --app 模式打开一个无地址栏的独立窗口作为操作界面。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { renderPage } = require('./ui-html');

let deps = null;
let archive = '';
let configFile = '';
let server = null;
let uiChild = null;
let pendingExit = null;

// 只有带桌面环境的系统（Windows / macOS）才能"用本地程序打开文件"或"在文件管理器里定位"。
// NAS / 服务器类 Linux 环境没有 explorer、也没有图形桌面，相关接口必须显式报错，不能假装成功。
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const CAN_OPEN_LOCAL = IS_WIN || IS_MAC;
// 仅桌面托管模式（Windows 本地运行、未设 WPS_NO_WINDOW）允许网页关闭即退出；
// NAS/服务端托管模式必须常驻，避免浏览器刷新或关标签页把服务杀掉。
const ALLOW_SELF_EXIT = IS_WIN && process.env.WPS_NO_WINDOW !== '1';

const state = {
	busy: false,
	version: '',
	archive: '',
	startedAt: Date.now(),
	task: null
};

function exeDir() {
	try {
		const exe = process.execPath || '';
		const base = path.basename(exe).toLowerCase();
		if (exe && base !== 'node.exe' && base !== 'node') return path.dirname(exe);
	} catch (e) { /* ignore */ }
	return process.cwd();
}

function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch (e) {
		return false;
	}
}

function resolveArchiveDir() {
	const custom = process.env.WPS_ARCHIVE_DIR;
	if (custom && ensureDir(custom)) return custom;
	const near = path.join(exeDir(), '网页存档');
	if (ensureDir(near)) return near;
	const fallback = path.join(os.homedir(), 'WebPageSaver-存档');
	ensureDir(fallback);
	return fallback;
}

function readConfig() {
	const def = { width: 1440, height: 900, wait: 1500, keepScripts: false, keepModals: false, autoOpen: true };
	try {
		const raw = fs.readFileSync(configFile, 'utf8');
		const cfg = JSON.parse(raw);
		return Object.assign(def, cfg && typeof cfg === 'object' ? cfg : {});
	} catch (e) {
		return def;
	}
}

function writeConfig(patch) {
	try {
		const cfg = Object.assign(readConfig(), patch || {});
		fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
	} catch (e) { /* ignore */ }
}

function pad(n) {
	return n < 10 ? '0' + n : String(n);
}

function stamp() {
	const d = new Date();
	return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function cleanName(name) {
	return String(name || '')
		.replace(/[\\/:*?"<>|\r\n\t]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
}

function uniqueName(name) {
	const ext = path.extname(name) || '.html';
	const base = name.slice(0, name.length - ext.length);
	let candidate = name;
	let i = 2;
	while (fs.existsSync(path.join(archive, candidate))) {
		candidate = base + '-' + i + ext;
		i += 1;
		if (i > 500) break;
	}
	return candidate;
}

function clampInt(v, min, max, def) {
	const n = parseInt(v, 10);
	if (Number.isNaN(n)) return def;
	return Math.min(max, Math.max(min, n));
}

function pushLog(line) {
	const task = state.task;
	if (!task) return;
	task.logs.push(String(line));
	if (task.logs.length > 400) task.logs.shift();
	task.progress = Math.min(6, (task.logs.join('\n').match(/\[\d\/6\]/g) || []).length);
}

function listFiles() {
	const out = [];
	let names = [];
	try {
		names = fs.readdirSync(archive);
	} catch (e) {
		return out;
	}
	for (const name of names) {
		if (!/\.html?$/i.test(name)) continue;
		const full = path.join(archive, name);
		try {
			const st = fs.statSync(full);
			if (!st.isFile()) continue;
			out.push({ name: name, size: st.size, mtime: st.mtimeMs, path: full });
		} catch (e) { /* ignore */ }
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out.slice(0, 100);
}

function publicTask() {
	const t = state.task;
	if (!t) return null;
	return {
		id: t.id,
		status: t.status,
		url: t.url,
		startedAt: t.startedAt,
		endedAt: t.endedAt,
		elapsed: (t.endedAt || Date.now()) - t.startedAt,
		logs: t.logs,
		progress: t.progress,
		error: t.error,
		result: t.result
	};
}

function json(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Length': Buffer.byteLength(body)
	});
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve) => {
		let buf = '';
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > 512 * 1024) { req.destroy(); resolve(null); return; }
			buf += chunk.toString('utf8');
		});
		req.on('end', () => {
			if (!buf) return resolve({});
			try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
		});
		req.on('error', () => resolve(null));
	});
}

function insideArchive(p) {
	try {
		const full = path.resolve(p);
		const root = path.resolve(archive) + path.sep;
		return full.toLowerCase().startsWith(root.toLowerCase());
	} catch (e) {
		return false;
	}
}

function openPath(target) {
	try {
		if (process.platform === 'win32') {
			execFile('cmd.exe', ['/c', 'start', '""', target], { windowsHide: false }, () => {});
		} else if (process.platform === 'darwin') {
			execFile('open', [target], () => {});
		} else {
			execFile('xdg-open', [target], () => {});
		}
	} catch (e) { /* ignore */ }
}

function revealPath(target) {
	try {
		if (process.platform !== 'win32') return;
		execFile('explorer.exe', ['/select,' + target], () => {});
	} catch (e) { /* ignore */ }
}

async function runSave(input) {
	const { parseArgs, savePage, toNavUrl } = deps;
	const raw = String(input.url || '').trim();
	const url = toNavUrl(raw);
	const id = String(Date.now());
	const cfg = readConfig();

	state.task = {
		id: id,
		status: 'running',
		url: url,
		startedAt: Date.now(),
		endedAt: null,
		logs: ['[0/6] 准备保存: ' + url],
		progress: 0,
		error: null,
		result: null
	};
	state.busy = true;

	const cfgWidth = clampInt(input.width, 320, 4096, cfg.width);
	const cfgHeight = clampInt(input.height, 320, 4096, cfg.height);
	const cfgWait = clampInt(input.wait, 0, 30000, cfg.wait);

	let name = cleanName(input.name);
	if (name) {
		if (!/\.html?$/i.test(name)) name += '.html';
	} else {
		name = '网页存档-' + stamp() + '.html';
	}
	name = uniqueName(name);

	writeConfig({
		width: cfgWidth,
		height: cfgHeight,
		wait: cfgWait,
		keepScripts: !!input.keepScripts,
		keepModals: !!input.keepModals,
		autoOpen: input.autoOpen !== false
	});

	try {
		const argv = [url, '-o', name, '--quiet', '--width', String(cfgWidth), '--height', String(cfgHeight), '--wait', String(cfgWait)];
		if (input.keepScripts) argv.push('--keep-scripts');
		if (input.keepModals) argv.push('--keep-modals');

		const opts = parseArgs(argv);
		opts.quiet = true;
		opts.json = false;
		opts.open = false;
		opts.onLog = pushLog;

		const report = await savePage(opts);
		const output = path.resolve(archive, report.output || name);
		let size = report.file && report.file.size ? report.file.size : 0;
		if (!size) {
			try { size = fs.statSync(output).size; } catch (e) { /* ignore */ }
		}

		state.task.status = 'done';
		state.task.endedAt = Date.now();
		state.task.progress = 6;
		state.task.result = {
			title: report.title || '(无标题)',
			output: output,
			name: path.basename(output),
			size: size,
			ms: (report.timing && report.timing.total) || (Date.now() - state.task.startedAt),
			nodes: report.page ? report.page.nodes : 0,
			images: report.page ? report.page.images : 0,
			iframes: report.page ? report.page.iframesInlined : 0,
			assetsInlined: report.assets ? report.assets.inlined : 0,
			assetsRequested: report.assets ? report.assets.requested : 0,
			adsHidden: (report.cleanup && report.cleanup.removed
				? ((report.cleanup.removed.ads_hidden || 0) + (report.cleanup.removed.popups_hidden || 0) + (report.cleanup.removed.overlays_hidden || 0))
				: 0),
			adsRemoved: (report.cleanup && report.cleanup.removed
				? ((report.cleanup.removed.ads || 0) + (report.cleanup.removed.popups || 0) + (report.cleanup.removed.overlays || 0))
				: 0),
			warnings: (report.warnings || []).slice(0, 5)
		};
		pushLog('完成: ' + path.basename(output));
		if (input.autoOpen !== false) {
			if (CAN_OPEN_LOCAL) {
				openPath(output);
			} else {
				pushLog('提示: 当前系统没有桌面环境，已跳过自动打开，请在文件列表中「预览」或「下载」');
			}
		}
	} catch (error) {
		const msg = (error && error.message) || String(error);
		state.task.status = 'error';
		state.task.endedAt = Date.now();
		state.task.error = msg;
		pushLog('失败: ' + msg);
	} finally {
		state.busy = false;
	}
}

function sendArchiveFile(req, res, target, asAttachment) {
	const bad = () => json(res, 404, { ok: false, error: '文件不存在' });
	if (!target || !insideArchive(target) || !fs.existsSync(target)) return bad();
	let st;
	try {
		st = fs.statSync(target);
	} catch (e) {
		return bad();
	}
	if (!st.isFile()) return json(res, 400, { ok: false, error: '目标不是文件' });
	const name = path.basename(target);
	const headers = {
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Length': st.size,
		'Cache-Control': 'no-store',
		'Content-Disposition': (asAttachment ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name)
	};
	res.writeHead(200, headers);
	const stream = fs.createReadStream(target);
	stream.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
	stream.pipe(res);
}

function route(req, res, url) {
	const p = url.pathname;

	if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
		const html = renderPage(state.version).replace('__VERSION__', state.version);
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(html);
		return;
	}

	if (req.method === 'GET' && p === '/api/state') {
		if (pendingExit) {
			clearTimeout(pendingExit);
			pendingExit = null;
		}
		json(res, 200, {
			busy: state.busy,
			task: publicTask(),
			archive: archive,
			version: state.version,
			platform: process.platform,
			canOpenLocal: CAN_OPEN_LOCAL,
			config: readConfig(),
			files: listFiles()
		});
		return;
	}

	if (req.method === 'GET' && p === '/api/view') {
		sendArchiveFile(req, res, url.searchParams.get('path') || '', false);
		return;
	}

	if (req.method === 'GET' && p === '/api/download') {
		sendArchiveFile(req, res, url.searchParams.get('path') || '', true);
		return;
	}

	if (req.method === 'POST' && p === '/api/save') {
		readBody(req).then((body) => {
			if (!body || !String(body.url || '').trim()) {
				json(res, 400, { ok: false, error: '请输入网址' });
				return;
			}
			if (state.busy) {
				json(res, 409, { ok: false, error: '已有任务正在保存，请稍候' });
				return;
			}
			json(res, 200, { ok: true });
			runSave(body).catch(() => {});
		});
		return;
	}

	if (req.method === 'POST' && p === '/api/open') {
		readBody(req).then((body) => {
			if (!CAN_OPEN_LOCAL) {
				json(res, 400, { ok: false, error: '当前系统没有桌面环境，无法直接打开文件，请改用「预览」或「下载」' });
				return;
			}
			const target = body && body.path ? String(body.path) : '';
			if (!target || !insideArchive(target) || !fs.existsSync(target)) {
				json(res, 400, { ok: false, error: '文件不存在' });
				return;
			}
			openPath(target);
			json(res, 200, { ok: true });
		});
		return;
	}

	if (req.method === 'POST' && p === '/api/reveal') {
		readBody(req).then((body) => {
			if (!CAN_OPEN_LOCAL) {
				json(res, 400, { ok: false, error: '当前系统没有文件管理器，无法在文件夹中显示，请改用「复制路径」' });
				return;
			}
			const target = body && body.path ? String(body.path) : archive;
			if (!insideArchive(target)) {
				json(res, 400, { ok: false, error: '路径不合法' });
				return;
			}
			if (fs.existsSync(target) && fs.statSync(target).isFile()) revealPath(target);
			else execFile('explorer.exe', [archive], () => {});
			json(res, 200, { ok: true });
		});
		return;
	}

	if (req.method === 'POST' && p === '/api/quit' && !ALLOW_SELF_EXIT) {
		json(res, 403, { ok: false, error: 'service-mode: 本服务由 NAS 托管的常驻进程提供，不支持从网页退出，请在应用中心停止应用' });
		return;
	}

	if (req.method === 'POST' && p === '/api/quit') {
		json(res, 200, { ok: true });
		setTimeout(shutdown, 200);
		return;
	}

	if (req.method === 'POST' && p === '/api/bye' && !ALLOW_SELF_EXIT) {
		// 服务模式：关闭或刷新浏览器标签页不影响后端服务
		json(res, 200, { ok: true, ignored: true });
		return;
	}

	if (req.method === 'POST' && p === '/api/bye') {
		// 界面窗口关闭时上报；给刷新留 4 秒宽限，期间有新请求则取消退出
		json(res, 200, { ok: true });
		pendingExit = setTimeout(() => { if (!state.busy) shutdown(); }, 4000);
		return;
	}

	json(res, 404, { ok: false, error: 'not found' });
}

function shutdown() {
	try { if (uiChild && !uiChild.killed) uiChild.kill(); } catch (e) { /* ignore */ }
	try { if (server) server.close(); } catch (e) { /* ignore */ }
	setTimeout(() => process.exit(0), 120);
}

const BROWSERS = [
	path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
	path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
	path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
	path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
	path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
	path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe')
];

function findBrowser() {
	for (const p of BROWSERS) {
		if (!p) continue;
		try {
			if (fs.existsSync(p)) return p;
		} catch (e) { /* ignore */ }
	}
	return null;
}

function openWindow(target) {
	if (process.env.WPS_NO_WINDOW || process.platform !== 'win32') {
		console.log('[ui] ' + target);
		return;
	}
	const browser = findBrowser();
	if (!browser) {
		openPath(target);
		return;
	}
	const profile = path.join(os.tmpdir(), 'WebPageSaver-ui-profile');
	try {
		uiChild = spawn(browser, [
			'--app=' + target,
			'--window-size=1240,900',
			'--user-data-dir=' + profile,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-features=Translate,msEdgeSplitScreen'
		], { detached: false, stdio: 'ignore' });
		uiChild.on('error', () => { openPath(target); });
		// 注意：Edge 的启动器进程可能立即退出（窗口由浏览器主进程接管），
		// 因此不能以子进程退出作为窗口关闭信号，窗口关闭由页面 beforeunload 上报。
	} catch (e) {
		openPath(target);
	}
}

async function startGui(options) {
	deps = options;
	state.version = options.version || '1.0.0';

	// 打包为无控制台窗口的 exe 后，标准输出已无接收方，静默掉避免写入异常
	if (process.platform === 'win32' && !process.env.WPS_GUI_LOG) {
		const noop = () => true;
		try {
			process.stdout.write = noop;
			process.stderr.write = noop;
		} catch (e) { /* ignore */ }
	}

	archive = resolveArchiveDir();
	state.archive = archive;
	configFile = path.join(exeDir(), 'webpagesaver.config.json');
	if (!ensureDir(exeDir())) configFile = path.join(archive, '.webpagesaver.config.json');

	// 让 savePage 的相对输出路径落在存档目录
	try { process.chdir(archive); } catch (e) { /* ignore */ }

	server = http.createServer((req, res) => {
		let url;
		try {
			url = new URL(req.url, 'http://127.0.0.1');
		} catch (e) {
			res.writeHead(400); res.end('bad request'); return;
		}
		try {
			route(req, res, url);
		} catch (e) {
			json(res, 500, { ok: false, error: e.message });
		}
	});

	// 监听地址/端口可通过环境变量覆盖（NAS 上需要对外提供 Web 界面）
	const host = process.env.WPS_HOST || '127.0.0.1';
	const wantPort = parseInt(process.env.WPS_PORT || '0', 10);
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(Number.isFinite(wantPort) ? wantPort : 0, host, resolve);
	});
	const port = server.address().port;
	const target = 'http://' + (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host) + ':' + port + '/';
	console.log('WebPageSaver 操作页面已启动: ' + target);
	console.log('存档目录: ' + archive);
	openWindow(target);

	// 常驻，直到窗口关闭或点击退出
	await new Promise(() => {});
}

module.exports = { startGui };
