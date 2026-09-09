// ==UserScript==
// @name         微博个人主页历史导出器
// @name:zh-CN   微博个人主页历史导出器
// @namespace    https://github.com/your-name/weibo-profile-exporter
// @version      1.0.0
// @icon         https://weibo.com/favicon.ico
// @description  按日期范围与内容类型（原创/转发 × 纯文字/图片/视频/音乐）抓取微博个人主页历史，打包成 Telegram 式归档：messages 分卷 HTML + JSON/CSV + photos/video_files/audio_files 本地媒体，可选手动分卷与日间/夜间
// @description:zh-CN  按日期范围与内容类型（原创/转发 × 纯文字/图片/视频/音乐）抓取微博个人主页历史，打包成 Telegram 式归档：messages 分卷 HTML + JSON/CSV + photos/video_files/audio_files 本地媒体，可选手动分卷与日间/夜间
// @author       you
// @license      MIT
// @match        https://weibo.com/u/*
// @match        https://www.weibo.com/u/*
// @run-at       document-idle
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var TAG = '[微博导出器]';
    var m = location.pathname.match(/^\/u\/(\d+)/);
    if (!m) { return; }
    var UID = m[1];

    // ============ 配置 ============
    var CFG = {
        defaultDelay: 700,     // 每页间隔 ms
        minDelay: 350,
        maxDelay: 4000,
        retries: 3,            // 单页失败重试次数
        requestTimeout: 15000,
        maxPage: 8192,         // “全部”模式探测上限
        keep: 200              // 每多少页写一次续传进度
    };

    // ============ 状态 ============
    var S = {
        posts: [],             // 已收集（导出用）
        pageSet: {},           // page -> true（已抓）
        nextPage: 1,           // 下一个要抓的页
        startPage: 1,          // 收集起点（二分定位后）
        fromDate: '',          // YYYY-MM-DD 起（含，空=最早）
        toDate: '',            // YYYY-MM-DD 止（含，空=今天）
        boundaryDone: false,   // 是否已完成起始页定位
        types: null,           // {text,pic,card,rt}
        running: false,
        paused: false,
        stop: false,
        delay: CFG.defaultDelay,
        totalHint: null,       // 接口统计总数
        screenName: '',
        avatar: '',
        verified: false,
        verified_type: null,
        finished: false,
        lastError: ''
    };
    var LKEY = 'wbe_progress_' + UID;
    var els = {};
    var timer = null;

    // ============ 工具 ============
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    function parseTime(s) {
        if (!s) return '';
        var mm = String(s).match(/^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/);
        if (!mm) { var d = new Date(s); return isNaN(d.getTime()) ? s : d.toISOString(); }
        var mon = MONTHS[mm[2]];
        if (mon === undefined) return s;
        var tz = mm[7];
        var tzMin = (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3, 5), 10)) * (tz[0] === '-' ? -1 : 1);
        return new Date(Date.UTC(+mm[8], mon, +mm[3], +mm[4], +mm[5], +mm[6]) - tzMin * 60000).toISOString();
    }

    function stripHtml(h) {
        var tpl = document.createElement('template');
        tpl.innerHTML = (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n');
        return (tpl.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtNow() {
        var d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
    }
    function fmtNum(v) { var n = Number(v) || 0; return n >= 100000000 ? (n / 100000000).toFixed(1) + '亿' : (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n)); }

    // 图片 { thumb, full }
    function picPairs(mb) {
        var out = [];
        if (Array.isArray(mb.pic_ids) && mb.pic_infos) {
            mb.pic_ids.forEach(function (pid) {
                var info = mb.pic_infos[pid];
                if (!info) return;
                var thumb = (info.bmiddle && info.bmiddle.url) || (info.thumbnail && info.thumbnail.url) || (info.large && info.large.url);
                var full = (info.largest && info.largest.url) || (info.mw2000 && info.mw2000.url) || (info.original && info.original.url) || (info.large && info.large.url) || thumb;
                if (thumb || full) out.push({ thumb: thumb || full, full: full || thumb });
            });
        } else if (Array.isArray(mb.pics)) {
            mb.pics.forEach(function (p) {
                var full = (p.large && p.large.url) || p.url || p.original_pic || p.bmiddle_pic;
                var thumb = (p.bmiddle && p.bmiddle.url) || full;
                if (full || thumb) out.push({ thumb: thumb || full, full: full || thumb });
            });
        } else {
            var full = mb.original_pic || mb.bmiddle_pic || mb.thumbnail_pic;
            if (full) out.push({ thumb: mb.bmiddle_pic || mb.thumbnail_pic || full, full: full });
        }
        return out;
    }

    // 转成可导出的干净对象（递归剥一层转发）
    function cleanPost(mb) {
        var pics = picPairs(mb);
        var o = {
            mblogid: mb.mblogid || mb.id || '',
            id: mb.idstr || mb.id || '',
            created_at: parseTime(mb.created_at),
            text_html: mb.text || '',
            text: stripHtml(mb.text || ''),
            source: stripHtml(mb.source || ''),
            isLongText: !!mb.isLongText,
            region: mb.region_name || '',
            reposts: Number(mb.reposts_count) || 0,
            comments: Number(mb.comments_count) || 0,
            likes: Number(mb.attitudes_count) || 0,
            pics: pics,
            author: {
                name: (mb.user && mb.user.screen_name) || '',
                id: (mb.user && (mb.user.idstr || mb.user.id)) || '',
                avatar: (mb.user && (mb.user.avatar_hd || mb.user.avatar_large || mb.user.profile_image_url)) || '',
                verified: !!(mb.user && mb.user.verified),
                verified_type: (mb.user && typeof mb.user.verified_type === 'number') ? mb.user.verified_type : null
            },
            url: 'https://weibo.com/' + ((mb.user && (mb.user.idstr || mb.user.id)) || UID) + '/' + (mb.mblogid || mb.id)
        };
        if (mb.retweeted_status) {
            var r = mb.retweeted_status;
            o.retweet = {
                author: (r.user && r.user.screen_name) || '',
                author_id: (r.user && (r.user.idstr || r.user.id)) || '',
                author_avatar: (r.user && (r.user.avatar_hd || r.user.avatar_large || r.user.profile_image_url)) || '',
                author_verified: !!(r.user && r.user.verified),
                created_at: parseTime(r.created_at),
                text: stripHtml(r.text || ''),
                text_html: r.text || '',
                pics: picPairs(r)
            };
        }
        if (mb.page_info) {
            var pi = mb.page_info;
            var t = pi.page_title || (pi.media_info && pi.media_info.name) || '';
            if (t) o.card = { type: pi.type || '', title: stripHtml(t), url: pi.page_url || '' };
        }
        var cl = classifyMblog(mb);
        o.kind = cl.kind;
        o.media = cl.media;
        o.mediaFiles = cl.files || [];
        return o;
    }

    // ============ 抓取引擎 ============
    function apiUrl(page) { return 'https://weibo.com/ajax/statuses/mymblog?uid=' + UID + '&page=' + page + '&feature=0'; }

    function fetchPageRaw(page) {
        var headers = { 'x-requested-with': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' };
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, CFG.requestTimeout);
        return fetch(apiUrl(page), { credentials: 'include', headers: headers, signal: ctrl.signal, cache: 'no-store' })
            .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .catch(function (e) { clearTimeout(t); if (e && e.name === 'AbortError') throw new Error('请求超时'); throw e; });
    }

    function fetchPage(page) {
        return fetchPageRaw(page).then(function (json) {
            if (!json || json.ok !== 1) throw new Error((json && (json.message || json.msg)) || '接口异常 ok=' + (json && json.ok));
            var list = (json.data && Array.isArray(json.data.list)) ? json.data.list : [];
            if (json.data) {
                if (S.totalHint === null && json.data.total) S.totalHint = Number(json.data.total);
                if (!S.screenName || !S.avatar) {
                    var u0 = list[0] && list[0].user;
                    if (u0) {
                        if (!S.screenName) S.screenName = u0.screen_name || '';
                        if (!S.avatar) S.avatar = u0.avatar_hd || u0.avatar_large || u0.profile_image_url || '';
                        if (!S.verified && u0.verified) { S.verified = true; S.verified_type = (typeof u0.verified_type === 'number') ? u0.verified_type : null; }
                    }
                }
            }
            return list;
        });
    }

    function saveProgress() {
        try {
            localStorage.setItem(LKEY, JSON.stringify({ nextPage: S.nextPage, count: S.posts.length, fromDate: S.fromDate, toDate: S.toDate, types: S.types, boundaryDone: S.boundaryDone, totalHint: S.totalHint }));
        } catch (e) {}
    }
    function loadProgress() {
        try {
            var raw = localStorage.getItem(LKEY);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (o && o.nextPage > 1) return o;
        } catch (e) {}
        return null;
    }

    function setStatus(text, isErr) {
        if (!els.status) return;
        els.status.textContent = text;
        els.status.className = 'wbe-status' + (isErr ? ' wbe-err' : '');
    }

    function updateUI() {
        var range = (S.fromDate || '最早') + ' ~ ' + (S.toDate || '今天');
        var done = Math.max(0, S.nextPage - 1);
        els.progress.textContent = (S.boundaryDone ? '已抓取到第 ' + done + ' 页' : '正在定位起始页…')
            + ' · 范围 ' + range + ' · 已收集 ' + S.posts.length + ' 条'
            + (S.totalHint ? ' / 接口统计约 ' + S.totalHint + ' 条' : '');
        els.start.disabled = S.running;
        els.pause.disabled = !S.running;
        els.resume.disabled = S.running || (!S.paused && S.posts.length === 0) || S.finished;
        els.stop.disabled = !S.running && !S.paused;
    }

    function localDateOf(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso).slice(0, 10);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function inDateRange(iso) {
        var d = localDateOf(iso);
        if (S.fromDate && d < S.fromDate) return false;
        if (S.toDate && d > S.toDate) return false;
        return true;
    }

    function matchTypes(p) {
        var t = S.types;
        if (!t) return true;
        if (p.kind === 'repost' ? !t.rt : !t.orig) return false;
        if (p.media === 'pic') return !!t.pic;
        if (p.media === 'video') return !!t.video;
        if (p.media === 'music') return !!t.music;
        return !!t.text;
    }

    function finishRun(msg) {
        S.running = false; S.paused = false; S.finished = true;
        saveProgress();
        setStatus(msg);
        updateUI();
    }

    // 二分查找：最小的页码 p，使得第 p 页第一条的日期 <= toDate（即从 p 起可能包含范围内内容）
    function doSeek() {
        if (!S.running) return;
        if (!S.toDate) { S.boundaryDone = true; S.nextPage = 1; S.startPage = 1; saveProgress(); engineLoop(); return; }
        setStatus('正在定位起始页（二分查找日期 ' + S.toDate + ' 附近，约 13 次轻量请求）…');
        var lo = 1, hi = CFG.maxPage;
        var step = function () {
            if (!S.running) return;
            if (lo >= hi) {
                var n = lo;
                S.startPage = (n > 1) ? n - 1 : 1;
                S.nextPage = S.startPage;
                S.boundaryDone = true;
                saveProgress();
                setStatus('定位完成：从第 ' + S.startPage + ' 页开始收集。');
                updateUI();
                engineLoop();
                return;
            }
            var mid = Math.floor((lo + hi) / 2);
            fetchPageRaw(mid).then(function (json) {
                var list = (json.data && Array.isArray(json.data.list)) ? json.data.list : [];
                var firstDate = list.length ? localDateOf(list[0].created_at) : '';
                var pred = !list.length || firstDate <= S.toDate; // 空页视为比任何日期都旧
                if (pred) hi = mid; else lo = mid + 1;
                if (!S.running) return;
                setTimeout(step, 250);
            }).catch(function () {
                if (!S.running) return;
                setTimeout(step, 500); // 失败也继续二分，不中断
            });
        };
        step();
    }

    function engineLoop() {
        if (!S.running) return;
        if (S.stop) { S.running = false; S.paused = false; setStatus('已停止：已收集 ' + S.posts.length + ' 条，可下载。'); updateUI(); return; }
        if (!S.boundaryDone) { doSeek(); return; }
        var page = S.nextPage;
        if (page > CFG.maxPage) {
            finishRun('达到探测上限 ' + CFG.maxPage + ' 页仍未到底，已停止。');
            return;
        }
        setStatus('正在抓取第 ' + page + ' 页…（每页间隔 ' + S.delay + 'ms，可随时暂停）');
        var attempt = 0;
        var doFetch = function () {
            if (!S.running) return Promise.resolve();
            return fetchPage(page).then(function (list) {
                if (!S.running) return;
                list.forEach(function (mb) {
                    try {
                        var p = cleanPost(mb);
                        if (inDateRange(p.created_at) && matchTypes(p)) S.posts.push(p);
                    } catch (e) {}
                });
                S.pageSet[page] = true;
                S.nextPage = page + 1;
                S.delay = CFG.defaultDelay;
                if (page % CFG.keep === 0) saveProgress();
                updateUI();
                if (list.length === 0) {
                    finishRun('已到最早（第 ' + (page - 1) + ' 页为空）：本范围共导出 ' + S.posts.length + ' 条');
                    return;
                }
                var lastD = localDateOf(list[list.length - 1].created_at);
                if (S.fromDate && lastD < S.fromDate) {
                    finishRun('完成：' + (S.fromDate || '最早') + ' ~ ' + (S.toDate || '今天') + ' 共导出 ' + S.posts.length + ' 条（扫描到第 ' + page + ' 页）');
                    return;
                }
                if (S.delay > 0) { timer = setTimeout(engineLoop, S.delay); } else { engineLoop(); }
            }).catch(function (err) {
                if (!S.running) return;
                attempt++;
                if (attempt <= CFG.retries) {
                    var wait = Math.min(CFG.maxDelay, 1000 * Math.pow(2, attempt));
                    setStatus('第 ' + page + ' 页失败（' + err.message + '），' + wait + 'ms 后第 ' + attempt + ' 次重试…', true);
                    S.delay = Math.min(CFG.maxDelay, S.delay + 400);
                    timer = setTimeout(doFetch, wait);
                } else {
                    S.running = false; S.paused = true; S.lastError = err.message;
                    setStatus('第 ' + page + ' 页连续失败：' + err.message + '（可能触发风控）。已暂停，可稍后点「继续」。', true);
                    updateUI();
                }
            });
        };
        doFetch();
    }

    function start() {
        var from = (els.fromDate && els.fromDate.value) || '';
        var to = (els.toDate && els.toDate.value) || '';
        if (from && to && from > to) { setStatus('开始日期不能晚于结束日期。', true); return; }
        var dd = parseInt((els.delay && els.delay.value), 10);
        S.posts = []; S.pageSet = {}; S.running = true; S.paused = false; S.stop = false; S.finished = false;
        S.fromDate = from; S.toDate = to; S.boundaryDone = false; S.nextPage = 1; S.startPage = 1;
        S.types = {
            orig: !!(els.chkOrig && els.chkOrig.checked),
            rt: !!(els.chkRt && els.chkRt.checked),
            text: !!(els.chkText && els.chkText.checked),
            pic: !!(els.chkPic && els.chkPic.checked),
            video: !!(els.chkVideo && els.chkVideo.checked),
            music: !!(els.chkMusic && els.chkMusic.checked)
        };
        S.delay = (!isNaN(dd) && dd >= CFG.minDelay && dd <= CFG.maxDelay) ? dd : CFG.defaultDelay;
        saveProgress();
        updateUI();
        setStatus('开始导出：' + (from || '最早') + ' ~ ' + (to || '今天') + (S.toDate ? '，先定位起始页…' : ''));
        doSeek();
    }

    function pause() {
        if (S.running) { S.running = false; S.paused = true; clearTimeout(timer); saveProgress(); setStatus('已暂停：已收集 ' + S.posts.length + ' 条，点「继续」接着抓。'); updateUI(); }
    }

    function resume() {
        if (S.posts.length === 0 && !S.paused) { start(); return; }
        S.running = true; S.paused = false; S.stop = false; S.finished = false;
        updateUI();
        setStatus('继续抓取：' + (S.fromDate || '最早') + ' ~ ' + (S.toDate || '今天'));
        if (!S.boundaryDone) doSeek(); else engineLoop();
    }

    function stopAndSave() { S.stop = true; if (!S.running && S.paused) { S.paused = false; S.finished = true; } clearTimeout(timer); updateUI(); }

    // ============ 导出生成 ============
    function buildJSON() {
        var payload = {
            exported_at: new Date().toISOString(),
            uid: UID,
            screen_name: S.screenName || '',
            total_fetched: S.posts.length,
            total_hint: S.totalHint || null,
            posts: S.posts
        };
        return JSON.stringify(payload, null, 2);
    }

    function csvEscape(v) {
        var s = String(v === undefined || v === null ? '' : v);
        if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }
    function buildCSV() {
        var head = ['时间', 'mblogid', '正文', '来源', '转发数', '评论数', '点赞数', '是否长文', '图片数', '图片原图URL', '是否转发', '转发作者', '转发正文', '原文链接'];
        var rows = [head.join(',')];
        S.posts.forEach(function (p) {
            var pics = (p.pics || []).map(function (x) { return x.full; }).join('|');
            rows.push([
                csvEscape(p.created_at), csvEscape(p.mblogid), csvEscape(p.text), csvEscape(p.source),
                p.reposts, p.comments, p.likes, p.isLongText ? '是' : '否',
                (p.pics || []).length, csvEscape(pics),
                p.retweet ? '是' : '否', csvEscape(p.retweet ? p.retweet.author : ''), csvEscape(p.retweet ? p.retweet.text : ''),
                csvEscape(p.url)
            ].join(','));
        });
        return '\uFEFF' + rows.join('\r\n');
    }

    function escHtml(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // ============ 页面生成（单文件 / 分卷 / 外置资源） ============
    function getThemeSel() {
        try {
            var r = document.querySelector('input[name="wbe-theme"]:checked');
            if (r) return r.value;
        } catch (e) {}
        return 'auto';
    }
    function volName(i) { return i === 1 ? 'messages.html' : 'messages' + i + '.html'; }
    function exportCssText() {
        var lines = [
            ':root{--bg:#f2f3f5;--panel:#fff;--line:#f2f3f5;--line2:#f7f8fa;--text:#1f2329;--muted:#9aa0a6;--faint:#c0c4cc;--softbg:#f7f8fa;--imgbg:#f2f3f5;--accent:#ff8200;--btnbg:#f0f1f3;}',
            'html.dark{--bg:#0d0e12;--panel:#16171c;--line:#22242b;--line2:#1f2126;--text:#e5e6eb;--muted:#7a7f88;--faint:#565b63;--softbg:#1f2126;--imgbg:#1f2126;--accent:#ffa940;--btnbg:#26262b;}',
            '@media (prefers-color-scheme: dark){:root:not(.light){--bg:#0d0e12;--panel:#16171c;--line:#22242b;--line2:#1f2126;--text:#e5e6eb;--muted:#7a7f88;--faint:#565b63;--softbg:#1f2126;--imgbg:#1f2126;--accent:#ffa940;--btnbg:#26262b;}}',
            'body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;transition:background .2s,color .2s;}',
            '.wrap{max-width:680px;margin:0 auto;background:var(--panel);min-height:100vh;}',
            '.profile{position:relative;padding:26px 24px 14px;background:var(--panel);}',
            '.mode-btn{position:absolute;top:18px;right:18px;border:1px solid var(--line2);background:var(--btnbg);color:var(--muted);font-size:13px;padding:5px 10px;border-radius:999px;cursor:pointer;}',
            '.mode-btn:hover{color:var(--accent);border-color:var(--accent);}',
            '.prow{display:flex;align-items:center;gap:14px;}',
            '.pav{width:88px;height:88px;border-radius:50%;background:var(--imgbg);background-size:cover;background-position:center;flex:0 0 auto;}',
            '.pav.bav{display:inline-block;}',
            '.av.bav{display:inline-block;}',
            '.bav{background-repeat:no-repeat;}',
            '.pinfo h1{margin:0;font-size:24px;font-weight:600;display:flex;align-items:center;gap:6px;}',
            '.pinfo .sub{color:var(--muted);font-size:13px;margin-top:8px;line-height:1.6;}',
            '.tabs{margin-top:14px;display:flex;gap:22px;font-size:15px;}',
            '.tabs .on{font-weight:600;border-bottom:2px solid var(--accent);padding-bottom:4px;}',
            '.vol-nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 24px;background:var(--panel);border-bottom:1px solid var(--line);}',
            '.vol-nav a{color:var(--accent);text-decoration:none;font-size:13px;}',
            '.vol-nav a:hover{text-decoration:underline;}',
            '.vol-nav .cur{color:var(--muted);font-weight:600;}',
            '.vol-nav .sp{flex:1;}',
            '.post{padding:18px 24px;border-bottom:1px solid var(--line);}',
            '.ph{display:flex;gap:10px;}',
            '.av{width:48px;height:48px;border-radius:50%;background:var(--imgbg);background-size:cover;background-position:center;flex:0 0 auto;}',
            '.who{flex:1;min-width:0;}',
            '.nm{font-size:16px;font-weight:600;display:flex;align-items:center;gap:4px;}',
            '.meta{margin-top:3px;font-size:13px;color:var(--muted);}',
            '.meta .src{margin-left:8px;}',
            '.orig{font-size:12px;color:var(--faint);text-decoration:none;align-self:flex-start;flex:0 0 auto;}',
            '.orig:hover{color:var(--accent);}',
            '.txt{margin-top:6px;font-size:15px;line-height:1.65;word-break:break-word;}',
            '.txt a{color:var(--text);text-decoration:none;}',
            '.txt img.face{width:18px;height:18px;vertical-align:-3px;}',
            '.long-hint{font-size:12px;color:var(--muted);margin-top:4px;}',
            '.imgs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:8px;border-radius:6px;overflow:hidden;}',
            '.imgs .cell{display:block;}',
            '.imgs img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--imgbg);}',
            '.imgs.one{display:block;}',
            '.imgs.one .cell{display:inline-block;}',
            '.imgs.one img{aspect-ratio:auto;width:auto;max-width:100%;max-height:520px;object-fit:contain;}',
            '.rt-imgs{grid-template-columns:repeat(3,1fr);margin-top:6px;}',
            '.rt-imgs img{aspect-ratio:1/1;height:auto;}',
            '.cardbox{margin-top:8px;padding:10px 12px;background:var(--softbg);border-radius:6px;font-size:14px;}',
            '.cardbox a{color:var(--accent);text-decoration:none;margin-left:8px;}',
            '.rt{margin-top:8px;padding:12px 14px;background:var(--softbg);border-radius:6px;}',
            '.rt-head{display:flex;align-items:center;gap:6px;}',
            '.rt-av{width:24px;height:24px;border-radius:50%;object-fit:cover;background:var(--imgbg);}',
            '.rt-name{font-size:14px;font-weight:600;}',
            '.rt-txt{margin-top:5px;font-size:14px;line-height:1.6;color:var(--muted);word-break:break-word;}',
            '.rt-txt a{color:var(--text);text-decoration:none;}',
            '.med-open{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}',
            '.med-open .btn{border:1px solid var(--line2);background:var(--btnbg);color:var(--text);font-size:13px;padding:6px 12px;border-radius:6px;text-decoration:none;}',
            '.med-open .btn:hover{color:var(--accent);border-color:var(--accent);}',
            '.med-open .btn.ghost{background:transparent;}',
            '.acts{display:flex;margin-top:10px;padding-top:10px;border-top:1px solid var(--line2);}',
            '.act{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;color:var(--muted);font-size:13px;}',
            '.act .ic{display:inline-flex;}',
            '.act b{font-weight:400;}',
            '.act:hover{color:var(--accent);}',
            '.exp-note{color:var(--muted);font-size:12px;padding:12px 24px;}'
        ].join('\n');
        return lines + (AVATAR_URI ? '\n.bav{background-image:url("' + AVATAR_URI + '");}' : '');
    }
    function exportJsText() {
        return '\n(function () {\n  var root = document.documentElement;\n  var autoDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;\n  var dark = autoDark;\n  var btn = document.getElementById("modeBtn");\n  function paint() { root.classList.toggle("dark", dark); if (btn) { btn.textContent = dark ? "☀️ 日间" : "🌙 夜间"; btn.title = dark ? "切换到日间模式" : "切换到夜间模式"; } }\n  if (btn) btn.addEventListener("click", function () { dark = !dark; paint(); });\n  paint();\n})();\n';
    }
    function fmtLocal2(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function fixHtmlText(html) {
        return String(html || '')
            .replace(/src="\/\//g, 'src="https://')
            .replace(/href="\/(?!\/)/g, 'href="https://weibo.com/')
            .replace(/<a /g, '<a target="_blank" rel="noopener" ');
    }
    function vBadge2(u) {
        if (!u || !u.verified) return '';
        var color = (u.verified_type === 0) ? '#2d9bff' : 'var(--accent)';
        return '<i class="v" style="display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;border-radius:3px;background:' + color + ';color:#fff;font-style:normal;font-size:10px;font-weight:700;padding:0 2px;vertical-align:1px;box-sizing:border-box;">V</i>';
    }
    var IC_FWD2 = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/></svg>';
    var IC_CMT2 = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-5-1.6L3 20l1.4-4.2A8.5 8.5 0 1 1 21 11.5z"/></svg>';
    var IC_LIKE2 = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';

    function pageNavHtml(cur, total) {
        if (total <= 1) return '';
        var h = '<div class="vol-nav">';
        h += '<a href="' + volName(Math.max(1, cur - 1)) + '">‹ 上一卷</a>';
        for (var i = 1; i <= total; i++) {
            h += (i === cur) ? '<span class="cur">' + i + '</span>' : '<a href="' + volName(i) + '">' + i + '</a>';
        }
        h += '<a href="' + volName(Math.min(total, cur + 1)) + '">下一卷 ›</a>';
        h += '<span class="sp"></span><span>第 ' + cur + ' / ' + total + ' 卷</span>';
        h += '</div>';
        return h;
    }

    // posts: 本卷内容；cfg: {offline, external, curVol, totalVol}
    function renderPage(posts, cfg) {
        function act(icon, label, n) {
            return '<span class="act"><i class="ic">' + icon + '</i>' + escHtml(label) + (n ? '<b>' + escHtml(fmtNum(n)) + '</b>' : '') + '</span>';
        }
        function picMedia(pics, cls) {
            if (!pics || !pics.length) return '';
            var one = pics.length === 1 ? ' one' : '';
            var h = '<div class="imgs ' + (cls || '') + one + '">';
            pics.forEach(function (x) {
                var name = urlBase(x.full);
                var src = (cfg.offline ? 'photos/' + name : x.thumb);
                var link = (cfg.offline ? 'photos/' + name : x.full);
                h += '<a class="cell" href="' + escHtml(link) + '" target="_blank" rel="noopener" title="新窗口打开本地图片"><img loading="lazy" src="' + escHtml(src) + '" alt=""/></a>';
            });
            h += '</div>';
            return h;
        }
        function rtBox(p) {
            var r = p.retweet;
            if (!r) return '';
            var h = '<div class="rt">';
            h += '<div class="rt-head">';
            if (r.author_avatar) h += '<img class="rt-av" src="' + escHtml(r.author_avatar) + '" alt=""/>';
            h += '<span class="rt-name">' + escHtml(r.author || '') + '</span>' + vBadge2({ verified: r.author_verified });
            h += '</div>';
            h += '<div class="rt-txt">' + fixHtmlText(r.text_html || escHtml(r.text)) + '</div>';
            h += picMedia(r.pics, 'rt-imgs');
            h += '</div>';
            return h;
        }
        var cards = posts.map(function (p) {
            var au = (p.author && (p.author.name || p.author.avatar)) ? p.author : { name: S.screenName, avatar: S.avatar, verified: S.verified, verified_type: S.verified_type };
            var h = '<div class="post">';
            h += '<div class="ph">';
            if (au.avatar || S.avatar) h += AVATAR_URI ? '<span class="av bav" role="img" aria-label="头像"></span>' : '<img class="av" src="' + escHtml(au.avatar || S.avatar) + '" alt=""/>';
            h += '<div class="who"><div class="nm">' + escHtml(au.name || S.screenName || '') + vBadge2(au) + '</div>';
            h += '<div class="meta">' + escHtml(fmtLocal2(p.created_at)) + (p.source ? '<span class="src">来自 ' + escHtml(p.source) + '</span>' : '') + '</div></div>';
            h += '<a class="orig" href="' + escHtml(p.url) + '" target="_blank" rel="noopener" title="在微博打开原文">原文 ↗</a>';
            h += '</div>';
            h += '<div class="txt">' + fixHtmlText(p.text_html || escHtml(p.text)) + '</div>';
            if (p.isLongText) h += '<div class="long-hint">（长微博：完整内容请在微博中打开）</div>';
            h += picMedia(p.pics);
            var play = null;
            if (p.mediaFiles && p.mediaFiles.length) {
                var f0 = p.mediaFiles[0];
                if (f0.dir === 'video_files' || f0.dir === 'audio_files') play = f0;
            }
            if (p.media === 'video' || p.media === 'music' || play) {
                h += '<div class="med-open">';
                if (play) h += '<a class="btn" href="' + escHtml(play.dir + '/' + play.name) + '" target="_blank" rel="noopener" title="新窗口打开本地媒体">▶ 打开本地媒体（' + escHtml(play.name) + '）</a>';
                if (p.card && p.card.url) h += '<a class="btn ghost" href="' + escHtml(p.card.url) + '" target="_blank" rel="noopener">原页面 ↗</a>';
                h += '</div>';
            } else if (p.card && p.card.title && !p.pics.length) {
                h += '<div class="cardbox">' + escHtml(p.card.title) + (p.card.url ? '<a href="' + escHtml(p.card.url) + '" target="_blank" rel="noopener">查看</a>' : '') + '</div>';
            }
            h += rtBox(p);
            h += '<div class="acts">' + act(IC_FWD2, '转发', p.reposts) + act(IC_CMT2, '评论', p.comments) + act(IC_LIKE2, '赞', p.likes) + '</div>';
            h += '</div>';
            return h;
        }).join('\n');

        var cssTag = cfg.external ? '<link href="css/style.css" rel="stylesheet"/>' : '<style>' + exportCssText() + '</style>';
        var jsTag = '';
        var htmlClass = cfg.theme === 'dark' ? ' class="dark"' : (cfg.theme === 'light' ? ' class="light"' : '');
        var title = escHtml((S.screenName || UID) + ' 的微博主页归档') + (cfg.totalVol > 1 ? '（第 ' + cfg.curVol + '/' + cfg.totalVol + ' 卷）' : '');
        return '<!DOCTYPE html>\n<html lang="zh-CN"' + htmlClass + '>\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>' + title + '</title>\n' + cssTag + '\n</head>\n<body>\n<div class="wrap">\n' +
            '<div class="profile"><div class="prow">' +
            (S.avatar ? (AVATAR_URI ? '<span class="pav bav" role="img" aria-label="头像"></span>' : '<img class="pav" src="' + escHtml(S.avatar) + '" alt=""/>') : '') +
            '<div class="pinfo"><h1>' + escHtml(S.screenName || UID) + vBadge2({ verified: S.verified, verified_type: S.verified_type }) + '</h1>' +
            '<div class="sub">微博主页历史归档 · 本卷 ' + posts.length + ' 条 · 共导出 ' + S.posts.length + ' 条' + (S.totalHint ? '（接口统计约 ' + S.totalHint + ' 条）' : '') + ' · 导出于 ' + escHtml(fmtNow()) + '</div></div></div>' +
            '<div class="tabs"><span class="on">微博</span><span>视频</span><span>超话</span><span>相册</span></div></div>\n' +
            pageNavHtml(cfg.curVol, cfg.totalVol) + '\n' +
            cards + '\n' +
            pageNavHtml(cfg.curVol, cfg.totalVol) + '\n' +
            '<div class="exp-note">以上由「微博主页历史导出器」生成，时间为本地时区。离线版中点击图片/视频会在新窗口打开本地文件（photos/、video_files/、audio_files/）。</div>\n' +
            '</div>\n' + jsTag + '\n</body>\n</html>';
    }

    // 单文件快速版（内嵌样式/脚本；不打包时用）
    function buildHTML(offline) {
        return renderPage(S.posts, { offline: !!offline, external: false, curVol: 1, totalVol: 1, theme: getThemeSel() });
    }

    // 分卷版：返回 [{name, html}]；perVol 每卷条数
    function buildVolumePages(perVol, external, theme) {
        var per = (perVol && perVol > 0) ? perVol : 500;
        var chunks = [];
        for (var i = 0; i < S.posts.length; i += per) chunks.push(S.posts.slice(i, i + per));
        if (!chunks.length) chunks.push([]);
        var out = [];
        for (var v = 0; v < chunks.length; v++) {
            out.push({ name: volName(v + 1), html: renderPage(chunks[v], { offline: true, external: !!external, curVol: v + 1, totalVol: chunks.length, theme: theme || 'auto' }) });
        }
        return out;
    }

    function download(name, content, mime) {
        try {
            var blob = new Blob([content], { type: mime + ';charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
        } catch (e) { alert('下载失败：' + e.message); }
    }

    // ============ 媒体分类 & ZIP 打包 ============
    function urlBase(u) {
        try {
            var s = String(u || '').split('?')[0];
            var b = s.split('/').pop() || '';
            return b.replace(/[^A-Za-z0-9._-]/g, '_');
        } catch (e) { return 'file'; }
    }
    function safeExt(u) {
        var b = urlBase(u);
        var i = b.lastIndexOf('.');
        return (i > 0 && b.length - i <= 6) ? b.slice(i) : '';
    }
    // 判断单条 mblog（或转发原博）的媒体与可下载文件
    function scanMedia(x) {
        if (!x) return null;
        if (Array.isArray(x.pic_ids) && x.pic_ids.length && x.pic_infos) {
            var arr = [];
            x.pic_ids.forEach(function (pid) {
                var info = x.pic_infos[pid];
                if (!info) return;
                var full = (info.largest && info.largest.url) || (info.mw2000 && info.mw2000.url) || (info.original && info.original.url) || (info.large && info.large.url) || (info.bmiddle && info.bmiddle.url) || (info.thumbnail && info.thumbnail.url);
                var thumb = (info.bmiddle && info.bmiddle.url) || (info.thumbnail && info.thumbnail.url) || full;
                if (full) arr.push({ url: full, name: urlBase(full), dir: 'photos' });
            });
            if (arr.length) return { media: 'pic', files: arr };
        }
        var pi = x.page_info;
        if (pi && pi.media_info) {
            var mi = pi.media_info;
            var vurl = mi.mp4_720p_mp4 || mi.mp4_hd_url || mi.h265_mp4_hd || mi.mp4_sd_url || mi.stream_url_hd || mi.stream_url || '';
            var fmt = mi.format || '';
            if (/mp3|audio|m4a/i.test(fmt) || /\.mp3($|\?)/i.test(vurl) || /\.m4a($|\?)/i.test(vurl)) {
                return { media: 'music', files: vurl ? [{ url: vurl, name: (x.mblogid || 'm') + '_audio' + (safeExt(vurl) || '.mp3'), dir: 'audio_files' }] : [] };
            }
            if (vurl) return { media: 'video', files: [{ url: vurl, name: (x.mblogid || 'm') + '_video' + (safeExt(vurl) || '.mp4'), dir: 'video_files' }] };
            var u = ((pi.page_url || '') + ' ' + (mi.h5_url || ''));
            if (/music\.163|y\.qq|kugou|kg\.qq/i.test(u)) return { media: 'music', files: [] };
            return { media: 'card', files: [] };
        }
        if (pi) {
            var u2 = pi.page_url || '';
            if (/music\.163|y\.qq|kugou|kg\.qq|\/music/i.test(u2)) return { media: 'music', files: [] };
            if (pi.type === '11' || /video/i.test(String(pi.type || ''))) return { media: 'video', files: [] };
            return { media: 'card', files: [] };
        }
        return { media: 'text', files: [] };
    }
    function classifyMblog(mb) {
        var rt = mb.retweeted_status;
        var self = scanMedia(mb);
        var rtRes = scanMedia(rt);
        var shown = self;
        if (!shown || shown.media === 'text') { if (rtRes && rtRes.media !== 'text') shown = rtRes; }
        else if (rtRes && rtRes.media !== 'text' && (rtRes.media === 'video' || rtRes.media === 'music')) { shown = rtRes; }
        var media = (shown && shown.media) || 'text';
        if (media === 'card') media = 'text';
        return { kind: rt ? 'repost' : 'original', media: media, files: (shown && shown.files) || [] };
    }

    // ---- 极简 ZIP（无压缩 store 模式） ----
    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(u8) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function dosDateTime(d) {
        d = d || new Date();
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        var date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
        return { time: time & 0xFFFF, date: date };
    }
    function makeZip(entries) {
        var locals = [];
        var centrals = [];
        var offset = 0;
        var dt = dosDateTime(new Date());
        entries.forEach(function (en) {
            var nameU8 = new TextEncoder().encode(en.name);
            var data = en.data;
            var crc = crc32(data);
            var local = new Uint8Array(30 + nameU8.length + data.length);
            var dv = new DataView(local.buffer);
            dv.setUint32(0, 0x04034b50, true);
            dv.setUint16(4, 20, true);
            dv.setUint16(6, 0x0800, true);
            dv.setUint16(8, 0, true);
            dv.setUint16(10, dt.time, true);
            dv.setUint16(12, dt.date, true);
            dv.setUint32(14, crc, true);
            dv.setUint32(18, data.length, true);
            dv.setUint32(22, data.length, true);
            dv.setUint16(26, nameU8.length, true);
            dv.setUint16(28, 0, true);
            local.set(nameU8, 30);
            local.set(data, 30 + nameU8.length);
            locals.push(local);

            var cen = new Uint8Array(46 + nameU8.length);
            var cdv = new DataView(cen.buffer);
            cdv.setUint32(0, 0x02014b50, true);
            cdv.setUint16(4, 20, true);
            cdv.setUint16(6, 20, true);
            cdv.setUint16(8, 0x0800, true);
            cdv.setUint16(10, 0, true);
            cdv.setUint16(12, dt.time, true);
            cdv.setUint16(14, dt.date, true);
            cdv.setUint32(16, crc, true);
            cdv.setUint32(20, data.length, true);
            cdv.setUint32(24, data.length, true);
            cdv.setUint16(28, nameU8.length, true);
            cdv.setUint16(30, 0, true);
            cdv.setUint16(32, 0, true);
            cdv.setUint16(34, 0, true);
            cdv.setUint16(36, 0, true);
            cdv.setUint32(38, 0, true);
            cdv.setUint32(42, offset, true);
            cen.set(nameU8, 46);
            centrals.push(cen);
            offset += local.length;
        });
        var cdSize = centrals.reduce(function (a, c) { return a + c.length; }, 0);
        var end = new Uint8Array(22);
        var edv = new DataView(end.buffer);
        edv.setUint32(0, 0x06054b50, true);
        edv.setUint16(8, entries.length, true);
        edv.setUint16(10, entries.length, true);
        edv.setUint32(12, cdSize, true);
        edv.setUint32(16, offset, true);
        var all = locals.concat(centrals);
        all.push(end);
        var total = all.reduce(function (a, p) { return a + p.length; }, 0);
        var out = new Uint8Array(total);
        var pos = 0;
        all.forEach(function (p) { out.set(p, pos); pos += p.length; });
        return new Blob([out], { type: 'application/zip' });
    }

    function textBlob(txt) { return new Blob([txt], { type: 'application/octet-stream' }); }
    function fetchBytes(url) {
        var u = url.replace(/^http:\/\//, 'https://');
        return fetch(u, { credentials: 'include' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
        });
    }
    var AVATAR_URI = null;
    function loadAvatarData() {
        if (!S.avatar || AVATAR_URI) return Promise.resolve();
        return fetchBytes(S.avatar).then(function (buf) {
            return new Promise(function (resolve) {
                var blob = new Blob([buf], { type: 'image/jpeg' });
                var fr = new FileReader();
                fr.onload = function () { AVATAR_URI = fr.result; resolve(); };
                fr.onerror = function () { resolve(); };
                fr.readAsDataURL(blob);
            });
        }).catch(function (e) { console.warn('头像读取失败', e); });
    }
    function downloadBlob(name, blob) {
        try {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 5000);
        } catch (e) { alert('下载失败：' + e.message); }
    }

    function rangeCompact() {
        var ds = [];
        S.posts.forEach(function (p) { if (p.created_at) ds.push(localDateOf(p.created_at)); });
        ds = ds.filter(function (x) { return !!x; }).sort();
        var a = ds[0], c = ds[ds.length - 1];
        if (!a || !c) {
            a = S.fromDate || (S.toDate || '');
            c = S.toDate || S.fromDate || '';
        }
        if (!a && !c) return 'all';
        var f = function (x) { return x ? String(x).replace(/-/g, '') : ''; };
        return f(a) + '-' + f(c);
    }
    function exportFolderName() {
        return UID + '_' + rangeCompact() + '_weibo-export';
    }
    function zipExport() {
        if (!S.posts.length) { setStatus('还没有数据，先开始导出。', true); return; }
        var any = (els.chkZipHtml && els.chkZipHtml.checked) || (els.chkZipJson && els.chkZipJson.checked) || (els.chkZipCsv && els.chkZipCsv.checked);
        if (!any) { setStatus('请至少勾选一种打包格式（HTML / JSON / CSV）。', true); return; }
        var btn = els.dlZip;
        if (btn) btn.disabled = true;
        setStatus('正在准备 ZIP…');
        setTimeout(function () {
            doZipExport().then(function () { if (btn) btn.disabled = false; });
        }, 60);
    }

    async function doZipExport() {
        var btn = els.dlZip;
        var root = exportFolderName();
        var entries = [];
        var selHtml = !!(els.chkZipHtml && els.chkZipHtml.checked);
        var selJson = !!(els.chkZipJson && els.chkZipJson.checked);
        var selCsv = !!(els.chkZipCsv && els.chkZipCsv.checked);
        var useSplit = !!(els.chkSplit && els.chkSplit.checked);
        var perVol = parseInt((els.splitN && els.splitN.value) || '500', 10);
        if (!(perVol >= 5)) perVol = 500;

        await loadAvatarData();

        // 资源
        entries.push({ name: root + '/css/style.css', data: new TextEncoder().encode(exportCssText()) });

        // HTML（可自动分卷；一卷时不加数字）
        if (selHtml) {
            var pages = buildVolumePages(useSplit ? perVol : S.posts.length, true, getThemeSel());
            pages.forEach(function (pg) {
                entries.push({ name: root + '/' + pg.name, data: new TextEncoder().encode(pg.html) });
            });
        }
        if (selJson) entries.push({ name: root + '/messages.json', data: new TextEncoder().encode(buildJSON()) });
        if (selCsv) entries.push({ name: root + '/messages.csv', data: new TextEncoder().encode(buildCSV()) });

        // 媒体
        var files = [];
        var seen = {};
        S.posts.forEach(function (p) {
            (p.mediaFiles || []).forEach(function (f) {
                if (!f.url) return;
                var key = (f.dir || 'photos') + '/' + f.name;
                if (seen[key]) return;
                seen[key] = 1;
                files.push({ url: f.url, path: (f.dir || 'photos') + '/' + f.name });
            });
        });

        var failed = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            setStatus('正在下载媒体 ' + (i + 1) + '/' + files.length + '：' + f.path);
            try {
                var buf = await fetchBytes(f.url);
                entries.push({ name: root + '/' + f.path, data: new Uint8Array(buf) });
            } catch (e) {
                console.warn('媒体下载失败：' + f.url, e);
                failed.push(f.path + '\t' + f.url);
            }
            await sleep(120);
        }
        if (failed.length) {
            entries.push({ name: root + '/media_links.txt', data: new TextEncoder().encode('以下 ' + failed.length + ' 个媒体未能自动下载（微博视频/音乐 CDN 通常不允许网页脚本直接抓取），可复制链接用下载工具保存：\n' + failed.join('\n') + '\n') });
        }
        try {
            var blob = makeZip(entries);
            downloadBlob(root + '.zip', blob);
            var mediaOk = entries.filter(function (en) { return en.name.indexOf(root + '/photos/') === 0 || en.name.indexOf(root + '/video_files/') === 0 || en.name.indexOf(root + '/audio_files/') === 0; }).length;
            setStatus('ZIP 已生成：' + S.posts.length + ' 条 · ' + (selHtml ? 'HTML ' + (buildVolumePages(useSplit ? perVol : S.posts.length, true, getThemeSel()).length) + ' 卷 · ' : '') + '媒体 ' + mediaOk + ' 个' + (failed.length ? ' · ' + failed.length + ' 个未下载（见 media_links.txt）' : '') + '。');
        } catch (e) {
            setStatus('打包失败：' + e.message, true);
        }
    }

    // ============ UI ============
    GM_addStyle(`
        #wbe-launcher {
            position: fixed; left: 18px; bottom: 90px; z-index: 2147483000;
            padding: 10px 14px; border: none; border-radius: 999px; cursor: pointer;
            background: #2d6cdf; color: #fff; font-size: 14px; font-weight: 600;
            box-shadow: 0 4px 14px rgba(0,0,0,.25);
        }
        #wbe-overlay {
            position: fixed; inset: 0; z-index: 2147483100; display: none;
            background: rgba(20,20,20,.5); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        #wbe-overlay.wbe-open { display: flex; align-items: center; justify-content: center; }
        #wbe-panel {
            position: relative; display: flex; flex-direction: column; width: min(620px, 94vw);
            background: #fff; border-radius: 14px; box-shadow: 0 12px 50px rgba(0,0,0,.35);
            overflow: hidden; max-height: 90vh;
        }
        #wbe-head { display:flex; align-items:center; gap:10px; padding: 14px 18px; border-bottom: 1px solid #eee; }
        #wbe-head .t { font-size: 16px; font-weight: 600; }
        #wbe-head .s { font-size: 12px; color: #999; margin-top: 2px; }
        #wbe-close { margin-left: auto; border:none; background:transparent; font-size:22px; color:#888; cursor:pointer; }
        #wbe-body { padding: 14px 18px; }
        .wbe-row { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:13px; flex-wrap:wrap; }
        .wbe-row label { color:#555; }
        #wbe-body input[type=number], #wbe-body input[type=text] {
            width: 80px; padding: 5px 6px; border:1px solid #d9d9d9; border-radius:6px; font-size:13px;
        }
        .wbe-btns { display:flex; gap:8px; flex-wrap:wrap; margin: 4px 0 10px; }
        .wbe-btns button, #wbe-dl button {
            border:1px solid #d9d9d9; background:#fff; border-radius:6px; padding:7px 12px; font-size:13px; cursor:pointer;
        }
        .wbe-btns button:hover:not(:disabled) { border-color:#2d6cdf; color:#2d6cdf; }
        .wbe-btns button:disabled { opacity:.45; cursor:not-allowed; }
        #wbe-start { background:#2d6cdf; border-color:#2d6cdf; color:#fff; }
        #wbe-start:hover:not(:disabled) { background:#1f5cc7; color:#fff; }
        #wbe-status { padding:8px 18px; font-size:12px; color:#777; border-top:1px solid #f0f0f0; background:#fafafa; min-height:34px; box-sizing:border-box; }
        #wbe-status.wbe-err { color:#d33; }
        #wbe-dl { padding: 10px 18px 14px; border-top: 1px solid #eee; }
        #wbe-dl .hint { font-size:12px; color:#999; margin-bottom:8px; }
        #wbe-overlay.wbe-dark #wbe-panel { background:#1e1e22; color:#e8e8ea; }
        #wbe-overlay.wbe-dark #wbe-head { border-bottom-color:#2a2a2f; }
        #wbe-overlay.wbe-dark #wbe-head .s, #wbe-overlay.wbe-dark .wbe-row label, #wbe-overlay.wbe-dark .hint { color:#9a9aa0; }
        #wbe-overlay.wbe-dark #wbe-body input { background:#26262b; border-color:#3a3a40; color:#e8e8ea; }
        #wbe-overlay.wbe-dark .wbe-btns button, #wbe-overlay.wbe-dark #wbe-dl button { background:#26262b; border-color:#3a3a40; color:#d6d6da; }
        #wbe-overlay.wbe-dark #wbe-status { background:#17171a; color:#aaa; border-top-color:#2a2a2f; }
        #wbe-overlay.wbe-dark #wbe-dl { border-top-color:#2a2a2f; }
        #wbe-overlay.wbe-dark #wbe-close { color:#7a7a80; }
        .wbe-types { display:flex; flex-wrap:wrap; gap:4px 2px; }
        .wbe-types .chk { display:inline-flex; align-items:center; gap:4px; margin-right:14px; font-size:13px; color:#333; cursor:pointer; }
        .wbe-types .chk input { width:auto; margin:0; }
        #wbe-overlay.wbe-dark .wbe-types .chk { color:#d6d6da; }
        #wbe-body input[type=date] { width:138px; }
    `);

    function buildUI() {
        var launcher = document.createElement('button');
        launcher.id = 'wbe-launcher';
        launcher.textContent = '导出历史';
        launcher.addEventListener('click', openPanel);
        document.body.appendChild(launcher);

        var ov = document.createElement('div');
        ov.id = 'wbe-overlay';
        ov.innerHTML =
            '<div id="wbe-panel">' +
            '  <div id="wbe-head"><div><div class="t">微博主页历史导出器</div><div class="s">uid: ' + UID + '</div></div><button id="wbe-close" title="关闭">×</button></div>' +
            '  <div id="wbe-body">' +
            '    <div class="wbe-row"><label>日期范围</label><input id="wbe-from" type="date" title="开始日期（含），留空=最早"/> ～ <input id="wbe-to" type="date" title="结束日期（含），留空=今天"/><label style="margin-left:10px">间隔ms</label><input id="wbe-delay" type="number" min="350" max="4000" step="50" value="700"/></div>' +
            '    <div class="wbe-row"><label>外观</label><div class="wbe-types">' +
            '      <label class="chk"><input type="radio" name="wbe-theme" value="auto" checked/>跟随系统</label>' +
            '      <label class="chk"><input type="radio" name="wbe-theme" value="light"/>日间</label>' +
            '      <label class="chk"><input type="radio" name="wbe-theme" value="dark"/>夜间</label>' +
            '    </div></div>' +
            '    <div class="wbe-row"><label style="align-self:flex-start;padding-top:3px;">动态类型</label><div class="wbe-types">' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-orig" checked/>原创</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-rt" checked/>转发</label>' +
            '    </div></div>' +
            '    <div class="wbe-row"><label style="align-self:flex-start;padding-top:3px;">媒体内容</label><div class="wbe-types">' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-text" checked/>纯文字</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-pic" checked/>含图片</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-video" checked/>含视频</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-t-music" checked/>含音乐</label>' +
            '    </div></div>' +
            '    <div class="wbe-btns">' +
            '      <button id="wbe-start">开始导出</button>' +
            '      <button id="wbe-pause">暂停</button>' +
            '      <button id="wbe-resume">继续</button>' +
            '      <button id="wbe-stop">停止</button>' +
            '    </div>' +
            '    <div id="wbe-progress" style="font-size:13px;color:#2d6cdf;margin-bottom:6px;"></div>' +
            '  </div>' +
            '  <div id="wbe-status">就绪。选好日期范围与内容类型后点「开始」；日期留空表示不限（到最早 / 今天）。数据先存在内存，可随时下载已抓部分。</div>' +
            '  <div id="wbe-dl"><div class="hint">下载当前已抓取的结果：</div><div class="wbe-btns" style="margin:0">' +
            '    <button id="wbe-dl-json">下载 JSON</button>' +
            '    <button id="wbe-dl-csv">下载 CSV</button>' +
            '    <button id="wbe-dl-html">下载 HTML</button>' +
            '    <button id="wbe-dl-zip">打包 ZIP（含媒体）</button>' +
            '  </div>' +
            '    <div class="wbe-row" style="margin:10px 0 2px"><label>ZIP 包含</label><div class="wbe-types">' +
            '      <label class="chk"><input type="checkbox" id="wbe-z-html" checked/>HTML</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-z-json" checked/>JSON</label>' +
            '      <label class="chk"><input type="checkbox" id="wbe-z-csv" checked/>CSV</label>' +
            '    </div></div>' +
            '    <div class="wbe-row"><label>分卷</label><div class="wbe-types">' +
            '      <label class="chk"><input type="checkbox" id="wbe-split" checked/>自动分卷</label>' +
            '      <label class="chk">每卷约 <input id="wbe-split-n" type="number" min="5" max="5000" step="5" value="500" style="width:70px"/> 条</label>' +
            '    </div></div>' +
            '    <div class="hint" style="margin-top:2px">ZIP 会按勾选打包为 messages(+序号)，媒体分入 photos / video_files / audio_files；分卷页首尾有上/下一卷链接。</div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(ov);

        els.launcher = launcher;
        els.overlay = ov;
        els.close = ov.querySelector('#wbe-close');
        els.fromDate = ov.querySelector('#wbe-from');
        els.toDate = ov.querySelector('#wbe-to');
        els.delay = ov.querySelector('#wbe-delay');
        els.chkOrig = ov.querySelector('#wbe-t-orig');
        els.chkRt = ov.querySelector('#wbe-t-rt');
        els.chkText = ov.querySelector('#wbe-t-text');
        els.chkPic = ov.querySelector('#wbe-t-pic');
        els.chkVideo = ov.querySelector('#wbe-t-video');
        els.chkMusic = ov.querySelector('#wbe-t-music');
        els.start = ov.querySelector('#wbe-start');
        els.pause = ov.querySelector('#wbe-pause');
        els.resume = ov.querySelector('#wbe-resume');
        els.stop = ov.querySelector('#wbe-stop');
        els.progress = ov.querySelector('#wbe-progress');
        els.status = ov.querySelector('#wbe-status');
        els.dlJson = ov.querySelector('#wbe-dl-json');
        els.dlCsv = ov.querySelector('#wbe-dl-csv');
        els.dlHtml = ov.querySelector('#wbe-dl-html');

        els.close.addEventListener('click', closePanel);
        ov.addEventListener('click', function (e) { if (e.target === ov) closePanel(); });
        els.start.addEventListener('click', start);
        els.pause.addEventListener('click', pause);
        els.resume.addEventListener('click', resume);
        els.stop.addEventListener('click', stopAndSave);
        var stamp = function () { return '_' + UID + '_' + fmtNow(); };
        els.dlJson.addEventListener('click', function () {
            if (!S.posts.length) { setStatus('还没有数据，先开始导出。', true); return; }
            download('messages' + stamp() + '.json', buildJSON(), 'application/json');
            setStatus('已生成 JSON（' + S.posts.length + ' 条）');
        });
        els.dlCsv.addEventListener('click', function () {
            if (!S.posts.length) { setStatus('还没有数据，先开始导出。', true); return; }
            download('messages' + stamp() + '.csv', buildCSV(), 'text/csv');
            setStatus('已生成 CSV（' + S.posts.length + ' 条，可用 Excel 打开）');
        });
        els.dlHtml.addEventListener('click', function () {
            if (!S.posts.length) { setStatus('还没有数据，先开始导出。', true); return; }
            setStatus('正在读取头像…');
            loadAvatarData().then(function () {
                download('messages' + stamp() + '.html', buildHTML(), 'text/html');
                setStatus('已生成 HTML 归档（' + S.posts.length + ' 条）');
            });
        });

        els.dlZip = ov.querySelector('#wbe-dl-zip');
        els.dlZip.addEventListener('click', zipExport);
        els.chkZipHtml = ov.querySelector('#wbe-z-html');
        els.chkZipJson = ov.querySelector('#wbe-z-json');
        els.chkZipCsv = ov.querySelector('#wbe-z-csv');
        els.chkSplit = ov.querySelector('#wbe-split');
        els.splitN = ov.querySelector('#wbe-split-n');

        // 主题跟随系统
        var applyDark = function () {
            var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            ov.classList.toggle('wbe-dark', dark);
        };
        applyDark();
        if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyDark);

        // 恢复上次进度提示
        var lp = loadProgress();
        if (lp) {
            els.progress.textContent = '上次进度：第 ' + Math.max(0, (lp.nextPage || 1) - 1) + ' 页 · ' + lp.count + ' 条 · 范围 ' + (lp.fromDate || '最早') + ' ~ ' + (lp.toDate || '今天') + '。刷新后内存已清空，请重新点「开始」。';
        }
        updateUI();
    }

    function openPanel() {
        els.overlay.classList.add('wbe-open');
        updateUI();
    }
    function closePanel() { els.overlay.classList.remove('wbe-open'); }

    function keepAlive() {
        setInterval(function () {
            if (!document.getElementById('wbe-launcher') && location.pathname.match(/^\/u\/(\d+)/)) {
                var b = document.createElement('button');
                b.id = 'wbe-launcher';
                b.textContent = '导出历史';
                b.addEventListener('click', openPanel);
                document.body.appendChild(b);
                els.launcher = b;
            }
        }, 3000);
    }

    function init() {
        console.log(TAG, '启动 uid=' + UID);
        buildUI();
        keepAlive();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 调试/自检钩子（可 F12 调用 window.__wbeExport.buildJSON() 等）
    window.__wbeExport = {
        state: S,
        buildJSON: buildJSON,
        buildCSV: buildCSV,
        buildHTML: buildHTML,
        start: start,
        pause: pause,
        resume: resume
    };
})();
