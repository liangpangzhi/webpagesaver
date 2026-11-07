#!/usr/bin/env node
// 抑制单文件 exe 运行时 Node 的 SEA 模块加载提示噪音
try {
	let seaOk = false;
	try { const sea = require('node:sea'); seaOk = typeof sea.isSea === 'function' && sea.isSea(); } catch (e) { seaOk = false; }
	if (seaOk || process.pkg) process.emitWarning = function () {};
} catch (e) { /* ignore */ }

// WebPageSaver —— 把网页完整保存为单个 HTML 文件（离线可看，保留布局与页面比例，自动剔除弹窗广告）
const fs = require('fs');
const path = require('path');
const { launch, findBrowser } = require('./browser');
const scripts = require('./page-scripts');
const { createHttpClient, createPool, inlineCss } = require('./assets');

const VERSION = '1.0.0';

function parseArgs(argv) {
	const opts = {
		url: '', output: '',
		width: 1440, height: 900,
		wait: 1500, maxWait: 45000,
		scroll: true, maxSteps: 60,
		keepModals: false, keepScripts: false, dropIframes: false,
		fixedLayout: true, maxFrames: 40, maxFrameSize: 8 * 1024 * 1024,
		iframeSnapshot: true,
		timeout: 60, concurrency: 8, quote: true,
		headless: true, open: false, json: false, quiet: false,
		userDataDir: '', ignoreCertificateErrors: false, verbose: false
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case '-h': case '--help': opts.help = true; break;
			case '-v': case '--version': opts.version = true; break;
			case '-o': case '--output': opts.output = next(); break;
			case '--width': opts.width = parseInt(next(), 10); break;
			case '--height': opts.height = parseInt(next(), 10); break;
			case '--wait': opts.wait = parseInt(next(), 10); break;
			case '--no-scroll': opts.scroll = false; break;
			case '--scroll-steps': opts.maxSteps = parseInt(next(), 10); break;
			case '--keep-modals': opts.keepModals = true; break;
			case '--keep-scripts': opts.keepScripts = true; break;
			case '--drop-iframes': opts.dropIframes = true; break;
			case '--no-fixed-layout': opts.fixedLayout = false; break;
			case '--max-frames': opts.maxFrames = parseInt(next(), 10); break;
			case '--no-iframe-snapshot': opts.iframeSnapshot = false; break;
			case '--timeout': opts.timeout = parseInt(next(), 10); break;
			case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
			case '--no-quote': opts.quote = false; break;
			case '--headful': opts.headless = false; break;
			case '--open': opts.open = true; break;
			case '--json': opts.json = true; break;
			case '--quiet': opts.quiet = true; break;
			case '--verbose': opts.verbose = true; break;
			case '--user-data-dir': opts.userDataDir = next(); break;
			case '--ignore-certificate-errors': opts.ignoreCertificateErrors = true; break;
			default:
				if (a.startsWith('-')) throw new Error('未知参数: ' + a);
				rest.push(a);
		}
	}
	opts.url = rest[0] || '';
	return opts;
}

function printHelp() {
	console.log([
		'WebPageSaver ' + VERSION + ' —— 网页完整离线存档工具',
		'',
		'用法:',
		'  webpagesaver <URL> [选项]',
		'',
		'选项:',
		'  -o, --output <文件>        输出 HTML 路径（默认按页面标题命名，保存到当前目录）',
		'  --width <像素>             渲染宽度，默认 1440（决定保存时的布局与页面比例）',
		'  --height <像素>            渲染高度，默认 900',
		'  --wait <毫秒>              页面加载后额外等待时间，默认 1500',
		'  --no-scroll                不执行"滚动到底触发懒加载"',
		'  --scroll-steps <次数>      懒加载滚动最大步数，默认 60',
		'  --keep-modals              保留弹窗/浮层（只清除广告元素）',
		'  --keep-scripts             保留页面脚本（默认移除，避免离线打开时弹窗复现）',
		'  --drop-iframes             完全移除 iframe（默认把每个 iframe 的内容内联成 srcdoc）',
		'  --no-iframe-snapshot       不把无法内联的 iframe 截图保形',
		'  --no-fixed-layout          不锁定渲染宽度（默认注入 min-width 保持原布局比例）',
		'  --max-frames <数量>        最多内联多少个 iframe，默认 40',
		'  --timeout <秒>             页面加载超时，默认 60',
		'  --concurrency <数量>       资源下载并发数，默认 8',
		'  --headful                  显示浏览器窗口（调试用）',
		'  --open                     保存完成后用默认浏览器打开',
		'  --json                     以 JSON 输出结果报告',
		'  --user-data-dir <目录>     使用指定浏览器配置目录（可复用登录态）',
		'  --ignore-certificate-errors 忽略证书错误',
		'',
		'示例:',
		'  webpagesaver https://example.com -o example.html',
		'  webpagesaver https://news.site/article --width 1280 --wait 3000 --open'
	].join('\n'));
}

function sanitizeFilename(name) {
	return String(name || 'page')
		.replace(/[\\/:*?"<>|\r\n\t]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120) || 'page';
}

function log(opts, ...args) {
	if (typeof opts.onLog === 'function') {
		try { opts.onLog(args.join(' ')); } catch (e) { /* ignore */ }
	}
	if (!opts.quiet && !opts.json) console.log(...args);
}

async function getCookieHeader(page, url) {
	try {
		const client = await page.createCDPSession();
		const { cookies } = await client.send('Network.getCookies', { urls: [url] });
		await client.detach();
		return cookies.map((c) => c.name + '=' + c.value).join('; ');
	} catch (e) {
		return '';
	}
}

function frameDepth(frame) {
	let depth = 0;
	let cur = frame;
	while (cur && cur.parentFrame()) { depth++; cur = cur.parentFrame(); }
	return depth;
}

// 对页面指定区域截图（用于无法内联的 iframe 保形）
async function captureRegion(page, box) {
	const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
	const client = await page.createCDPSession();
	try {
		const { data } = await client.send('Page.captureScreenshot', {
			format: 'jpeg',
			quality: 78,
			clip: {
				x: Math.max(0, box.x + scroll.x),
				y: Math.max(0, box.y + scroll.y),
				width: Math.max(1, box.width),
				height: Math.max(1, box.height),
				scale: 1
			},
			captureBeyondViewport: true,
			fromSurface: true
		});
		return 'data:image/jpeg;base64,' + data;
	} catch (e) {
		return null;
	} finally {
		try { await client.detach(); } catch (e) { /* ignore */ }
	}
}

async function savePage(opts) {
	const started = Date.now();
	const report = {
		version: VERSION,
		url: opts.url,
		title: '',
		output: '',
		viewport: { width: opts.width, height: opts.height },
		page: { nodes: 0, images: 0, iframes: 0, iframesInlined: 0, iframesSnapshotted: 0, iframesDropped: 0, framesVisited: 0 },
		cleanup: {},
		assets: { requested: 0, inlined: 0, failed: [], failureReasons: {}, bytes: 0, cssFiles: 0, cssImports: 0 },
		file: { size: 0 },
		timing: {},
		warnings: []
	};

	const { browser, executablePath } = await launch({
		width: opts.width,
		height: opts.height,
		timeout: opts.timeout,
		headless: opts.headless,
		userDataDir: opts.userDataDir || undefined,
		ignoreCertificateErrors: opts.ignoreCertificateErrors
	});
	report.browser = executablePath;

	let page;
	try {
		page = await browser.newPage();
		await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
		page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* ignore */ } });

		log(opts, '[1/6] 打开页面: ' + opts.url);
		let response;
		try {
			response = await page.goto(opts.url, { waitUntil: 'networkidle2', timeout: opts.timeout * 1000 });
		} catch (e) {
			report.warnings.push('页面加载未完全结束: ' + e.message);
			log(opts, '      警告: ' + e.message);
		}
		if (response && response.status() >= 400) report.warnings.push('HTTP 状态码 ' + response.status());

		report.title = await page.title();
		const userAgent = await browser.userAgent();
		const cookie = opts.quote === false ? '' : await getCookieHeader(page, opts.url);

		// 触发懒加载（保持页面完整性的关键）
		if (opts.scroll) {
			log(opts, '[2/6] 触发懒加载与字体渲染');
			try {
				const scrollInfo = await page.evaluate(scripts.scrollThrough, {
					stepDelay: Math.min(400, Math.max(120, Math.floor(opts.wait / 4))),
					maxSteps: opts.maxSteps
				});
				report.page.docHeight = scrollInfo.height;
			} catch (e) {
				report.warnings.push('懒加载滚动失败: ' + e.message);
			}
		} else {
			await new Promise((r) => setTimeout(r, opts.wait));
		}

		// 移除非内容元素
		log(opts, '[3/6] 清除弹窗与广告');
	const debugKill = (r) => {
		if (!opts.verbose || !r || !r.removed || !r.removed.samples) return;
		for (const line of r.removed.samples) report.warnings.push('命中样本 ' + line);
	};
		report.cleanup = await page.evaluate(scripts.cleanPage, { keepModals: opts.keepModals });
		debugKill(report.cleanup);
		report.page.nodes = await page.evaluate(() => document.querySelectorAll('*').length);
		report.page.images = await page.evaluate(() => document.images.length);
		report.page.iframes = await page.evaluate(() => document.querySelectorAll('iframe, frame').length);

		const http = createHttpClient({
			cookie, userAgent, timeout: 30000, maxResourceSize: 25 * 1024 * 1024
		});
		const pool = createPool(Math.max(1, opts.concurrency));
		const assets = {};
		const missing = [];
		const failureReasons = {};
		const seenUrls = new Set();

		// 单个 frame：采集 → 下载 → 回填
		const processFrame = async (frame, isMain) => {
			if (!isMain) {
				try { await frame.evaluate(scripts.cleanPage, { keepModals: opts.keepModals }); } catch (e) { /* ignore */ }
			}
			const collected = await frame.evaluate(scripts.collectAssets, {});
			const styles = {};
			const cssStats = { resources: 0, bytes: 0, failed: [], cssImports: 0 };

			await Promise.all(collected.cssLinks.map((link) => (async () => {
				if (styles[link.href]) return;
				const fetched = await http.fetchText(link.href, isMain ? opts.url : undefined);
				if (!fetched) { cssStats.failed.push(link.href); return; }
				const css = await inlineCss(http, link.href, fetched.text, assets, cssStats, 0);
				styles[link.href] = css;
				report.assets.cssFiles++;
			})()));

			await Promise.all(collected.urls.map((u) => (async () => {
				if (assets[u]) return;
				const res = await pool(() => http.fetchAsDataUri(u, isMain ? opts.url : undefined));
				if (res && res.ok) {
					assets[u] = res.dataUri;
					report.assets.bytes += res.size;
				} else if (res) {
					missing.push(u);
					const key = res.error === 'too-large' ? '文件过大' : (res.error || ('HTTP ' + res.status));
					failureReasons[key] = (failureReasons[key] || 0) + 1;
					if (opts.verbose) report.warnings.push('资源失败 ' + key + ': ' + u.slice(0, 100));
				}
			})()));

			report.assets.bytes += cssStats.bytes;
			missing.push(...cssStats.failed);
			report.assets.cssImports += cssStats.cssImports;

			return frame.evaluate(scripts.applyAssets, {
				assets,
				styles,
				options: {
					keepScripts: opts.keepScripts,
					dropIframes: isMain ? opts.dropIframes : false,
					fixedLayoutWidth: isMain && opts.fixedLayout ? opts.width : 0
				}
			});
		};

		// ---- iframe 处理 ----
		log(opts, '[4/6] 内联 iframe 内容');
		const mainFrame = page.mainFrame();
		const infos = [];
		for (const frame of page.frames()) {
			if (frame === mainFrame) continue;
			try {
				const el = await frame.frameElement();
				if (!el) continue;
				const meta = await el.evaluate((n) => {
					const r = n.getBoundingClientRect();
					const cs = getComputedStyle(n);
					// 处于已判定为广告区（data-sf-ad）内的 iframe 直接占位屏蔽；
					// 其余 iframe 只看自身盒模型，避免父级 visibility 继承造成误判
					const insideAd = !!n.closest('[data-sf-ad]');
					const ownHidden = n.style && n.style.visibility === 'hidden';
					return {
						w: r.width, h: r.height,
						visible: !insideAd && !ownHidden && cs.display !== 'none' && r.width > 4 && r.height > 4,
						src: n.getAttribute('src') || ''
					};
				});
				infos.push({ frame, el, meta, depth: frameDepth(frame) });
			} catch (e) { /* frame 已脱离 */ }
		}

		// 埋点/不可见 iframe 直接删除，避免保存后联网请求
		const tiny = infos.filter((i) => !i.meta.visible || i.meta.w * i.meta.h < 100 * 60);
		for (const t of tiny) {
			try {
				await t.el.evaluate((n) => {
					// 保留盒模型占位（不改变布局与页面比例），但清空内容并断网
					n.removeAttribute('src');
					n.setAttribute('srcdoc', '');
					n.setAttribute('data-sf-ad', 'placeholder');
					try { n.style.visibility = 'hidden'; } catch (e) { /* ignore */ }
				});
				report.page.iframesDropped++;
			} catch (e) { /* ignore */ }
		}
		const candidates = infos.filter((i) => !tiny.includes(i))
			.sort((a, b) => (b.depth - a.depth) || (b.meta.w * b.meta.h - a.meta.w * a.meta.h));

		for (const info of candidates) {
			if (report.page.iframesInlined >= opts.maxFrames) break;
			try {
				const applied = await processFrame(info.frame, false);
				if (!applied || !applied.html) continue;
				if (applied.html.length > opts.maxFrameSize) {
					report.warnings.push('iframe 内容过大已跳过: ' + info.frame.url().slice(0, 100));
					continue;
				}
				await info.el.evaluate((node, html) => {
					node.setAttribute('srcdoc', html);
					node.removeAttribute('src');
					node.setAttribute('data-sf-inlined', '1');
				}, applied.html);
				report.page.iframesInlined++;
				report.page.framesVisited++;
			} catch (e) {
				if (opts.verbose) report.warnings.push('iframe 处理失败: ' + String(e.message).slice(0, 140));
			}
		}
		for (const info of candidates) {
			try { await info.el.dispose(); } catch (e) { /* ignore */ }
		}
		for (const t of tiny) {
			try { await t.el.dispose(); } catch (e) { /* ignore */ }
		}

		// 未内联 iframe：优先截图保形，其次移除 src 防止联网
		if (!opts.dropIframes) {
			const handles = await page.$$('iframe');
			for (const h of handles) {
				try {
					const state = await h.evaluate((n) => ({
						inlined: n.hasAttribute('srcdoc') || n.hasAttribute('data-sf-inlined'),
						w: n.getBoundingClientRect().width,
						h: n.getBoundingClientRect().height
					}));
					if (state.inlined) continue;
					if (state.w < 40 || state.h < 40) {
						await h.evaluate((n) => {
							n.removeAttribute('src');
							n.setAttribute('srcdoc', '');
							n.setAttribute('data-sf-ad', 'placeholder');
							try { n.style.visibility = 'hidden'; } catch (e) { /* ignore */ }
						});
						report.page.iframesDropped++;
						continue;
					}
					let done = false;
					if (opts.iframeSnapshot) {
						const box = await h.boundingBox();
						if (box && box.width > 20 && box.height > 20) {
							const shot = await captureRegion(page, box);
							if (shot) {
								await h.evaluate((n, src) => {
									const img = document.createElement('img');
									img.setAttribute('src', src);
									img.setAttribute('alt', 'iframe snapshot');
									const cls = n.getAttribute('class');
									if (cls) img.setAttribute('class', cls);
									const st = n.getAttribute('style');
									if (st) img.setAttribute('style', st);
									const w = n.getAttribute('width');
									const hgt = n.getAttribute('height');
									if (w) img.setAttribute('width', w);
									if (hgt) img.setAttribute('height', hgt);
									if (!st) {
										img.style.width = Math.round(n.getBoundingClientRect().width) + 'px';
										img.style.height = Math.round(n.getBoundingClientRect().height) + 'px';
									}
									img.style.border = '0';
									if (n.parentNode) n.parentNode.replaceChild(img, n);
								}, shot);
								report.page.iframesSnapshotted++;
								done = true;
							}
						}
					}
					if (!done) await h.evaluate((n) => { n.removeAttribute('src'); });
				} catch (e) { /* ignore */ }
			}
			for (const h of handles) { try { await h.dispose(); } catch (e) { /* ignore */ } }
		}

		// ---- 主文档 ----
		log(opts, '[5/6] 内联主文档资源');
		const mainApplied = await processFrame(mainFrame, true);

		report.assets.inlined = Object.keys(assets).length;
		report.assets.failed = Array.from(new Set(missing)).slice(0, 20);
		report.assets.requested = report.assets.inlined + new Set(missing).size;
		report.assets.failureReasons = failureReasons;
		report.timing.render = Date.now() - started;

		let outputPath = opts.output;
		if (!outputPath) {
			outputPath = path.join(process.cwd(), sanitizeFilename(report.title || 'page') + '.html');
		} else if (!path.isAbsolute(outputPath)) {
			outputPath = path.resolve(process.cwd(), outputPath);
		}
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, mainApplied.html, 'utf8');
		report.output = outputPath;
		report.file.size = Buffer.byteLength(mainApplied.html);
		report.cleanupStats = mainApplied.stats;
		report.timing.total = Date.now() - started;

		await page.close();
		return report;
	} finally {
		try { await browser.close(); } catch (e) { /* ignore */ }
	}
}

function formatBytes(n) {
	if (!n || Number.isNaN(n)) return '0 B';
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function printReport(report, opts) {
	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	if (opts.quiet) {
		console.log(report.output);
		return;
	}
	const removed = (report.cleanup && report.cleanup.removed) || {};
	console.log('');
	console.log('保存完成');
	console.log('  标题      : ' + (report.title || '(无标题)'));
	console.log('  输出文件  : ' + report.output);
	console.log('  文件大小  : ' + formatBytes(report.file.size));
	console.log('  渲染尺寸  : ' + report.viewport.width + ' x ' + report.viewport.height);
	console.log('  DOM 节点  : ' + report.page.nodes + '，图片 ' + report.page.images + '，iframe ' + report.page.iframes);
	console.log('  iframe    : 内联 ' + report.page.iframesInlined + '，截图保形 ' + report.page.iframesSnapshotted + '，占位屏蔽 ' + report.page.iframesDropped);
	const hidden = (removed.ads_hidden || 0) + (removed.popups_hidden || 0) + (removed.overlays_hidden || 0);
	const cut = (removed.ads || 0) + (removed.popups || 0) + (removed.overlays || 0);
	console.log('  广告弹窗  : 隐藏 ' + hidden + ' 个（保留占位，布局不变），移除浮层 ' + cut + ' 个');
	console.log('  内联资源  : ' + report.assets.inlined + ' / ' + report.assets.requested + '，共 ' + formatBytes(report.assets.bytes) + '（CSS ' + report.assets.cssFiles + ' 个）');
	if (report.assets.failed.length) {
		const reasons = Object.keys(report.assets.failureReasons || {}).map((k) => k + ' x' + report.assets.failureReasons[k]).join(', ');
		console.log('  下载失败  : ' + report.assets.failed.length + ' 个（' + reasons + '）');
	}
	if (report.warnings.length) {
		report.warnings.slice(0, 5).forEach((w) => console.log('  提示      : ' + w));
	}
	console.log('  耗时      : ' + (report.timing.total / 1000).toFixed(1) + ' 秒');
}

function cliArgs() {
	// 兼容三种启动方式：node index.js <args> / app.exe <args> / 打包运行时多出的自身路径
	if (process.env.WPS_DEBUG_ARGV) console.error('ARGV=' + JSON.stringify(process.argv));
	const exe = String(process.execPath || '').toLowerCase();
	const out = [];
	for (const a of process.argv.slice(1)) {
		const low = String(a).toLowerCase();
		if (low === exe) continue;
		if (low === String(process.argv[0]).toLowerCase()) continue;
		const isPath = /\.(exe|js|cjs|mjs)$/.test(low) || low.indexOf('\\\\') >= 0 || low.indexOf('/') >= 0;
		const looksLikeUrl = /^https?:|^www\.|^[\w-]+\.[a-z]{2,}(\/|\$)/i.test(String(a));
		if (isPath && !looksLikeUrl && (low.endsWith('.js') || low.endsWith('.cjs') || low.endsWith('.mjs') || low.endsWith('.exe'))) continue;
		out.push(a);
	}
	return out;
}

function toNavUrl(input) {
	const raw = String(input || '').trim().replace(/^["']+|["']+$/g, '');
	if (!raw) return raw;
	if (/^(https?|file):\/\//i.test(raw)) return raw;
	// 本地文件（含拖拽进来的路径 / 单反斜杠）
	const looksPath = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || (raw.includes('\\') && !/\s/.test(raw));
	if (looksPath) {
		try {
			const abs = path.resolve(raw);
			if (fs.existsSync(abs)) return 'file:///' + abs.replace(/\\/g, '/');
		} catch (e) { /* ignore */ }
	}
	return 'https://' + raw.replace(/^\/+/, '');
}

// SEA 运行时会提示 require() 只能加载内置模块（我们的依赖已全部打进 bundle，不影响功能）
process.on('warning', (w) => {
	if (process.env.WPS_DEBUG_WARNING) console.warn(w);
});

async function interactive(baseOpts) {
	const readline = require('readline');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
	const clean = (v) => String(v || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
	let url = '';
	let output = '';
	try {
		console.log('');
		console.log('==================================================');
		console.log('  WebPageSaver ' + VERSION + ' —— 网页完整离线存档');
		console.log('  保存后布局与页面比例保持不变，自动剔除弹窗广告');
		console.log('==================================================');
		console.log('');
		url = clean(await ask('请输入网址（如 www.example.com）: '));
		if (!url) { console.log('未输入网址，已退出。'); return; }
		output = clean(await ask('输出文件名（回车=按网页标题自动命名）: '));
		const w = clean(await ask('页面宽度像素（回车=1440，与屏幕一致效果最好）: '));
		const width = parseInt(w, 10);
		if (!Number.isNaN(width) && width >= 320 && width <= 4096) baseOpts.width = width;
	} finally {
		rl.close();
	}
	baseOpts.url = toNavUrl(url);
	if (output) baseOpts.output = /\.html?$/i.test(output) ? output : output + '.html';
	baseOpts.open = true;
	console.log('');
	const report = await savePage(baseOpts);
	printReport(report, baseOpts);
	const { exec } = require('child_process');
	try { exec('cmd /c start "" "' + report.output + '"'); } catch (e) { /* ignore */ }
	const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
	await new Promise((resolve) => rl2.question('\n已打开保存结果，按回车退出...', () => resolve()));
	rl2.close();
}

async function main() {
	let opts;
	try {
		opts = parseArgs(cliArgs());
	} catch (e) {
		console.error(e.message);
		printHelp();
		process.exitCode = 2;
		return;
	}
	if (opts.help) { printHelp(); return; }
	if (opts.version) { console.log(VERSION); return; }
	if (!opts.url) {
		const { startGui } = require('./gui');
		await startGui({ version: VERSION, savePage, parseArgs, toNavUrl, printReport });
		return;
	}
	opts.url = toNavUrl(opts.url);

	try {
		const report = await savePage(opts);
		printReport(report, opts);
		if (opts.open) {
			const { exec } = require('child_process');
			exec('cmd /c start "" "' + report.output + '"');
		}
	} catch (error) {
		console.error('保存失败: ' + (error && error.message || error));
		if (opts.verbose && error && error.stack) console.error(error.stack);
		process.exitCode = 1;
	}
}

if (require.main === module) main();

module.exports = { savePage, parseArgs };
