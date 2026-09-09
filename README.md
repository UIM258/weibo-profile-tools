# 微博主页工具集 · Weibo Profile Tools

一套运行在 **微博网页版个人主页**（`weibo.com/u/<uid>`）上的用户脚本（userscript / Tampermonkey），包含两个相互独立、可同时安装的工具：

| 脚本 | 说明 | 入口 |
|---|---|---|
| [**微博个人主页分页浏览**](weibo-profile-pager.user.js) | 把无限滚动信息流改成“按页浏览”，支持直达最早、图片灯箱、暗色模式 | 页面右下角橙色按钮「分页浏览」 |
| [**微博个人主页历史导出器**](weibo-profile-exporter.user.js) | 按日期/类型抓取历史并打包成 Telegram 式离线归档 ZIP | 页面左下角蓝色按钮「导出历史」 |

> 均由 @UIM258 开发并维护，MIT 协议，欢迎使用与二次开发。

---

## 安装方法

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）
2. 打开下方任一脚本的 Raw 地址，Tampermonkey 会提示安装；或新建脚本后粘贴全文保存
   - 分页器：`weibo-profile-pager.user.js`
   - 导出器：`weibo-profile-exporter.user.js`
3. **登录微博**后打开任意个人主页 `https://weibo.com/u/<uid>`，即可看到悬浮按钮
4. 也可在 GreasyFork 搜索同名脚本一键安装（发布后）

**重要**：微博对未登录访问信息流会风控（页面提示“前方有点拥堵，请登录后使用”），两个脚本都需要登录态才能正常工作。

---

## 一、微博个人主页分页浏览

把“滚到底也找不到”变成真正的翻页：

- **上一页 / 下一页 / +10 页 / 输入页码跳转**
- **直达最早**：自动“指数探测 + 二分查找”TA 最早一条微博在第几页并跳转；结果本地记忆，下次免重复探测
- 卡片还原微博原生信息流样式：头像 / 认证V / 昵称 / 时间来源 / 正文 / 九宫格图 / 转发框 / 转评赞
- **图片灯箱**：点击任意图弹出原图大图预览，← / → 切换、Esc 关闭
- **暗色 / 亮色 / 跟随系统** 三种外观
- 已翻页自动缓存，来回翻阅不重复请求

适合：快速回看某人很早以前的微博，无需手动滚几千屏。

## 二、微博个人主页历史导出器

仿 Telegram Desktop「导出历史」的完整归档工具：

- **日期范围**：`从 2021-01-01 ～ 到 2023-12-31`（留空=不限），后台自动定位页码只抓区间
- **内容筛选**（两轴勾选）：
  - 动态类型：原创 / 转发
  - 媒体内容：纯文字 / 含图片 / 含视频 / 含音乐
- **打包格式**：HTML / JSON / CSV 可勾选
- **自动分卷**（可选项，默认每卷约 500 条）：超过则拆成 `messages.html / messages2.html …`，**页首与页尾都有「上一卷/下一卷 + 页码」导航**；一卷时文件名不带数字
- **外观在下载前确定**：跟随系统 / 日间 / 夜间
- **头像已内嵌**（dataURI），导出后离线、签名过期都不影响显示

### ZIP 内部结构（TG 式）

```
7618923072_20260801-20260805_weibo-export\
├── messages.html / messages2.html / …
├── css\style.css              ← 样式 + 头像
├── messages.json / messages.csv
├── photos\                    ← 图片 / 动图
├── video_files\               ← 视频 mp4
├── audio_files\               ← 音乐 / 音频
└── media_links.txt            ← 个别 CDN 拒绝网页抓取时的直链兜底
```

导出 HTML 为离线版：点图片/视频会**在新窗口打开本地 `photos/`、`video_files/` 文件**，断网也能浏览。

### 进度与风控

- 逐页抓取带状态栏进度；可**暂停 / 继续 / 停止**
- 每页请求间隔可调（默认 700ms），失败自动退避重试，降低触发微博风控的概率
- 意外刷新可从上次页码继续（内存中的已抓数据会清空，需重新开始，页码从上次位置继续）

---

## 使用提醒 / 已知限制

- 需要**已登录微博**；未登录接口返回 `403 前方有点拥堵`
- 查看他人主页能翻多深受微博风控/权限限制，未必能翻到最早（脚本会在状态栏如实提示）
- 极少数视频/音乐 CDN 禁止网页脚本直接抓取文件，会自动写入 `media_links.txt` 提供直链
- 请以合理间隔导出，避免高频请求被临时限制

## 开发 / 目录

```
├── weibo-profile-pager.user.js      # 分页浏览脚本
├── weibo-profile-exporter.user.js   # 历史导出脚本
├── docs/GreasyFork发布说明.md        # 发布说明
├── LICENSE
└── README.md
```

## License

[MIT](LICENSE) © 2026 UIM258

---

## English Quick Start

Two independent userscripts for **Weibo web profile pages** (`weibo.com/u/<id>`), both require **login**:

- **Profile Pager** – turns infinite scroll into numbered pages; jump to any page / find the earliest post; dark mode; click image to open lightbox. Floating orange button (bottom-right).
- **History Exporter** – filters by date range and content type (original/repost × text/image/video/music), then packs a Telegram-style offline archive: paginated `messages*.html` + `css/` + JSON/CSV + `photos/`, `video_files/`, `audio_files/` local media. Floating blue button (bottom-left).

Install via Tampermonkey then open any profile page while logged in.