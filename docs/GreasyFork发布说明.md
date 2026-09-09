# 微博主页工具 · GreasyFork 发布说明（v1.0.0）

两个相互独立的用户脚本，均只在 `weibo.com/u/*` / `www.weibo.com/u/*` 个人主页运行，可同时安装互不干扰（按钮位置不同：分页器右下角橙色、导出器左下角蓝色）。

## 脚本一：微博个人主页分页浏览（weibo-profile-pager.user.js）
把无限滚动信息流变成「按页浏览」：
- 上一页 / 下一页 / 页码输入跳转 / +10 页
- 「直达最早」：自动二分探测 TA 最早一条微博在第几页并跳转（结果会记住，免重复探测）
- 每页显示头像、昵称、时间来源、正文、九宫格图、转发框、转评赞
- 点击图片弹出灯箱预览原图（←/→ 切换、Esc 关闭）
- 暗色 / 亮色 / 跟随系统；已翻页自动缓存
- 用途：快速回看某人的早期微博，不靠滚屏

发布信息：
- 名称：微博个人主页分页浏览
- 匹配：https://weibo.com/u/* , https://www.weibo.com/u/*
- 授权：MIT

## 脚本二：微博个人主页历史导出器（weibo-profile-exporter.user.js）
把某人的全部动态按条件抓下来，打包成「Telegram 式」离线归档：
- 日期范围：从 x年x月x日 ～ x年x月x日（留空=不限）；引擎自动二分定位，只抓区间内页
- 内容类型：动态类型（原创/转发）× 媒体内容（纯文字/含图片/含视频/含音乐）
- 打包格式可勾选：HTML / JSON / CSV
- 自动分卷（可选项）：超过每卷条数拆成 messages.html / messages2.html…，页首尾有上一卷/下一卷导航；一卷时不带数字
- ZIP 内部结构（参照 Telegram Desktop 导出）：
  - 总文件夹：`<uid>_<YYYYMMDD-YYYYMMDD>_weibo-export`
  - `messages[+序号].html` + `css/style.css`
  - `messages.json` / `messages.csv`
  - `photos/`（图片动图）、`video_files/`（视频 mp4）、`audio_files/`（音乐音频）
  - `media_links.txt`（个别 CDN 不允许网页抓取时的直链兜底）
- 外观：下载前选「跟随系统 / 日间 / 夜间」，生成时直接固定
- 头像已内嵌（dataURI），离线也能显示
- 点图片/视频 → 新窗口打开本地 media 文件
- 逐页限速 + 失败重试 + 暂停/继续；防微博风控

发布信息：
- 名称：微博个人主页历史导出器
- 匹配：https://weibo.com/u/* , https://www.weibo.com/u/*
- 授权：MIT

## 发布前请替换
每个脚本头部的占位信息改成你自己的：
- `@author  you` → 你的 GreasyFork 用户名
- `@namespace  https://github.com/your-name/...` → 改成你的主页或任意唯一字符串

## GreasyFork 发布步骤
1. 登录 greasyfork.org → 「发布新脚本」
2. 语言选「简体中文」，标题/描述可参考上面的功能列表（脚本头部 @name/@description 会自动带入，可再润色）
3. 代码区粘贴对应 `.user.js` 全文 → 保存（GreasyFork 会自动加安装/更新地址）
4. 也可以先本地装 Tampermonkey 验证：Tampermonkey → 新建脚本 → 粘贴保存 → 打开微博个人主页

## 使用提醒
- 两个脚本都需要「已登录微博」才能读取完整信息流（未登录会被风控 403）
- 导出全量（几千条）请保持间隔 ≥ 500ms、耐心等待，可随时暂停续跑
- 若某个视频/音乐 CDN 拒绝脚本抓取，会自动写进 media_links.txt 供下载工具使用