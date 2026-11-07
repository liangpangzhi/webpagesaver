// 浏览器发现与启动：复用本机 Edge / Chrome，不下载 Chromium
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

const CANDIDATES = [
	process.env.WP_SAVER_BROWSER,
	'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
].filter(Boolean);

function findBrowser() {
	for (const p of CANDIDATES) {
		try {
			if (fs.existsSync(p)) return p;
		} catch (e) { /* ignore */ }
	}
	throw new Error('未找到 Edge / Chrome，可通过环境变量 WP_SAVER_BROWSER 指定浏览器路径');
}

async function launch(options = {}) {
	const executablePath = options.executablePath || findBrowser();
	const args = [
		'--no-sandbox',
		'--disable-dev-shm-usage',
		'--disable-blink-features=AutomationControlled',
		'--force-device-scale-factor=1',
		'--disable-features=Translate,BackForwardCache',
		'--hide-scrollbars=false',
		'--mute-audio',
		'--disable-extensions'
	];
	if (options.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
	const userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wp-saver-profile-'));
	const browser = await puppeteer.launch({
		executablePath,
		headless: options.headless === false ? false : 'new',
		args,
		userDataDir,
		defaultViewport: {
			width: options.width || 1440,
			height: options.height || 900,
			deviceScaleFactor: 1
		},
		protocolTimeout: Math.max(180000, (options.timeout || 60) * 1000 * 2)
	});
	return { browser, executablePath, userDataDir };
}

module.exports = { launch, findBrowser };
