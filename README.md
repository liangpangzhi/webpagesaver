# WebPageSaver

把整个网页压成一个自包含的 HTML 文件：图片、CSS、字体、iframe 内容全部内联，离线打开后布局与页面比例与原页一致，同时剔除弹窗广告。

程序本体是单文件 EXE（Node 22 SEA 打包），双击即弹出操作页面，不需要命令行，也不需要目标机安装 Node。

参考 [SingleFile](https://github.com/gildas-lormeau/SingleFile) 的抓取思路，用 Node + Puppeteer 驱动本机 Edge 内核实现。

## 特性速览

- **双击即用**：本地 127.0.0.1 服务 + Edge 应用窗口，无控制台黑框
- **完整存档**：图片 / CSS / 字体 / 音视频 / canvas / Shadow DOM / iframe 全部内联为单文件
- **布局保持**：文档流内广告占位隐藏（`visibility:hidden`）而非删除，页面高度与栏宽不变
- **广告清理**：六层过滤，浮层弹窗直接移除，广告 iframe 占位屏蔽
- **离线可用**：移除脚本与 CSP，避免离线打开被重排或跳转

## 快速开始

1. 下载 [Releases](../../releases) 里的 `WebPageSaver.exe`
2. 双击运行，弹出的操作窗口里填网址，点「开始保存」
3. 存档写到 exe 同级的 `网页存档` 目录

---

# WebPageSaver —— 网页完整离线存档工具

参考 SingleFile 的抓取思路，用 Node + Puppeteer 驱动本机 Edge 内核实现的单文件 EXE 程序。
把整个网页（含图片、CSS、字体、iframe 内容）压成一个自包含的 HTML 文件，离线打开后布局与页面比例保持一致，同时剔除弹窗广告。

---

## 一、直接使用（操作页面，不用命令行）

双击 `WebPageSaver.exe`，程序会自动弹出一个操作窗口（Edge 应用窗口，无地址栏、无标签页），
不需要打开命令行、不需要输入任何命令。

操作窗口长这样：

1. **网址**：填要保存的页面地址，`www.163.com` 或 `https://www.163.com` 都行。
2. **输出文件名**：留空则按网页标题自动命名。
3. **选项**：页面宽度、高度、等待时间，以及"保留脚本""保留弹窗""显示浏览器窗口"等开关。
4. 点 **开始保存**：进度条与日志实时滚动，显示正在下载资源、清理广告、内联 iframe 等步骤。
5. 保存完成后结果卡片出现文件大小、耗时、节点数、广告清理统计，可点 **打开结果** 或 **打开存档目录**。
6. 下方"已保存的文件"列出历史存档，点文件名即可重新打开。

窗口顶部还有 **打开存档目录** 与 **退出程序**；直接关掉窗口，后台服务也会随之退出，不留残余进程。

存档位置：exe 同级的 `网页存档` 目录；若该目录不可写，回退到 `%USERPROFILE%\WebPageSaver-存档`。
操作页面本身只监听 `127.0.0.1` 的随机端口，不对外暴露。

### 命令行 / 拖拽（高级用法，可选）

程序仍保留命令行能力，方便批量或脚本调用：

```
WebPageSaver.exe <网址> [-o 输出.html] [选项]
WebPageSaver.exe https://www.sina.com.cn -o sina.html
WebPageSaver.exe www.163.com --width 1920 --wait 3000 --open
```

也支持把网址快捷方式或本地 html 文件直接拖到 exe 图标上。

## 二、参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `-o, --output` | 输出文件路径 | 按网页标题自动命名，存到当前目录 |
| `--width / --height` | 渲染视口尺寸，决定版面宽度与响应式断点 | 1440 × 900 |
| `--wait` | 打开页面后等待时间（毫秒），给脚本和懒加载留时间 | 1500 |
| `--no-scroll` | 不执行自动滚动（不触发懒加载） | 关闭 |
| `--scroll-steps` | 自动滚动最大步数 | 60 |
| `--keep-modals` | 保留弹窗（默认剔除） | 关闭 |
| `--keep-scripts` | 保留页面脚本（默认移除，避免离线后脚本重排页面） | 关闭 |
| `--no-fixed-layout` | 不锁定版心宽度 | 关闭 |
| `--drop-iframes` | 丢弃所有 iframe | 关闭 |
| `--max-frames` | 最多内联多少个 iframe | 40 |
| `--timeout` | 单页加载超时（秒） | 45 |
| `--concurrency` | 资源下载并发数 | 8 |
| `--no-quote` | 内联资源时不携带页面 Cookie（遇到需要登录的图床可用） | 关闭 |
| `--headful` | 显示浏览器窗口（便于观察抓取过程） | 关闭 |
| `--open` | 保存后自动打开结果 | 关闭 |
| `--json` | 以 JSON 输出统计报告 | 关闭 |
| `--verbose` | 输出命中明细，便于排查误删 | 关闭 |

## 三、三条硬要求如何落地

### 1. 完整保存所有元素
- 资源内联：Node 侧 `fetch` 下载图片 / CSS / 字体 / 音视频，转 `data:` URI 写回属性与 CSS。
  Node 侧下载不受页面 CORS 限制，可携带页面的 Cookie 与 Referer，登录态资源也能取到。
- CSS 递归处理：`@import` 与 `url()` 递归内联，深度上限 3 层。
- iframe：先按深度和面积排序，把子框架内容序列化后写入 `srcdoc`，实现嵌套页面也离线可用；
  未内联的框架截图保形，避免留下破框。
- canvas 转 `data:` URI，Shadow DOM 以 Declarative Shadow DOM 形式保留。
- 移除 `meta[http-equiv=refresh]`、`content-security-policy`、`base` 标签，防止离线打开被跳转或拦截。
- 移除 `<script>`，展开 `<noscript>`，避免离线后脚本再改一次页面结构。

### 2. 保持布局与页面比例
关键策略是**占位隐藏**而不是删除：文档流内的广告块设 `visibility:hidden` 但保留盒子尺寸，
页面总高度、栏宽、元素坐标与原页一致；只有浮层（`position:fixed/absolute` 的弹窗）才真正移除。
另外用 `__sf-layout` 样式配合 viewport meta 锁定版心宽度，避免离线打开时因缺少设备信息而重排。

### 3. 不保存弹窗广告
六层过滤，命中后按"文档流占位隐藏 / 浮层直接移除"处理：

| 层 | 策略 |
| --- | --- |
| 1 | 广告联盟选择器（`ins.adsbygoogle`、`div-gpt-ad`、doubleclick / googlesyndication / taboola 等 iframe） |
| 2 | 弹窗选择器 + 浮层形态判定（fixed/absolute、z-index≥10、覆盖面积>5% 视口） |
| 3 | 覆盖层启发式（fixed、z-index≥20、覆盖面积>18%、文字量小） |
| 4 | 滚动锁定还原（解除弹窗脚本给 `html/body` 加的 `overflow:hidden`） |
| 5 | 空遮罩清理（无文字无子元素、半透明黑底的高 z-index 层） |
| 6 | class/id 词法匹配：按 `-` `_` 拆词后比对广告词表，避开 `header`、`download`、`upload`、`shadow` 这类"含 ad 子串但非广告"的误伤；带正文文本或多图片多链接的容器直接放行 |

同时，广告区内的 iframe 一律占位屏蔽，既不断网也不占下载时间。

## 四、实测结果

同一台机器、Edge 内核、1440×900 视口，对比对象是原页面与保存后的文件：

| 站点 | 文件大小 | 耗时 | DOM 节点 | 图片 | iframe | 广告处理 | 高度比 | 宽度比 | 破图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 163.com | 9.72 MB | 24.7s | 2563 | 73 | 内联 0 / 屏蔽 53 | 隐藏 76 / 移除 1 | 1.000 | 1.000 | 1 |
| sina.com.cn | 9.84 MB | 30.7s | 3990 | 102 | 内联 20 / 屏蔽 22 | 隐藏 18 / 移除 0 | 1.003 | 1.000 | 2 |
| sohu.com | 6.25 MB | 19.4s | 2886 | 163 | 内联 26 / 屏蔽 0 | 隐藏 3 / 移除 0 | 1.061 | 1.000 | 0 |
| csdn.net | 29.73 MB | 49.6s | 10184 | 2322 | 内联 — / 6 | 隐藏 4 / 移除 0 | 0.986 | 1.000 | 3 |
| 本地弹窗测试页 | 3.8 KB | 2.9s | 25 | 0 | — | 隐藏 4 / 移除 3 | 1.000 | 1.000 | 0 |

- 宽度比全部 1.000，高度比在 0.986–1.061 之间。sohu 偏高是因为原站在滚动后继续插入内容，属原页动态行为。
- 本地测试页专门验证过：4 个文档流广告位隐藏后坐标与高度分毫不变，3 个浮层弹窗（全屏遮罩、右下悬浮、左下角）全部清除。

## 五、已知限制

- 依赖本机 Edge：程序不自带浏览器内核，路径默认 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，换机器需确认 Edge 安装位置。
- 单文件体积 83 MB，是 Node 单可执行文件（SEA）宿主本身的体积，与网页无关。
- 保存后的文件不保留任何脚本，因此轮播图、下拉菜单等依赖 JS 的交互会失效（静态首帧完整）；需要交互请加 `--keep-scripts`。
- 登录态页面：程序会带页面 Cookie 抓资源，但不会自动登录，需要登录的页面请先用 `--headful --user-data-dir <目录>` 保持会话。
- 视频以 `data:` URI 内联，体积会很大；对视频站点建议加 `--no-quote` 或后续手工剪裁。

## 六、源码与构建

源码目录见同包 `源码` 文件夹：

```
src/index.js          主流程：参数解析、保存编排、报告输出、GUI/命令行分流
src/gui.js            操作页面服务：本地 HTTP、任务队列、存档目录、打开/退出接口
src/ui-html.js        操作页面前端：单文件 HTML/CSS/JS
src/browser.js        Edge 启动与页面上下文
src/page-scripts.js   注入页面的脚本：懒加载滚动、广告清理、资源采集、序列化
src/assets.js         资源下载、CSS 递归内联、并发池、Cookie 处理
build.ps1             一键构建：esbuild 打包 → SEA 生成 blob → postject 注入 → 改为 GUI 子系统
```

构建链中最后一步把 PE 头里的 Subsystem 从 3（Console）改成 2（Windows GUI），
这样双击 exe 只弹操作窗口，不会带一个黑色命令行窗口。

重新构建（需本机有 Node 22+ 与 Edge）：

```
npm install
powershell -ExecutionPolicy Bypass -File build.ps1
```

产物在 `dist\WebPageSaver.exe`。
