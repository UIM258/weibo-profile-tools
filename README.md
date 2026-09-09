# 微博主页工具集

一套运行在微博网页版个人主页（`weibo.com/u/<uid>`）上的 Tampermonkey 用户脚本，包含两个相互独立、可同时安装的工具：

- **微博个人主页分页浏览**（`weibo-profile-pager.user.js`）：把无限滚动信息流改成按页浏览
- **微博个人主页历史导出器**（`weibo-profile-exporter.user.js`）：抓取历史并打包成离线归档 ZIP

MIT 协议，© 2026 UIM258。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开对应 `.user.js` 的 Raw 地址即可安装，或新建脚本后粘贴全文
3. **登录微博**后打开任意个人主页（`https://weibo.com/u/<uid>`），页面角落会出现悬浮按钮
4. 未登录时微博会风控（提示“前方有点拥堵，请登录后使用”），脚本需登录态才能正常工作

## 脚本一：分页浏览

- 上一页 / 下一页 / +10 页 / 输入页码跳转
- 「直达最早」自动探测 TA 最早一条微博在第几页并跳转，结果本地记忆
- 卡片还原微博原生信息流样式，图片点击可灯箱预览原图
- 支持 跟随系统 / 日间 / 夜间，已翻页自动缓存

## 脚本二：历史导出器

- **日期范围**：选择 开始日期 ～ 结束日期（可留空表示不限）
- **内容筛选**：动态类型（原创/转发）× 媒体内容（纯文字/图片/视频/音乐）
- **打包格式**：HTML / JSON / CSV 可勾选
- **自动分卷**：超出每卷条数自动拆成多个 HTML 文件，页首尾有上一卷/下一卷导航；单卷时不带序号
- **外观下载前确定**：跟随系统 / 日间 / 夜间；头像已内嵌，离线可显示

### ZIP 结构

```
<用户ID>_<YYYYMMDD-YYYYMMDD>_weibo-export\
├── messages.html / messages2.html / …
├── css\style.css
├── messages.json / messages.csv
├── photos\          ← 图片 / 动图
├── video_files\     ← 视频 mp4
├── audio_files\     ← 音乐 / 音频
└── media_links.txt  ← 个别 CDN 拒绝网页抓取时的直链兜底
```

导出 HTML 为离线版：点击图片/视频会在新窗口打开本地文件，断网也能浏览。

### 进度与风控

- 逐页抓取显示进度，可暂停 / 继续 / 停止
- 请求间隔可调，失败自动退避重试，降低触发风控概率

## 说明

- 查看他人主页能翻多深受微博限制，脚本会在状态栏如实提示
- 个别视频/音乐 CDN 禁止脚本直接下载，会自动写入 `media_links.txt` 提供直链
- 请以合理间隔导出，避免高频请求被临时限制

## 目录结构

```
├── weibo-profile-pager.user.js      # 分页浏览
├── weibo-profile-exporter.user.js   # 历史导出
├── docs/GreasyFork发布说明.md        # 发布说明
├── LICENSE
└── README.md
```