// Node 侧资源下载与 CSS 递归内联
// 亮点：所有资源请求由 Node 直接发起，不受页面 CORS 限制，可携带 Cookie/Referer 保持登录态
const DEFAULT_TIMEOUT = 30000;
const MAX_SINGLE_SIZE = 25 * 1024 * 1024;

const MIME_BY_EXT = {
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
	'.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.css': 'text/css',
	'.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
	'.json': 'application/json', '.js': 'text/javascript'
};

function mimeOf(url, headerMime) {
	if (headerMime) {
		const m = headerMime.split(';')[0].trim().toLowerCase();
		if (m && m !== 'application/octet-stream' && m !== 'text/plain') return m;
		if (m === 'text/plain' && /\.(css|js|svg|txt)$/i.test(url)) return m;
	}
	const clean = url.split('?')[0].split('#')[0];
	const dot = clean.lastIndexOf('.');
	const ext = dot >= 0 ? clean.slice(dot).toLowerCase() : '';
	return MIME_BY_EXT[ext] || (headerMime ? headerMime.split(';')[0].trim().toLowerCase() : 'application/octet-stream');
}

function createHttpClient(ctx) {
	const cookie = ctx.cookie || '';
	const userAgent = ctx.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

	// Cookie 值可能含非 ASCII / 控制字符，直接塞进请求头会让 Node fetch 抛 "invalid header value"，
	// 进而导致整批资源下载失败，因此必须先做字符过滤。
	function sanitizeCookie(str) {
		if (!str) return '';
		return String(str)
			.split(';')
			.map((s) => s.trim())
			.filter((s) => s && /^[\x20-\x7E]+$/.test(s))
			.join('; ');
	}
	const safeCookie = sanitizeCookie(cookie);

	async function doFetch(url, referer, withCookie) {
		const headers = {
			'User-Agent': userAgent,
			'Accept': '*/*',
			'Accept-Language': ctx.language || 'zh-CN,zh;q=0.9,en;q=0.8'
		};
		if (withCookie && safeCookie) headers['Cookie'] = safeCookie;
		if (referer) headers['Referer'] = referer;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ctx.timeout || DEFAULT_TIMEOUT);
		try {
			const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
			if (!res.ok) {
				return { ok: false, status: res.status, url };
			}
			const buf = Buffer.from(await res.arrayBuffer());
			const mime = mimeOf(url, res.headers.get('content-type'));
			return { ok: true, buffer: buf, mime, finalUrl: res.url || url };
		} catch (error) {
			return { ok: false, error: String(error && error.message || error), url };
		} finally {
			clearTimeout(timer);
		}
	}

	async function rawFetch(url, referer) {
		let res = await doFetch(url, referer, true);
		// 降级重试：带 Cookie 失败时去掉 Cookie；带 Referer 失败时去掉 Referer
		if (!res.ok) res = await doFetch(url, referer, false);
		if (!res.ok && referer) res = await doFetch(url, undefined, false);
		return res;
	}

	async function fetchAsDataUri(url, referer) {
		const res = await rawFetch(url, referer);
		if (!res.ok) return { ok: false, url, status: res.status, error: res.error };
		if (res.buffer.length > (ctx.maxResourceSize || MAX_SINGLE_SIZE)) {
			return { ok: false, url, error: 'too-large', size: res.buffer.length };
		}
		return {
			ok: true,
			dataUri: 'data:' + res.mime + ';base64,' + res.buffer.toString('base64'),
			size: res.buffer.length,
			mime: res.mime
		};
	}

	async function fetchText(url, referer) {
		const res = await rawFetch(url, referer);
		if (!res.ok) return null;
		return { text: res.buffer.toString('utf8'), mime: res.mime, size: res.buffer.length };
	}

	return { rawFetch, fetchAsDataUri, fetchText };
}

function createPool(limit) {
	let active = 0;
	const queue = [];
	const next = () => {
		if (active >= limit || !queue.length) return;
		active++;
		const { task, resolve, reject } = queue.shift();
		Promise.resolve()
			.then(task)
			.then((v) => { active--; resolve(v); next(); })
			.catch((e) => { active--; reject(e); next(); });
	};
	return (task) => new Promise((resolve, reject) => {
		queue.push({ task, resolve, reject });
		next();
	});
}

function parseCssUrls(css, cssUrl) {
	const found = [];
	const push = (u) => {
		if (!u) return;
		u = u.trim();
		if (!u || u.startsWith('data:') || u.startsWith('#')) return;
		try {
			const abs = new URL(u, cssUrl).href;
			if (abs.startsWith('data:')) return;
			if (!found.includes(abs)) found.push(abs);
		} catch (e) { /* ignore */ }
	};
	const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
	let m;
	while ((m = urlRe.exec(css))) push(m[2]);
	const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;
	while ((m = importRe.exec(css))) push(m[2] || m[4]);
	return found;
}

// 递归内联 CSS：把 url() 与 @import 全部转成 data URI
async function inlineCss(client, cssUrl, cssText, assets, stats, depth) {
	depth = depth || 0;
	if (depth > 3) return cssText;

	// 先处理 @import：整段替换为被导入文件的 CSS
	const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;
	const importJobs = [];
	let im;
	while ((im = importRe.exec(cssText))) {
		importJobs.push({ raw: im[0], url: im[2] || im[4], media: (im[5] || '').trim() });
	}
	for (const job of importJobs) {
		try {
			const abs = new URL(job.url, cssUrl).href;
			if (abs.startsWith('data:')) continue;
			const fetched = await client.fetchText(abs, cssUrl);
			if (!fetched) continue;
			let inner = await inlineCss(client, abs, fetched.text, assets, stats, depth + 1);
			if (job.media && job.media !== 'all') inner = '@media ' + job.media + '{\n' + inner + '\n}';
			cssText = cssText.replace(job.raw, inner);
			stats.cssImports++;
		} catch (e) { /* ignore */ }
	}

	// 再处理 url() 资源
	const urls = parseCssUrls(cssText, cssUrl).filter((u) => !/\.css(\?|$)/i.test(u) || true);
	for (const u of urls) {
		if (assets[u]) continue;
		const fetched = await client.fetchAsDataUri(u, cssUrl);
		if (fetched && fetched.ok) {
			assets[u] = fetched.dataUri;
			stats.resources++;
			stats.bytes += fetched.size;
			stats.inlinedByCss = (stats.inlinedByCss || 0) + 1;
		} else {
			stats.failed.push(u);
		}
	}

	return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
		const trimmed = u.trim();
		if (trimmed.startsWith('data:') || trimmed.startsWith('#')) return m;
		let abs;
		try { abs = new URL(trimmed, cssUrl).href; } catch (e) { return m; }
		const hit = assets[abs];
		return hit ? 'url("' + hit + '")' : m;
	});
}

module.exports = { createHttpClient, createPool, inlineCss, parseCssUrls, mimeOf };
