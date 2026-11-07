# 版本记录

## 1.0.4（飞牛 fnOS NAS 版）

修复服务运行一段时间后自动停止：关闭或刷新网页不再杀掉后端进程。

- 新增 `ALLOW_SELF_EXIT = IS_WIN && WPS_NO_WINDOW !== '1'`：只有 Windows/macOS 本地桌面模式允许「关窗口即退出」，NAS 服务模式一律常驻
- `POST /api/bye`（界面关闭上报）：服务模式下返回 `{ok:true,ignored:true}`，不再安排 4 秒退出
- `POST /api/quit`（界面「退出程序」）：服务模式下返回 403，提示到应用中心停止应用
- 前端仅在桌面模式下注册 `beforeunload` → `sendBeacon('/api/bye')`；无桌面环境隐藏「退出程序」按钮
- 根因：浏览器刷新/关标签页触发 `/api/bye`，旧逻辑 4 秒后 `process.exit(0)`，被误认为服务异常停止
- 实测：服务模式连续运行 10 分钟以上进程存活、端口持续监听、存档正常落盘

## 1.0.3（飞牛 fnOS NAS 版）

修复 NAS 上操作页面按钮点击无反应。

- 新增 `GET /api/view?path=`：浏览器内直接预览离线存档，替代「打开存档文件」
- 新增 `GET /api/download?path=`：以附件下载存档，中文文件名按 RFC 5987 编码
- 「在文件夹中显示」「打开存档文件夹」改为复制路径到剪贴板 + toast 提示
- 无桌面环境不再尝试 `xdg-open` / `explorer.exe`：`POST /api/open`、`POST /api/reveal` 返回 400 与明确文案
- `/api/state` 新增 `platform`、`canOpenLocal` 字段，前端据此切换按钮形态
- 前端 `post()` 统一校验 `ok` 字段，接口失败一律弹提示
- 保存完成后仅在能打开本地文件时自动打开，否则写日志说明

## 1.0.2（飞牛 fnOS NAS 版）

- 安装向导支持自定义存档目录，默认 `/vol1/@appdata/webpagesaver/archive`
- 存档目录不可写时自动回退默认目录，保证服务可启动

## 1.0.0（Windows 桌面版）

- 首个可用版本：单文件 EXE（Node 22 SEA），双击弹出操作窗口
- 完整存档：图片 / CSS / 字体 / 音视频 / canvas / Shadow DOM / iframe 全部内联
- 布局保持：文档流广告占位隐藏，浮层弹窗移除
- 六层广告过滤，命中统计写入结果卡片
