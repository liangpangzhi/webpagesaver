# WebPageSaver

把整个网页压成一个自包含的 HTML 文件：图片、CSS、字体、iframe 内容全部内联，离线打开后布局与页面比例与原页一致，同时剔除弹窗广告。

抓取思路参考 [SingleFile](https://github.com/gildas-lormeau/SingleFile)，用 Node + Puppeteer 驱动本机/容器内的 Chromium 内核实现。

## 两种交付形态

| 形态 | 版本 | 安装包 | 运行环境 | 入口 |
| --- | --- | --- | --- | --- |
| Windows 桌面版 | 1.0.0 | `WebPageSaver.exe`（约 83 MB，Node 22 SEA 单文件） | Windows + 本机 Edge / Chrome | 双击后弹出操作窗口 |
| 飞牛 fnOS NAS 版 | 1.0.3 | `webpagesaver_1.0.3_x86.fpk` | fnOS x86，应用自带 Node 与 Chromium 运行时 | 浏览器访问 `http://NAS-IP:8799` |

两个版本共用同一套抓取内核（`page-scripts.js` / `assets.js`），差异只在运行外壳与「打开文件」的实现方式：
桌面版能直接调起资源管理器，NAS 没有桌面，改为浏览器内预览 / 下载 / 复制路径。

安装包都在 [Releases](../../releases) 页，源码在本仓库。

## 目录结构

```
src/                       Windows 桌面版源码
  index.js                 参数解析、保存编排、报告输出、GUI/命令行分流
  gui.js                   本地 HTTP 服务、任务队列、存档目录、打开/退出接口
  ui-html.js               操作页面前端（单文件 HTML/CSS/JS）
  browser.js               Edge/Chrome 定位与启动
  page-scripts.js          注入页面的脚本：懒加载滚动、广告清理、资源采集、序列化
  assets.js                资源下载、CSS 递归内联、并发池、Cookie 处理
src-fnos/                  fnOS NAS 版源码（同名文件，Linux 与无桌面环境适配）
fnos-fpk/                  fpk 打包工程
  manifest                 应用元信息（版本、端口、显示名、changelog）
  cmd/                     生命周期脚本：main / install / upgrade / uninstall / config
  config/                  privilege、resource
  wizard/                  安装向导字段（自定义存档目录）
  app/ui/                  应用中心图标与配置页
  build-fpk.py             构建 fpk：esbuild 打包 → fnpack 打包
build.ps1                  Windows EXE 构建：esbuild → SEA → postject → GUI 子系统
```

## Windows 桌面版用法

1. 双击 `WebPageSaver.exe`，弹出操作窗口（Edge 应用窗口，无地址栏、无控制台黑框）
2. 填网址（`www.163.com` 或 `https://www.163.com` 都行），输出文件名可留空
3. 点「开始保存」，进度条与日志实时滚动
4. 完成后可点「打开结果」「打开存档目录」，下方列表可重新打开历史存档

存档目录：exe 同级的 `网页存档`；不可写时回退到 `%USERPROFILE%\WebPageSaver-存档`。
服务只监听 `127.0.0.1` 随机端口，不对外暴露。命令行用法与参数见 `src/index.js --help`。

常用参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `-o, --output` | 输出文件路径 | 按网页标题自动命名 |
| `--width / --height` | 渲染视口尺寸，决定版面宽度与响应式断点 | 1440 × 900 |
| `--wait` | 打开页面后等待时间（毫秒） | 1500 |
| `--keep-scripts` | 保留页面脚本（默认移除，避免离线重排） | 关闭 |
| `--keep-modals` | 保留弹窗（默认剔除） | 关闭 |
| `--timeout / --concurrency` | 单页超时（秒）/ 资源下载并发 | 45 / 8 |
| `--headful` | 显示浏览器窗口，便于观察抓取过程 | 关闭 |

## 飞牛 fnOS NAS 版用法

1. 在 fnOS 应用中心（或 `fnos-cli app install-fpk`）安装 `webpagesaver_1.0.3_x86.fpk`
2. 安装向导里可自定义存档目录，留空使用默认目录 `/vol1/@appdata/webpagesaver/archive`
3. 安装完成后浏览器打开 `http://NAS-IP:8799`

操作页面与桌面版一致，但结果区按钮按「无桌面环境」重新设计：

| 按钮 | 行为 |
| --- | --- |
| 预览存档 | `GET /api/view?path=` 浏览器内直接渲染离线 HTML |
| 下载文件 | `GET /api/download?path=` 以附件下载，中文文件名已做 RFC 5987 编码 |
| 复制文件路径 | `navigator.clipboard` 写剪贴板 + toast 提示，便于在文件管理器里定位 |
| 复制存档目录 | 同上，复制整个存档目录路径 |

NAS 上不存在本地桌面，因此「在文件夹中显示」这类调用一律不尝试执行：
`POST /api/open`、`POST /api/reveal` 直接返回 HTTP 400 与明确文案，前端统一弹 toast，不再出现「点了没反应」。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 服务状态、版本、存档目录、历史列表、`platform` 与 `canOpenLocal` |
| GET | `/api/view?path=` | 内联预览存档文件（`text/html; charset=utf-8`，仅限存档目录内） |
| GET | `/api/download?path=` | 附件下载存档文件 |
| POST | `/api/save` | 提交保存任务，body 为网址与渲染选项 |
| POST | `/api/open` | 用系统程序打开文件；无桌面环境返回 400 |
| POST | `/api/reveal` | 在文件管理器中定位；无桌面环境返回 400 |
| POST | `/api/quit` / `/api/bye` | 退出后台服务 |

`path` 只接受存档目录内的相对/绝对路径，越界请求返回 400。

## 抓取怎么做到「完整 + 保布局 + 去广告」

**完整保存**：Node 侧 `fetch` 下载图片 / CSS / 字体 / 音视频并转 `data:` URI（不受页面 CORS 限制，可携带页面 Cookie 与 Referer）；`@import` 与 `url()` 递归内联；iframe 按深度与面积排序序列化写入 `srcdoc`；canvas 转 `data:` URI；Shadow DOM 以 Declarative Shadow DOM 保留；移除 `<script>`、`meta[http-equiv=refresh]`、CSP 与 `<base>`。

**保持布局**：文档流内广告块用 `visibility:hidden` 占位隐藏而非删除，页面总高度、栏宽、元素坐标与原页一致；只有浮层弹窗才真正移除；`__sf-layout` 样式配合 viewport meta 锁定版心宽度。

**去广告**：六层过滤——广告联盟选择器、弹窗选择器 + 浮层形态判定、覆盖层启发式、滚动锁定还原、空遮罩清理、class/id 词法匹配（按 `-` `_` 拆词，避开 `header` / `download` / `upload` / `shadow` 这类含 ad 子串的误伤）；广告位内的 iframe 一律占位屏蔽。

## 实测（桌面版 1.0.0，Edge 内核，1440×900）

| 站点 | 文件大小 | 耗时 | DOM 节点 | 图片 | 广告处理 | 高度比 | 宽度比 | 破图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 163.com | 9.72 MB | 24.7s | 2563 | 73 | 隐藏 76 / 移除 1 | 1.000 | 1.000 | 1 |
| sina.com.cn | 9.84 MB | 30.7s | 3990 | 102 | 隐藏 18 / 移除 0 | 1.003 | 1.000 | 0 |
| sohu.com | 6.25 MB | 19.4s | 2886 | 163 | 隐藏 3 / 移除 0 | 1.061 | 1.000 | 0 |
| csdn.net | 29.73 MB | 49.6s | 10184 | 2322 | 隐藏 4 / 移除 0 | 0.986 | 1.000 | 3 |

宽度比全部 1.000；sohu 高度偏高是因为原站滚动后继续插入内容。

NAS 版 1.0.3 实测（fnOS，x86 容器）：`/api/state` 返回 `version=1.0.3`、`platform=linux`、`canOpenLocal=false`；`POST /api/save` 保存 example.com 成功；`/api/view` 返回 200 内联 HTML；`/api/download` 中文文件名编码正确；`/api/open`、`/api/reveal` 均返回 400 与明确文案。

## 构建

Windows EXE（需 Node 22+ 与本机 Edge）：

```powershell
npm install
powershell -ExecutionPolicy Bypass -File build.ps1
# 产物：dist\WebPageSaver.exe
```

NAS fpk（需 Node 22+ 与 fnpack）：

```bash
npm install
python fnos-fpk/build-fpk.py
# 产物：fnos-fpk/webpagesaver_<version>_x86.fpk
```

`build-fpk.py` 做两件事：用 esbuild 把 `src-fnos/index.js` 及其依赖打成单文件 `fnos-fpk/app/src/bundle.cjs`（NAS 上不需要 node_modules），再调用 `fnpack build` 生成 fpk。

## 已知限制

- 依赖 Chromium 内核：桌面版用本机 Edge（默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`），NAS 版使用应用自带运行时；换环境需确认内核可用。
- 单文件 EXE 83 MB 是 Node SEA 宿主本身的体积，与保存的网页无关。
- 保存结果不保留脚本，轮播图、下拉菜单等 JS 交互会失效（静态首帧完整）；需要交互请加 `--keep-scripts`。
- 需要登录的页面不会自动登录，请先用 `--headful` 保持会话。
- 视频以 `data:` URI 内联，体积会很大，视频站点建议后续手工剪裁。

## 许可

MIT，见 [LICENSE](LICENSE)。版本记录见 [CHANGELOG.md](CHANGELOG.md)。
